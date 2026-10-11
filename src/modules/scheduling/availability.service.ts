import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { pointOf } from '../../common/utils/geo.js';
import type { EnvVars } from '../../config/env.validation.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { VerificationStatus } from '../../generated/prisma/enums.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  OCCUPYING_STATUSES,
  QUOTE_ETA_CHOICES,
  findConflicts,
  nextFreeAt,
  windowFor,
  type Candidate,
  type Conflict,
  type ConflictReason,
  type SchedulingRules,
  type Slot,
} from './booking-window.js';
import { scheduleConflict, workerUnavailable } from './scheduling.errors.js';

type Db = Prisma.TransactionClient;

/** What the availability rules need to know about a job (a subset of a `jobs` row plus its area). */
export interface JobTimeInput {
  id?: string;
  scheduledFor: Date | null;
  durationMin: number;
  lat: number | null;
  lng: number | null;
  area: { lat: number | null; lng: number | null };
}

export interface Availability {
  free: boolean;
  /**
   * Immediate jobs only: which quote arrival times (15 / 30 / 45 min) the worker could keep.
   * `null` for appointments booked for a fixed time.
   */
  etaOptions: number[] | null;
  /** Why the worker is not free (the first conflict found), or null. */
  reason: ConflictReason | null;
  /** Earliest start that clears the conflicts, or null when free. */
  nextFreeAt: Date | null;
  conflicts: Conflict[];
}

/** How availability is shown to a worker on a lead card (dates as ISO strings). */
export interface LeadAvailability {
  free: boolean;
  /** Immediate jobs: the quote arrival times (minutes) the worker could keep. */
  etaOptions: number[] | null;
  reason: ConflictReason | null;
  nextFreeAt: string | null;
}

export const toLeadAvailability = (a: Availability): LeadAvailability => ({
  free: a.free,
  etaOptions: a.etaOptions,
  reason: a.reason,
  nextFreeAt: a.nextFreeAt?.toISOString() ?? null,
});

export interface BookedWindow {
  startAt: Date;
  endAt: Date;
}

/** PostgreSQL's code for a violated exclusion constraint. */
const EXCLUSION_VIOLATION = '23P01';

/**
 * Answers "is this worker free for this job?" (docs BR-13 to BR-17). The reading methods are cheap
 * and safe to call from anywhere; `reserve` is the authoritative check and must run inside the
 * transaction that confirms the booking.
 */
