import { Injectable } from '@nestjs/common';
import { AppException } from '../../common/exceptions/app.exception.js';
import type { Page } from '../../common/utils/cursor.js';
import { pageNewestFirst } from '../../common/utils/keyset.js';
import type { Prisma } from '../../generated/prisma/client.js';
import {
  JobMediaKind,
  JobStatus,
  JobTiming,
  LeadResponse,
} from '../../generated/prisma/enums.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { jobInclude, referenceOf } from '../jobs/job-view.service.js';
import {
  coverageOf,
  spotOfJob,
  workerGeoSelect,
} from '../matching/matching.service.js';
import { MediaPurpose } from '../media/media-rules.js';
import { MediaService } from '../media/media.service.js';
import {
  AvailabilityService,
  toLeadAvailability,
  type LeadAvailability,
} from '../scheduling/availability.service.js';
import type { LeadsQueryDto } from './dto/offer.dto.js';
import { toOfferSummary, type OfferSummary } from './offer-views.js';

const DEFAULT_LIMIT = 20;
/** Newest open jobs of the worker's trades considered per request (launch scale: one metro). */
const CANDIDATE_CAP = 500;

const leadInclude = (workerId: string) =>
  ({
    ...jobInclude,
    // The worker's own quote on each lead (at most one: quotes are unique per job and worker).
    offers: { where: { workerId }, take: 1 },
    // What this worker has already done with the lead (accepted / declined).
    workerLeads: { where: { workerId }, take: 1, select: { response: true } },
  }) satisfies Prisma.JobInclude;

type LeadRow = Prisma.JobGetPayload<{
  include: ReturnType<typeof leadInclude>;
}>;

/** A job as a worker sees it: enough to decide whether to quote. Never the address or a phone number. */
export interface LeadItem {
  id: string;
  reference: string;
  title: string;
  category: { id: string; title: { en: string; hi: string; pa: string } };
  customerName: string;
  areaName: string;
  cityName: string;
  distanceKm: number | null;
  urgency: JobTiming;
  /** The appointment time the customer asked for; null = as soon as possible. */
  scheduledFor: string | null;
  durationMin: number;
  /** Inside the worker's wider "will travel for future work" radius but outside their normal one. */
  extendedReach: boolean;
  /** NEW until the worker accepts or declines the lead (separate from quoting). */
  leadState: 'NEW' | 'ACCEPTED' | 'DECLINED';
  /** Can the worker make this time given their confirmed bookings? A busy worker still sees the lead. */
  availability: LeadAvailability | null;
  postedAt: string;
  hasVoiceNote: boolean;
  notes: string | null;
  offersCount: number;
  /** Shown as the "From ₹…" budget hint (decision Q-4: derived from the category). */
  baseVisitFee: number;
  isDirect: boolean;
  expiresAt: string | null;
  myOffer: OfferSummary | null;
}

export interface LeadDetail extends LeadItem {
  status: JobStatus;
  photoUrls: string[];
  voiceNote: { url: string; durationSec: number | null } | null;
}

