import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppException } from '../../common/exceptions/app.exception.js';
import { encodeKeyset, decodeKeyset } from '../../common/utils/keyset.js';
import type { EnvVars } from '../../config/env.validation.js';
import {
  CancelledBy,
  JobMediaKind,
  JobStatus,
  OfferStatus,
  VerificationStatus,
} from '../../generated/prisma/enums.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { CatalogService } from '../catalog/catalog.service.js';
import { MatchingService, spotOfJob } from '../matching/matching.service.js';
import { MediaPurpose } from '../media/media-rules.js';
import { visibleOfferCounts } from '../offers/visible-offers.js';
import { MediaService } from '../media/media.service.js';
import { AvailabilityService } from '../scheduling/availability.service.js';
import { resolveScheduledFor } from '../scheduling/schedule-time.js';
import { resolveReason } from './cancel-reasons.js';
import { recordCancellation, visitFeeOwed } from './cancellation-record.js';
import type {
  CancelJobDto,
  CreateJobDto,
  ListJobsQueryDto,
} from './dto/job.dto.js';
import { JobEventsService } from './job-events.service.js';
import { openUntil, readOpenTtl } from './open-until.js';
import { WorkerBackOutService } from './worker-backout.service.js';
import {
  JobViewService,
  jobInclude,
  referenceOf,
  type JobView,
} from './job-view.service.js';
import {
  canTransition,
  statusesOfTab,
  transition,
  type JobTab,
} from './state/job-state-machine.js';
import { placeName } from '../../common/utils/place.js';

/** Abuse limits (docs/05-security-testing.md): a customer cannot flood the radar. */
export const MAX_OPEN_JOBS = 10;
export const MAX_PENDING_DIRECT = 3;

export interface CreatedJob {
  id: string;
  jobNumber: number;
  reference: string;
  status: JobStatus;
  expiresAt: string;
  /** The appointment time, or null for "as soon as possible". */
  scheduledFor: string | null;
  durationMin: number;
  /** Broadcast jobs: how many verified workers were told ("sent to 24 nearby technicians"). */
  notifiedWorkers?: number;
  /** Direct bookings: the job waits for the requested worker to accept. */
  awaitingWorker?: boolean;
}

export interface JobListItem {
  id: string;
  jobNumber: number;
  reference: string;
  title: string;
  status: JobStatus;
  category: { id: string; title: string };
  area: string;
  city: string;
  createdAt: string;
  offersCount: number;
  isDirect: boolean;
  /** The appointment time, or null for "as soon as possible". */
  scheduledFor: string | null;
  /** The reserved window once the booking is confirmed. */
  bookedStartAt: string | null;
  worker: { id: string; name: string; phone: string } | null;
  /** COMPLETED rows only: the rating the customer gave (null if not rated yet) and whether they did. */
  rating?: number | null;
  reviewed?: boolean;
}

export interface JobListPage {
  items: JobListItem[];
  nextCursor: string | null;
  meta: { counts: Record<JobTab, number> };
}

const DEFAULT_LIMIT = 20;

const invalid = (field: string, issue: string) =>
  new AppException('VALIDATION_FAILED', 422, 'Request validation failed', [
    { field, issue },
  ]);

