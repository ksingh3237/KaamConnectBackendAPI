import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import {
  CancelledBy,
  JobStatus,
  OfferStatus,
} from '../../generated/prisma/enums.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { JobEventsService } from './job-events.service.js';
import { jobInclude } from './job-view.service.js';

/** How many overdue jobs one run handles; the next minute picks up the rest. */
const BATCH = 200;

/**
 * Closes requests nobody answered: broadcast jobs after JOB_OPEN_TTL_HOURS, direct bookings after
 * DIRECT_ACCEPT_TTL_MIN (the deadline is stored on each job as `expires_at`). Safe on several
 * instances: every job is claimed with a conditional update, so exactly one instance wins.
 */
@Injectable()
export class JobExpiryService {
  private readonly logger = new Logger(JobExpiryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: JobEventsService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async scheduled(): Promise<void> {
    try {
      const expired = await this.expireOverdue();
      if (expired > 0)
        this.logger.log(`Expired ${expired} unanswered request(s)`);
    } catch (error) {
      this.logger.error(
        `Expiry run failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async expireOverdue(now: Date = new Date()): Promise<number> {
    const due = await this.prisma.job.findMany({
      where: { status: JobStatus.OPEN, expiresAt: { lt: now } },
      select: { id: true },
      take: BATCH,
    });

    let expired = 0;
    for (const { id } of due) {
      const claimed = await this.prisma.$transaction(async (tx) => {
        const result = await tx.job.updateMany({
          where: { id, status: JobStatus.OPEN, expiresAt: { lt: now } },
          data: {
            status: JobStatus.CANCELLED,
            cancelledAt: now,
            cancelledBy: CancelledBy.SYSTEM,
            cancelReason: 'EXPIRED',
          },
        });
        if (result.count === 1) {
          await tx.offer.updateMany({
            where: { jobId: id, status: OfferStatus.PENDING },
            data: { status: OfferStatus.REJECTED },
          });
        }
        return result.count === 1;
      });
      if (!claimed) continue;

      expired += 1;
      const job = await this.prisma.job.findUniqueOrThrow({
        where: { id },
        include: jobInclude,
      });
      this.events.statusChanged(job);
      if (job.targetWorkerId) this.events.directExpired(job);
      await this.events.leadClosed(job, 'EXPIRED');
    }
    return expired;
  }
}
