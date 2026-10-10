import { timingSafeEqual } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { AppException } from '../../common/exceptions/app.exception.js';
import { violatesConstraint } from '../../common/utils/db-errors.js';
import { JobStatus } from '../../generated/prisma/enums.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { JobEventsService } from '../jobs/job-events.service.js';
import {
  JobViewService,
  jobInclude,
  type JobView,
} from '../jobs/job-view.service.js';
import { transition } from '../jobs/state/job-state-machine.js';
import { jobNotFound } from './job-access.js';

/** Five wrong tries lock the code for that assignment (docs/05-security-testing.md "Arrival code"). */
export const MAX_ARRIVAL_ATTEMPTS = 5;

const codeLocked = () =>
  new AppException(
    'CODE_LOCKED',
    429,
    'Too many wrong codes. Ask the customer to cancel, or back out of this job.',
  );
const workerBusy = () =>
  new AppException(
    'WORKER_BUSY',
    409,
    'You are already working on another job. Finish it before arriving at this one.',
  );

/**
 * "Enter the customer's code" -> ARRIVED. Only the assigned worker can try; the code is never shown to
 * them. Attempts are counted in one atomic statement, so two parallel guesses cannot both slip through
 * under the limit.
 */
@Injectable()
export class ArrivalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: JobEventsService,
    private readonly views: JobViewService,
  ) {}

  async arrive(
    workerId: string,
    jobId: string,
    code: string,
  ): Promise<JobView> {
    const job = await this.prisma.job.findFirst({
      where: { id: jobId, workerId },
      select: { status: true, arrivalAttempts: true },
    });
    if (!job) throw jobNotFound();
    transition('VERIFY_ARRIVAL', job.status); // 409 unless ASSIGNED
    if (job.arrivalAttempts >= MAX_ARRIVAL_ATTEMPTS) throw codeLocked();

    // One job on site at a time. The database enforces it too; this gives the friendly answer first.
    const busy = await this.prisma.job.findFirst({
      where: {
        workerId,
        id: { not: jobId },
        status: { in: [JobStatus.ARRIVED, JobStatus.IN_PROGRESS] },
      },
      select: { id: true },
    });
    if (busy) throw workerBusy();

    // Count this try and read the real code in the same statement.
    const rows = await this.prisma.$queryRaw<
      { arrival_code: string | null; arrival_attempts: number }[]
    >`
      UPDATE jobs SET arrival_attempts = arrival_attempts + 1, updated_at = now()
      WHERE id = ${jobId}::uuid AND worker_id = ${workerId}::uuid
        AND status = 'ASSIGNED' AND arrival_attempts < ${MAX_ARRIVAL_ATTEMPTS}
      RETURNING arrival_code, arrival_attempts`;
    const attempt = rows[0];
    if (!attempt) {
      // Lost a race: locked, backed out, cancelled or already arrived in the meantime.
      const now = await this.prisma.job.findFirst({
        where: { id: jobId, workerId },
        select: { status: true, arrivalAttempts: true },
      });
      if (!now) throw jobNotFound();
      if (now.status === JobStatus.ASSIGNED) throw codeLocked();
      transition('VERIFY_ARRIVAL', now.status);
      throw jobNotFound();
    }

    if (!sameCode(attempt.arrival_code, code)) {
      if (attempt.arrival_attempts >= MAX_ARRIVAL_ATTEMPTS) throw codeLocked();
      const left = MAX_ARRIVAL_ATTEMPTS - attempt.arrival_attempts;
      throw new AppException(
        'ARRIVAL_CODE_INVALID',
        422,
        'That code is not right',
        [
          {
            field: 'code',
            issue: `wrong code, ${left} ${left === 1 ? 'try' : 'tries'} left`,
          },
        ],
      );
    }

    try {
      const claimed = await this.prisma.job.updateMany({
        where: { id: jobId, workerId, status: JobStatus.ASSIGNED },
        data: { status: JobStatus.ARRIVED, arrivedAt: new Date() },
      });
      if (claimed.count !== 1)
        throw new AppException(
          'INVALID_TRANSITION',
          409,
          'This job is no longer waiting for you to arrive',
        );
    } catch (error) {
      if (violatesConstraint(error, 'jobs_one_in_progress_per_worker'))
        throw workerBusy();
      throw error;
    }

    const arrived = await this.prisma.job.findUniqueOrThrow({
      where: { id: jobId },
      include: jobInclude,
    });
    this.events.statusChanged(arrived);
    return this.views.forWorker(arrived, workerId);
  }
}

/** Constant-time comparison; false for a missing code. */
export function sameCode(actual: string | null, given: string): boolean {
  if (!actual) return false;
  const a = Buffer.from(actual);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}