@Injectable()
export class JobsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<EnvVars, true>,
    private readonly catalog: CatalogService,
    private readonly media: MediaService,
    private readonly matching: MatchingService,
    private readonly events: JobEventsService,
    private readonly views: JobViewService,
    private readonly availability: AvailabilityService,
    private readonly backOut: WorkerBackOutService,
  ) {}

  /**
   * "Broadcast Request to Nearby Pros". With `directWorkerId` it is a "Book Pro" request instead: the
   * job is hidden from everyone else and lapses quickly if that worker does not answer (decision D-3).
   */
  async create(
    customerId: string,
    dto: CreateJobDto,
    directWorkerId?: string,
  ): Promise<CreatedJob> {
    await this.catalog.assertCategoriesActive([dto.categoryId], 'categoryId');
    const category = await this.prisma.serviceCategory.findUniqueOrThrow({
      where: { id: dto.categoryId },
      select: { defaultDurationMin: true },
    });
    const where = await this.resolveLocation(customerId, dto);
    await this.validateMedia(customerId, dto);

    const now = new Date();
    const schedule = resolveScheduledFor(
      dto.timing,
      dto.scheduledFor ? new Date(dto.scheduledFor) : undefined,
      now,
      {
        minLeadMin: this.config.get('SCHEDULE_MIN_LEAD_MIN', { infer: true }),
        maxDays: this.config.get('SCHEDULE_MAX_DAYS', { infer: true }),
      },
    );
    if (!schedule.ok) throw invalid('scheduledFor', schedule.issue);
    const scheduledFor = schedule.scheduledFor;
    // The customer's own number wins, then the service's typical length, then the global default.
    const durationMin =
      dto.durationMin ??
      category.defaultDurationMin ??
      this.config.get('BOOKING_DEFAULT_DURATION_MIN', { infer: true });

    const open = await this.prisma.job.count({
      where: { customerId, status: JobStatus.OPEN },
    });
    if (open >= MAX_OPEN_JOBS) {
      throw new AppException(
        'JOB_LIMIT',
        409,
        `You can have at most ${MAX_OPEN_JOBS} open requests at once`,
      );
    }
    if (directWorkerId)
      await this.assertCanBookDirectly(
        customerId,
        directWorkerId,
        dto.categoryId,
        { ...where, scheduledFor, durationMin },
      );

    const expiresAt = this.expiryFor(
      now,
      scheduledFor,
      directWorkerId !== undefined,
    );

    const job = await this.prisma.job.create({
      data: {
        customerId,
        categoryId: dto.categoryId,
        title: dto.title,
        description: dto.description || null,
        timing: dto.timing,
        scheduledFor,
        durationMin,
        areaId: where.areaId,
        addressLine: where.addressLine,
        localityName: where.localityName,
        lat: where.lat,
        lng: where.lng,
        targetWorkerId: directWorkerId ?? null,
        expiresAt,
        media: {
          create: [
            ...(dto.photoKeys ?? []).map((storageKey) => ({
              kind: JobMediaKind.PROBLEM_PHOTO,
              storageKey,
            })),
            ...(dto.voiceNote
              ? [
                  {
                    kind: JobMediaKind.VOICE_NOTE,
                    storageKey: dto.voiceNote.key,
                    durationSec: dto.voiceNote.durationSec,
                  },
                ]
              : []),
          ],
        },
      },
      include: jobInclude,
    });

    const base = {
      id: job.id,
      jobNumber: job.jobNumber,
      reference: referenceOf(job.jobNumber),
      status: job.status,
      expiresAt: expiresAt.toISOString(),
      scheduledFor: scheduledFor?.toISOString() ?? null,
      durationMin,
    };
    if (directWorkerId) {
      await this.events.directRequested(job, directWorkerId);
      return { ...base, awaitingWorker: true };
    }
    return { ...base, notifiedWorkers: await this.events.leadOpened(job) };
  }

  /** Activity screen: Ongoing / Completed / Cancelled, newest first, with the three tab counts. */
  async list(
    customerId: string,
    query: ListJobsQueryDto,
  ): Promise<JobListPage> {
    const tab = query.tab ?? 'ongoing';
    const limit = query.limit ?? DEFAULT_LIMIT;
    const after = query.cursor ? decodeKeyset(query.cursor) : undefined;

    const rows = await this.prisma.job.findMany({
      where: {
        customerId,
        status: { in: statusesOfTab(tab) },
        ...(after
          ? {
              OR: [
                { createdAt: { lt: after.at } },
                { createdAt: after.at, id: { lt: after.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      include: {
        area: { include: { city: true } },
        category: { select: { id: true, titleEn: true } },
        worker: {
          select: {
            userId: true,
            fullName: true,
            user: { select: { phone: true } },
          },
        },
        review: { select: { rating: true } },
      },
    });

    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    // Counted for the page's jobs only (a join-time `_count` here scans every quote: see visibleOfferCounts).
    const offerCounts = await visibleOfferCounts(
      this.prisma,
      page.map((job) => job.id),
    );
    return {
      items: page.map((job) => ({
        id: job.id,
        jobNumber: job.jobNumber,
        reference: referenceOf(job.jobNumber),
        title: job.title,
        status: job.status,
        category: { id: job.category.id, title: job.category.titleEn },
        area: placeName(job.localityName, job.area.name),
        city: job.area.city.name,
        createdAt: job.createdAt.toISOString(),
        offersCount: offerCounts.get(job.id) ?? 0,
        isDirect: job.targetWorkerId !== null,
        scheduledFor: job.scheduledFor?.toISOString() ?? null,
        bookedStartAt: job.bookedStartAt?.toISOString() ?? null,
        ...(job.status === JobStatus.COMPLETED
          ? {
              rating: job.review?.rating ?? null,
              reviewed: job.review !== null,
            }
          : {}),
        worker: job.worker
          ? {
              id: job.worker.userId,
              name: job.worker.fullName,
              phone: job.worker.user.phone,
            }
          : null,
      })),
      nextCursor:
        rows.length > limit && last
          ? encodeKeyset(last.createdAt, last.id)
          : null,
      meta: { counts: await this.counts(customerId) },
    };
  }

  /** The customer, the assigned worker and the requested (direct) worker may look; everyone else gets a 404. */
  async getForUser(userId: string, jobId: string): Promise<JobView> {
    const job = await this.prisma.job.findUnique({
      where: { id: jobId },
      include: jobInclude,
    });
    if (job?.customerId === userId) return this.views.forCustomer(job);
    if (job && (job.workerId === userId || job.targetWorkerId === userId))
      return this.views.forWorker(job, userId);
    throw new AppException('NOT_FOUND', 404, 'Job not found');
  }

  /**
   * One route, two people, decided by who owns the job: the customer cancels (OPEN, ASSIGNED, or ARRIVED, where it
   * means declining the cost); the assigned worker backs out (ASSIGNED, or ARRIVED; decision Q-5 and
   * docs/13-cancellation.md). Anyone else gets what they got before:
   * a 403 if they have no customer profile at all, otherwise the same 404 as an unknown job.
   */
  async cancel(
    userId: string,
    jobId: string,
    dto: CancelJobDto,
  ): Promise<JobView> {
    const party = await this.prisma.job.findUnique({
      where: { id: jobId },
      select: { customerId: true, workerId: true },
    });
    if (party?.customerId === userId)
      return this.cancelAsCustomer(userId, jobId, dto);
    if (party?.workerId === userId)
      return this.backOut.backOut(userId, jobId, dto);

    const customer = await this.prisma.customerProfile.findUnique({
      where: { userId },
      select: { userId: true },
    });
    if (!customer)
      throw new AppException(
        'CUSTOMER_PROFILE_REQUIRED',
        403,
        'Complete your customer profile first',
      );
    throw new AppException('NOT_FOUND', 404, 'Job not found');
  }

  private async cancelAsCustomer(
    customerId: string,
    jobId: string,
    dto: CancelJobDto,
  ): Promise<JobView> {
    const existing = await this.prisma.job.findFirst({
      where: { id: jobId, customerId },
      include: jobInclude,
    });
    if (!existing) throw new AppException('NOT_FOUND', 404, 'Job not found');
    const reason = resolveReason('CUSTOMER', dto.reasonCode, dto.reason);
    const seen = existing.status;
    transition('CUSTOMER_CANCEL', seen); // 409 INVALID_TRANSITION if too late

    const outcome = await this.prisma.$transaction(async (tx) => {
      // Lock the row, so a racing accept or arrival waits for this decision, then read what the job really is NOW.
      const [now] = await tx.$queryRaw<
        { status: JobStatus; worker_id: string | null }[]
      >`SELECT status, worker_id FROM jobs
        WHERE id = ${jobId}::uuid AND customer_id = ${customerId}::uuid FOR UPDATE`;
      // Refuse a job that moved past cancellable, and one where the worker ARRIVED while the customer was looking at
      // an earlier screen: they must see the on-site wording and the visit fee before declining. (A request that was
      // accepted in the meantime is still cancelled, as the customer asked: the stage recorded is the real one.)
      if (
        !now ||
        !canTransition('CUSTOMER_CANCEL', now.status) ||
        (now.status === JobStatus.ARRIVED && seen !== JobStatus.ARRIVED)
      )
        throw new AppException(
          'INVALID_TRANSITION',
          409,
          'This job can no longer be cancelled',
        );
      const stage = now.status;
      const workerId = now.worker_id;

      const claimed = await tx.job.updateMany({
        where: { id: jobId, customerId, status: stage },
        data: {
          status: JobStatus.CANCELLED,
          cancelledAt: new Date(),
          cancelledBy: CancelledBy.CUSTOMER,
          cancelReason: reason.text,
        },
      });
      if (claimed.count !== 1)
        throw new AppException(
          'INVALID_TRANSITION',
          409,
          'This job can no longer be cancelled',
        );
      await tx.offer.updateMany({
        where: { jobId, status: OfferStatus.PENDING },
        data: { status: OfferStatus.REJECTED },
      });
      // Declining the cost after the worker came: they are owed the visit fee, directly (the app moves no money).
      const feeDue = await visitFeeOwed(tx, jobId, stage, 'CUSTOMER', reason);
      await recordCancellation(tx, {
        jobId,
        actorId: customerId,
        actor: 'CUSTOMER',
        workerId,
        stage,
        reason,
        reopened: false,
        visitFeeDue: feeDue,
      });
      return { stage, workerId, visitFeeDue: feeDue };
    });

    const cancelled = await this.prisma.job.findUniqueOrThrow({
      where: { id: jobId },
      include: jobInclude,
    });
    this.events.statusChanged(cancelled);
    if (outcome.stage === JobStatus.OPEN)
      await this.events.leadClosed(cancelled, 'CANCELLED');
    // An assigned worker is free again: ask their app for a fresh location (BR-21).
    if (outcome.stage !== JobStatus.OPEN && outcome.workerId)
      this.events.workerFreed(outcome.workerId, jobId);
    // The worker who was given the job (or asked for it) hears it on their phone, not only if the app is open.
    this.events.cancelledByCustomer(
      cancelled,
      reason.text,
      outcome.visitFeeDue,
    );
    return this.views.forCustomer(cancelled);
  }

  // --- Internals ---

  /**
   * When a request stops accepting answers. A direct request lapses after DIRECT_ACCEPT_TTL_MIN; a
   * request for an exact time keeps collecting quotes for up to SCHEDULED_JOB_OPEN_TTL_HOURS but never
   * past its own appointment; everything else after JOB_OPEN_TTL_HOURS.
   */
  private expiryFor(
    now: Date,
    scheduledFor: Date | null,
    direct: boolean,
  ): Date {
    return openUntil(now, scheduledFor, direct, readOpenTtl(this.config));
  }

  private async counts(customerId: string): Promise<Record<JobTab, number>> {
    const grouped = await this.prisma.job.groupBy({
      by: ['status'],
      where: { customerId },
      _count: { _all: true },
    });
    const counts: Record<JobTab, number> = {
      ongoing: 0,
      completed: 0,
      cancelled: 0,
    };
    for (const row of grouped) {
      const tab: JobTab =
        row.status === JobStatus.COMPLETED
          ? 'completed'
          : row.status === JobStatus.CANCELLED
            ? 'cancelled'
            : 'ongoing';
      counts[tab] += row._count._all;
    }
    return counts;
  }

  /** A saved address or a one-off one; either way the text is copied onto the job (a snapshot). */
  private async resolveLocation(customerId: string, dto: CreateJobDto) {
    if ((dto.addressId === undefined) === (dto.address === undefined)) {
      throw invalid(
        'addressId',
        'send either addressId or address, not both and not neither',
      );
    }
    if (dto.addressId) {
      const saved = await this.prisma.address.findFirst({
        where: { id: dto.addressId, customerId },
      });
      if (!saved) throw invalid('addressId', 'unknown address');
      return {
        areaId: saved.areaId,
        addressLine: saved.line,
        localityName: saved.localityName,
        lat: saved.lat,
        lng: saved.lng,
      };
    }
    const a = dto.address!;
    await this.catalog.assertAreaExists(a.areaId, 'address.areaId');
    return {
      areaId: a.areaId,
      addressLine: a.line,
      localityName: a.localityName || null,
      lat: a.lat ?? null,
      lng: a.lng ?? null,
    };
  }

  private async validateMedia(
    customerId: string,
    dto: CreateJobDto,
  ): Promise<void> {
    for (const [i, key] of (dto.photoKeys ?? []).entries()) {
      await this.media.assertOwnedUpload(
        customerId,
        MediaPurpose.JOB_PHOTO,
        key,
        `photoKeys.${i}`,
      );
    }
    if (dto.voiceNote) {
      await this.media.assertOwnedUpload(
        customerId,
        MediaPurpose.JOB_VOICE,
        dto.voiceNote.key,
        'voiceNote.key',
      );
    }
  }

  private async assertCanBookDirectly(
    customerId: string,
    workerId: string,
    categoryId: string,
    where: {
      areaId: number;
      lat: number | null;
      lng: number | null;
      scheduledFor: Date | null;
      durationMin: number;
    },
  ): Promise<void> {
    if (workerId === customerId)
      throw invalid('workerId', 'you cannot book yourself');

    const worker = await this.prisma.workerProfile.findFirst({
      where: {
        userId: workerId,
        verificationStatus: VerificationStatus.VERIFIED,
        trades: { some: { categoryId } },
      },
      select: { userId: true, isAvailable: true },
    });
    if (!worker)
      throw invalid(
        'workerId',
        'this worker is not available for this service',
      );
    if (!worker.isAvailable)
      throw new AppException(
        'WORKER_OFFLINE',
        409,
        'This worker is not taking jobs right now. Post your job to reach other nearby workers.',
      );

    const area = await this.prisma.area.findUniqueOrThrow({
      where: { id: where.areaId },
    });
    const coverage = await this.matching.coverageForWorker(
      workerId,
      spotOfJob({
        lat: where.lat,
        lng: where.lng,
        scheduledFor: where.scheduledFor,
        area,
      }),
    );
    if (!coverage?.covers)
      throw invalid('workerId', 'this worker does not serve your location');

    // A worker who is already booked (or cannot make the time) cannot be asked for it (BR-16).
    await this.availability.assertWorkerFreeForCustomer(
      this.prisma,
      workerId,
      {
        scheduledFor: where.scheduledFor,
        durationMin: where.durationMin,
        lat: where.lat,
        lng: where.lng,
        area,
      },
      undefined,
    );

    const pending = await this.prisma.job.count({
      where: {
        customerId,
        status: JobStatus.OPEN,
        targetWorkerId: { not: null },
      },
    });
    if (pending >= MAX_PENDING_DIRECT) {
      throw new AppException(
        'DIRECT_LIMIT',
        409,
        `You can have at most ${MAX_PENDING_DIRECT} pending worker requests`,
      );
    }
  }
}