@Injectable()
export class LeadsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly media: MediaService,
    private readonly availability: AvailabilityService,
  ) {}

  /** The Leads Radar: open jobs in the worker's trades within their radius, plus requests addressed to them. */
  async feed(workerId: string, query: LeadsQueryDto): Promise<Page<LeadItem>> {
    const worker = await this.loadWorker(workerId);
    const tradeIds = worker.trades.map((t) => t.categoryId);
    const wanted = query.categoryId
      ? tradeIds.filter((id) => id === query.categoryId)
      : tradeIds;
    if (wanted.length === 0) return { items: [], nextCursor: null };

    const rows = await this.prisma.job.findMany({
      where: {
        status: JobStatus.OPEN,
        expiresAt: { gt: new Date() },
        customerId: { not: workerId },
        categoryId: { in: wanted },
        OR: [{ targetWorkerId: null }, { targetWorkerId: workerId }],
        // A lead the worker declined leaves their radar.
        workerLeads: {
          none: { workerId, response: LeadResponse.DECLINED },
        },
        ...(query.filter === 'immediate'
          ? { timing: JobTiming.IMMEDIATE }
          : {}),
        ...(query.filter === 'scheduled'
          ? { scheduledFor: { not: null } }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: CANDIDATE_CAP,
      include: leadInclude(workerId),
    });

    const now = Date.now();
    const visible: {
      row: LeadRow;
      distanceKm: number | null;
      extended: boolean;
    }[] = [];
    for (const row of rows) {
      const c = coverageOf(worker, spotOfJob(row), now);
      // A request addressed to this worker is always shown; broadcast jobs only inside their radius.
      // Being busy with another job never hides a lead (docs BR-1).
      if (row.targetWorkerId === workerId || c.covers)
        visible.push({ row, distanceKm: c.distanceKm, extended: c.extended });
    }
    const slots = await this.availability.slotsOf(workerId);

    const page = pageNewestFirst(
      visible,
      query.limit ?? DEFAULT_LIMIT,
      query.cursor,
      (v) => ({
        at: v.row.createdAt,
        id: v.row.id,
      }),
    );
    return {
      items: page.items.map((v) =>
        this.toItem(v.row, v.distanceKm, v.extended, slots),
      ),
      nextCursor: page.nextCursor,
    };
  }

  /**
   * One lead in full (photos, voice note). Visible only if it is currently a lead for this worker,
   * was addressed to them, or they already quoted on it. Everything else is a plain 404.
   */
  async detail(workerId: string, jobId: string): Promise<LeadDetail> {
    const worker = await this.loadWorker(workerId);
    const row = await this.prisma.job.findUnique({
      where: { id: jobId },
      include: leadInclude(workerId),
    });
    if (!row || row.customerId === workerId) throw notFound();

    const c = coverageOf(worker, spotOfJob(row));
    const mine = row.targetWorkerId === workerId;
    const quoted = row.offers.length > 0;
    const isCurrentLead =
      row.targetWorkerId === null &&
      row.status === JobStatus.OPEN &&
      (row.expiresAt === null || row.expiresAt.getTime() > Date.now()) &&
      worker.trades.some((t) => t.categoryId === row.categoryId) &&
      c.covers;
    if (!mine && !quoted && !isCurrentLead) throw notFound();

    const photos = row.media.filter(
      (m) => m.kind === JobMediaKind.PROBLEM_PHOTO,
    );
    const voice = row.media.find((m) => m.kind === JobMediaKind.VOICE_NOTE);
    return {
      ...this.toItem(
        row,
        c.distanceKm,
        c.extended,
        await this.availability.slotsOf(workerId),
      ),
      status: row.status,
      photoUrls: (
        await Promise.all(
          photos.map((p) =>
            this.media.readUrl(MediaPurpose.JOB_PHOTO, p.storageKey),
          ),
        )
      ).filter((u): u is string => u !== null),
      voiceNote: voice
        ? {
            url: (await this.media.readUrl(
              MediaPurpose.JOB_VOICE,
              voice.storageKey,
            ))!,
            durationSec: voice.durationSec,
          }
        : null,
    };
  }

  private async loadWorker(workerId: string) {
    return this.prisma.workerProfile.findUniqueOrThrow({
      where: { userId: workerId },
      select: { ...workerGeoSelect, trades: { select: { categoryId: true } } },
    });
  }

  private toItem(
    row: LeadRow,
    distanceKm: number | null,
    extended: boolean,
    slots: Parameters<AvailabilityService['assess']>[0],
  ): LeadItem {
    const answer = row.workerLeads[0]?.response ?? null;
    return {
      id: row.id,
      reference: referenceOf(row.jobNumber),
      title: row.title,
      category: {
        id: row.category.id,
        title: {
          en: row.category.titleEn,
          hi: row.category.titleHi,
          pa: row.category.titlePa,
        },
      },
      customerName: row.customer.fullName,
      areaName: row.area.name,
      cityName: row.area.city.name,
      distanceKm,
      urgency: row.timing,
      scheduledFor: row.scheduledFor?.toISOString() ?? null,
      durationMin: row.durationMin,
      extendedReach: extended,
      leadState: answer ?? 'NEW',
      availability:
        row.status === JobStatus.OPEN
          ? toLeadAvailability(this.availability.assess(slots, row, new Date()))
          : null,
      postedAt: row.createdAt.toISOString(),
      hasVoiceNote: row.media.some((m) => m.kind === JobMediaKind.VOICE_NOTE),
      notes: row.description,
      offersCount: row._count.offers,
      baseVisitFee: row.category.baseVisitFee,
      isDirect: row.targetWorkerId !== null,
      expiresAt: row.expiresAt?.toISOString() ?? null,
      myOffer: row.offers[0] ? toOfferSummary(row.offers[0]) : null,
    };
  }
}

const notFound = () => new AppException('NOT_FOUND', 404, 'Lead not found');
