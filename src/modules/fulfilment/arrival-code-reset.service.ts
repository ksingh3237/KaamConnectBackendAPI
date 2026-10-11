import { Injectable, Logger } from '@nestjs/common';
import { AppException } from '../../common/exceptions/app.exception.js';
import {
  JobSecurityEventType,
  JobStatus,
} from '../../generated/prisma/enums.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  ARRIVAL_CODE_RESET_COOLDOWN_SEC,
  MAX_ARRIVAL_CODE_RESETS,
  generateArrivalCode,
} from '../jobs/arrival-code.js';
import { JobEventsService } from '../jobs/job-events.service.js';
import {
  JobViewService,
  jobInclude,
  type JobView,
} from '../jobs/job-view.service.js';
import { jobNotFound } from './job-access.js';

export { ARRIVAL_CODE_RESET_COOLDOWN_SEC, MAX_ARRIVAL_CODE_RESETS };
/** At most one "refused" audit row per job in this window, so hammering the route cannot flood the table. */
const REFUSED_AUDIT_WINDOW_SEC = 60;

/** Why a reset was refused. Pure, so the rule is unit-tested without a database. */
export function resetRefusal(
  job: { arrivalCodeResets: number; arrivalCodeResetAt: Date | null },
  now: Date,
): { reason: 'LIMIT' } | { reason: 'COOLDOWN'; retryAfterSec: number } | null {
  if (job.arrivalCodeResets >= MAX_ARRIVAL_CODE_RESETS)
    return { reason: 'LIMIT' };
  if (job.arrivalCodeResetAt) {
    const waitedSec = (now.getTime() - job.arrivalCodeResetAt.getTime()) / 1000;
    if (waitedSec < ARRIVAL_CODE_RESET_COOLDOWN_SEC)
      return {
        reason: 'COOLDOWN',
        retryAfterSec: Math.ceil(ARRIVAL_CODE_RESET_COOLDOWN_SEC - waitedSec),
      };
  }
  return null;
}

/**
 * The customer asks for a NEW arrival code while the worker is on the way (job ASSIGNED).
 *
 * - Only the customer who owns the job can do it; anyone else gets the same 404 as an unknown job.
 * - The change is ONE conditional UPDATE that checks owner, status, the cap and the cooldown itself, so
 *   two simultaneous taps (or a reset racing a worker's guess) cannot both succeed or exceed the cap.
 * - The new code is random and different from the old one, the wrong-try counter goes back to zero, and
 *   the old code stops working immediately.
 * - The audit row is written in the same transaction as the change. Code values are never recorded.
 *
 * What this means for guessing: a worker gets 5 tries per code, and a customer can issue at most 3 new
 * codes, so one assignment allows at most 5 x 4 = 20 guesses out of 10,000 (0.2%).
 */
@Injectable()
export class ArrivalCodeResetService {
  private readonly logger = new Logger(ArrivalCodeResetService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: JobEventsService,
    private readonly views: JobViewService,
  ) {}

  async reset(
    customerId: string,
    jobId: string,
    ip: string | undefined,
  ): Promise<JobView> {
    // A new code equal to the old one would make "reset" a no-op, so insist on a different one. The
    // chance of a repeat is 1 in 10,000 per draw; three draws make a failure practically impossible.
    for (let draw = 0; draw < 3; draw++) {
      const changed = await this.tryReset(customerId, jobId, ip);
      if (changed) {
        const job = await this.prisma.job.findUniqueOrThrow({
          where: { id: jobId },
          include: jobInclude,
        });
        if (job.workerId) this.events.arrivalCodeReset(job.workerId, job.id);
        return this.views.forCustomer(job);
      }
      // Not changed: throws unless the only problem was a repeated random code, then we draw again.
      await this.explainRefusal(customerId, jobId, ip);
    }
    throw new AppException(
      'RESET_FAILED',
      503,
      'Could not issue a new code just now, please try again',
    );
  }

  /** One attempt: true when a new code was issued. */
  private async tryReset(
    customerId: string,
    jobId: string,
    ip: string | undefined,
  ): Promise<boolean> {
    const code = generateArrivalCode();
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ id: string }[]>`
        UPDATE jobs
        SET arrival_code = ${code}, arrival_attempts = 0,
            arrival_code_resets = arrival_code_resets + 1,
            arrival_code_reset_at = now(), updated_at = now()
        WHERE id = ${jobId}::uuid AND customer_id = ${customerId}::uuid
          AND status = 'ASSIGNED'
          AND arrival_code_resets < ${MAX_ARRIVAL_CODE_RESETS}
          AND (arrival_code_reset_at IS NULL
               OR arrival_code_reset_at <= now() - make_interval(secs => ${ARRIVAL_CODE_RESET_COOLDOWN_SEC}))
          AND arrival_code IS DISTINCT FROM ${code}
        RETURNING id`;
      if (rows.length !== 1) return false;
      await tx.jobSecurityEvent.create({
        data: {
          jobId,
          actorId: customerId,
          type: JobSecurityEventType.ARRIVAL_CODE_RESET,
          ip: ip ?? null,
        },
      });
      return true;
    });
  }

  /**
   * The conditional update changed nothing. Explain why: 404 (not yours), 409 (wrong state), 429 (cap or
   * cooldown). Returns normally only in the one innocent case, a repeated random code.
   */
  private async explainRefusal(
    customerId: string,
    jobId: string,
    ip: string | undefined,
  ): Promise<void> {
    const job = await this.prisma.job.findFirst({
      where: { id: jobId, customerId },
      select: {
        status: true,
        arrivalCodeResets: true,
        arrivalCodeResetAt: true,
      },
    });
    if (!job) throw jobNotFound();
    if (job.status !== JobStatus.ASSIGNED) {
      throw new AppException(
        'INVALID_TRANSITION',
        409,
        'A new code can only be issued while the worker is on the way',
      );
    }
    const refusal = resetRefusal(job, new Date());
    if (!refusal) return; // a repeated random code: the caller draws again

    await this.auditRefusal(customerId, jobId, refusal.reason, ip);
    if (refusal.reason === 'LIMIT') {
      throw new AppException(
        'RESET_LIMIT',
        429,
        `A new code has already been issued ${MAX_ARRIVAL_CODE_RESETS} times for this job. Cancel the job, or ask the worker to back out.`,
      );
    }
    throw new AppException(
      'RESET_COOLDOWN',
      429,
      `A new code was issued a moment ago. Try again in ${refusal.retryAfterSec} seconds.`,
      [{ field: 'retryAfterSec', issue: String(refusal.retryAfterSec) }],
    );
  }

  private async auditRefusal(
    customerId: string,
    jobId: string,
    reason: 'LIMIT' | 'COOLDOWN',
    ip: string | undefined,
  ): Promise<void> {
    try {
      const since = new Date(Date.now() - REFUSED_AUDIT_WINDOW_SEC * 1000);
      const recent = await this.prisma.jobSecurityEvent.findFirst({
        where: {
          jobId,
          actorId: customerId,
          type: JobSecurityEventType.ARRIVAL_RESET_REFUSED,
          createdAt: { gte: since },
        },
        select: { id: true },
      });
      if (recent) return;
      await this.prisma.jobSecurityEvent.create({
        data: {
          jobId,
          actorId: customerId,
          type: JobSecurityEventType.ARRIVAL_RESET_REFUSED,
          detail: reason,
          ip: ip ?? null,
        },
      });
    } catch (error) {
      // The refusal itself must still reach the caller; a failed audit write is logged loudly instead.
      this.logger.error(
        `could not record refused arrival-code reset for job ${jobId}: ${String(error)}`,
      );
    }
  }
}
