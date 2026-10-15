import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { haversineKm } from '../../common/utils/geo.js';
import { JobStatus, VerificationStatus } from '../../generated/prisma/enums.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { jobBaseInclude, leadPayloadOf } from '../jobs/job-view.service.js';
import {
  coverageOf,
  spotOfJob,
  workerGeoSelect,
} from '../matching/matching.service.js';
import { RealtimeEvent } from '../realtime/events.js';
import { RealtimePublisher } from '../realtime/realtime-publisher.js';
import { LeadDeliveryService } from '../scheduling/lead-delivery.service.js';
import { visibleOfferCounts } from './visible-offers.js';
import {
  WorkersService,
  type LocationChange,
} from '../workers/workers.service.js';

/** Moving at least this far from the place leads were last matched is worth looking again (docs BR-21). */
export const CATCHUP_MIN_MOVE_KM = 0.5;
/** ...and with no movement at all, look again after this long, so a long wait or a finished job is picked up. */
export const CATCHUP_MIN_INTERVAL_MS = 60_000;
/** Open leads weighed per look. Far above one metro's open leads in one trade. */
const CANDIDATE_CAP = 300;
/** How many workers' last-matched places are remembered (per instance). */
const MARK_CAP = 10_000;

export interface MatchMark {
  lat: number;
  lng: number;
  at: number;
}

/**
 * Should leads be matched again for a worker who just reported this position? Yes for a first fix,
 * after a minute, or after moving half a kilometre from where they were last matched. Pure.
 */
export function shouldRematch(
  mark: MatchMark | undefined,
  fix: { lat: number; lng: number },
  now: number,
): boolean {
  if (!mark) return true;
  if (now - mark.at >= CATCHUP_MIN_INTERVAL_MS) return true;
  return haversineKm(mark, fix) >= CATCHUP_MIN_MOVE_KM;
}

/**
 * When a worker's position changes, finds open leads that now reach them and have not been sent to
 * them yet (docs BR-21, BR-22). This is how a worker who finished a job across town starts seeing
 * work near where they ended up. Each lead is sent at most once, by the same delivery guard the
 * new-job fan-out uses, so the two paths can never both push the same lead.
 */
@Injectable()
export class LeadCatchUpService implements OnModuleInit {
  private readonly logger = new Logger(LeadCatchUpService.name);
  /** Where each worker's leads were last matched. Per instance; losing it only means one extra look. */
  private readonly marks = new Map<string, MatchMark>();

  constructor(
    private readonly workers: WorkersService,
    private readonly prisma: PrismaService,
    private readonly deliveries: LeadDeliveryService,
    private readonly publisher: RealtimePublisher,
  ) {}

  onModuleInit(): void {
    this.workers.onLocationFix((change) => this.onFix(change).then(() => {}));
  }

  /** Returns how many new leads were pushed. */
  async onFix(
    change: LocationChange,
    now: number = Date.now(),
  ): Promise<number> {
    if (!shouldRematch(this.marks.get(change.workerId), change, now)) return 0;
    this.remember(change.workerId, {
      lat: change.lat,
      lng: change.lng,
      at: now,
    });

    const worker = await this.prisma.workerProfile.findFirst({
      where: {
        userId: change.workerId,
        verificationStatus: VerificationStatus.VERIFIED,
        isAvailable: true, // switched off: no catch-up pushes either
      },
      select: { ...workerGeoSelect, trades: { select: { categoryId: true } } },
    });
    if (!worker || worker.trades.length === 0) return 0;

    // Light rows first: everything that is open, in this worker's trades, and not yet sent or answered.
    const candidates = await this.prisma.job.findMany({
      where: {
        status: JobStatus.OPEN,
        expiresAt: { gt: new Date(now) },
        targetWorkerId: null,
        customerId: { not: change.workerId },
        categoryId: { in: worker.trades.map((t) => t.categoryId) },
        workerLeads: { none: { workerId: change.workerId } },
      },
      select: {
        id: true,
        lat: true,
        lng: true,
        scheduledFor: true,
        area: { select: { cityId: true, lat: true, lng: true } },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: CANDIDATE_CAP,
    });
    if (candidates.length === CANDIDATE_CAP)
      this.logger.warn(
        `Catch-up for one worker hit its ${CANDIDATE_CAP}-lead cap; some leads may wait for the next look.`,
      );

    const reaching = candidates.flatMap((job) => {
      const c = coverageOf(worker, spotOfJob(job), now);
      return c.covers ? [{ id: job.id, distanceKm: c.distanceKm }] : [];
    });
    if (reaching.length === 0) return 0;

    // Claim before pushing: only leads newly inserted for this worker are sent.
    const claimed = new Set(
      await this.deliveries.claimJobs(
        change.workerId,
        reaching.map((r) => r.id),
      ),
    );
    if (claimed.size === 0) return 0;

    // Up to CANDIDATE_CAP jobs can be claimed at once (a first fix in a busy area): load them without a
    // join-time quote count and count them in one indexed query (see visibleOfferCounts).
    const jobs = await this.prisma.job.findMany({
      where: { id: { in: [...claimed] } },
      include: jobBaseInclude,
    });
    const offerCounts = await visibleOfferCounts(
      this.prisma,
      jobs.map((j) => j.id),
    );
    const distance = new Map(reaching.map((r) => [r.id, r.distanceKm]));
    for (const job of jobs) {
      this.publisher.toUser(change.workerId, RealtimeEvent.LEAD_NEW, {
        ...leadPayloadOf(
          job,
          distance.get(job.id) ?? null,
          false,
          offerCounts.get(job.id) ?? 0,
        ),
        reason: 'LOCATION' as const,
      });
    }
    return jobs.length;
  }

  private remember(workerId: string, mark: MatchMark): void {
    this.marks.delete(workerId); // re-insert at the end so the oldest entry is the first key
    this.marks.set(workerId, mark);
    if (this.marks.size > MARK_CAP) {
      const oldest = this.marks.keys().next().value;
      if (oldest !== undefined) this.marks.delete(oldest);
    }
  }
}