@Injectable()
export class AvailabilityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<EnvVars, true>,
  ) {}

  rules(): SchedulingRules {
    return {
      avgSpeedKmh: this.config.get('AVG_SPEED_KMH', { infer: true }),
      bufferMin: this.config.get('BOOKING_BUFFER_MIN', { infer: true }),
      defaultTravelMin: this.config.get('BOOKING_DEFAULT_TRAVEL_MIN', {
        infer: true,
      }),
    };
  }

  /** The worker's reserved bookings, earliest first. `exceptJobId` leaves one job out (re-checking it). */
  async slotsOf(
    workerId: string,
    db: Db = this.prisma,
    exceptJobId?: string,
  ): Promise<Slot[]> {
    const rows = await db.job.findMany({
      where: {
        workerId,
        status: { in: [...OCCUPYING_STATUSES] },
        bookedStartAt: { not: null },
        ...(exceptJobId ? { id: { not: exceptJobId } } : {}),
      },
      select: {
        id: true,
        status: true,
        bookedStartAt: true,
        bookedEndAt: true,
        lat: true,
        lng: true,
        area: { select: { lat: true, lng: true } },
      },
      orderBy: { bookedStartAt: 'asc' },
    });
    return rows.flatMap((r) =>
      r.bookedStartAt && r.bookedEndAt
        ? [
            {
              jobId: r.id,
              status: r.status,
              startAt: r.bookedStartAt,
              endAt: r.bookedEndAt,
              point: pointOf(r.lat, r.lng) ?? pointOf(r.area.lat, r.area.lng),
            },
          ]
        : [],
    );
  }

  /**
   * Pure: can a worker with these `slots` take this job? For an immediate job pass `etaMinutes` to
   * test one arrival time, or omit it to test all three quote choices.
   */
  assess(
    slots: readonly Slot[],
    job: JobTimeInput,
    now: Date,
    etaMinutes?: number,
  ): Availability {
    const point =
      pointOf(job.lat, job.lng) ?? pointOf(job.area.lat, job.area.lng);
    const evaluate = (eta: number) => {
      const window = windowFor({
        scheduledFor: job.scheduledFor,
        durationMin: job.durationMin,
        etaMinutes: eta,
        now,
      });
      const candidate: Candidate = { ...window, point };
      return findConflicts(slots, candidate, this.rules(), now);
    };

    if (job.scheduledFor || etaMinutes !== undefined) {
      const conflicts = evaluate(etaMinutes ?? QUOTE_ETA_CHOICES[0]);
      return this.result(conflicts, null);
    }

    const byEta = QUOTE_ETA_CHOICES.map((eta) => ({
      eta,
      conflicts: evaluate(eta),
    }));
    const options = byEta
      .filter((e) => e.conflicts.length === 0)
      .map((e) => e.eta);
    // When nothing works, explain with the latest arrival the worker could have offered.
    const explain = byEta[byEta.length - 1]!.conflicts;
    return options.length > 0
      ? this.result([], options)
      : this.result(explain, []);
  }

  /** Early warning for the worker's own action: refuse a quote or lead acceptance that would double-book them. */
  async assertWorkerCanTake(
    db: Db,
    workerId: string,
    job: JobTimeInput,
    etaMinutes: number | undefined,
    now: Date = new Date(),
  ): Promise<void> {
    const slots = await this.slotsOf(workerId, db, job.id);
    const availability = this.assess(slots, job, now, etaMinutes);
    if (!availability.free) throw scheduleConflict(availability);
  }

  /** Early warning for the customer: refuse to book a worker who is already taken at that time. */
  async assertWorkerFreeForCustomer(
    db: Db,
    workerId: string,
    job: JobTimeInput,
    etaMinutes: number | undefined,
    now: Date = new Date(),
  ): Promise<void> {
    const slots = await this.slotsOf(workerId, db, job.id);
    const availability = this.assess(slots, job, now, etaMinutes);
    if (!availability.free) throw workerUnavailable(availability);
  }

  /**
   * The authoritative check, for the transaction that confirms the booking. Takes a per-worker
   * lock so two confirmations for the same worker run one after the other (on any instance), then
   * re-reads the worker's bookings. Returns the window to store on the job.
   * `side` decides which error the caller sees: the customer's accept or the worker's own accept.
   */
  async reserve(
    tx: Db,
    workerId: string,
    job: JobTimeInput,
    etaMinutes: number,
    side: 'customer' | 'worker',
    now: Date = new Date(),
  ): Promise<BookedWindow> {
    // $executeRaw: pg_advisory_xact_lock returns `void`, which $queryRaw cannot deserialise.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`booking:${workerId}`}))`;

    // Account deletion takes this same lock before it anonymises a worker. A request that waited here while that
    // happened must not hand the job to a worker who is gone, so look again now that nobody else can change them.
    const owner = await tx.workerProfile.findUnique({
      where: { userId: workerId },
      select: {
        verificationStatus: true,
        user: { select: { isActive: true } },
      },
    });
    if (
      owner?.verificationStatus !== VerificationStatus.VERIFIED ||
      !owner.user.isActive
    ) {
      const gone: Availability = {
        free: false,
        etaOptions: null,
        reason: null,
        nextFreeAt: null,
        conflicts: [],
      };
      throw side === 'customer'
        ? workerUnavailable(gone)
        : scheduleConflict(gone);
    }

    const slots = await this.slotsOf(workerId, tx, job.id);
    const availability = this.assess(slots, job, now, etaMinutes);
    if (!availability.free)
      throw side === 'customer'
        ? workerUnavailable(availability)
        : scheduleConflict(availability);

    return windowFor({
      scheduledFor: job.scheduledFor,
      durationMin: job.durationMin,
      etaMinutes,
      now,
    });
  }

  /**
   * The database refused the booking even though the application check passed (a race the lock
   * should prevent, or a bug). Turn it into the same answer the application check gives.
   */
  asConflict(error: unknown, side: 'customer' | 'worker'): unknown {
    if (!isExclusionViolation(error)) return error;
    const none: Availability = {
      free: false,
      etaOptions: null,
      reason: 'OVERLAP',
      nextFreeAt: null,
      conflicts: [],
    };
    return side === 'customer'
      ? workerUnavailable(none)
      : scheduleConflict(none);
  }

  private result(
    conflicts: Conflict[],
    etaOptions: number[] | null,
  ): Availability {
    return {
      free:
        conflicts.length === 0 &&
        (etaOptions === null || etaOptions.length > 0),
      etaOptions,
      reason: conflicts[0]?.reason ?? null,
      nextFreeAt: nextFreeAt(conflicts),
      conflicts,
    };
  }
}

/** Walks the error and its causes looking for PostgreSQL's exclusion-violation code. */
export function isExclusionViolation(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    const e = current as {
      code?: unknown;
      message?: unknown;
      cause?: unknown;
      meta?: unknown;
    };
    if (e.code === EXCLUSION_VIOLATION) return true;
    if (
      typeof e.message === 'string' &&
      (e.message.includes(EXCLUSION_VIOLATION) ||
        e.message.includes('jobs_worker_no_overlap'))
    )
      return true;
    if (e.meta && typeof e.meta === 'object') {
      const text = JSON.stringify(e.meta);
      if (
        text.includes(EXCLUSION_VIOLATION) ||
        text.includes('jobs_worker_no_overlap')
      )
        return true;
    }
    current = e.cause;
  }
  return false;
}
