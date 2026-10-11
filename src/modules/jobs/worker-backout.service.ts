import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppException } from '../../common/exceptions/app.exception.js';
import type { EnvVars } from '../../config/env.validation.js';
import {
  CancelledBy,
  JobStatus,
  LeadResponse,
  OfferStatus,
} from '../../generated/prisma/enums.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { LeadDeliveryService } from '../scheduling/lead-delivery.service.js';
import type { CancelJobDto } from './dto/job.dto.js';
import { JobEventsService } from './job-events.service.js';
import {
  JobViewService,
  jobInclude,
  type JobView,
} from './job-view.service.js';
import { openUntil, readOpenTtl } from './open-until.js';
import { transition } from './state/job-state-machine.js';

/**
 * The assigned worker backs out before arriving (decision Q-5, docs/07-roadmap.md "Phase 5 must").
 *
 *  - A broadcast request goes back to OPEN with EVERYTHING the assignment set cleared, so the worker's
 *    calendar slot, the arrival code and the visit-fee bill line are gone.
 *  - A direct booking (D-3) is simply cancelled; its window stays for history but no longer blocks anyone
 *    because the database only counts ASSIGNED / ARRIVED / IN_PROGRESS jobs.
 *  - The once-only lead guard is reset for the re-open, otherwise the covering workers (who were told the
 *    lead closed when it was assigned) would never hear that it is open again. Workers who DECLINED the
 *    lead, and the worker who just backed out, stay out.
 */
@Injectable()
export class WorkerBackOutService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<EnvVars, true>,
    private readonly events: JobEventsService,
    private readonly views: JobViewService,
    private readonly deliveries: LeadDeliveryService,
  ) {}

  async backOut(
    workerId: string,
    jobId: string,
    dto: CancelJobDto,
  ): Promise<JobView> {
    const job = await this.prisma.job.findFirst({
      where: { id: jobId, workerId },
      include: jobInclude,
    });
    if (!job) throw new AppException('NOT_FOUND', 404, 'Job not found');

    const direct = job.targetWorkerId !== null;
    transition(direct ? 'WORKER_CANCEL_DIRECT' : 'WORKER_CANCEL', job.status);

    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      // Conditional update: if the worker has just arrived (or the customer cancelled), refuse.
      const claimed = await tx.job.updateMany({
        where: { id: jobId, workerId, status: JobStatus.ASSIGNED },
        data: direct
          ? {
              status: JobStatus.CANCELLED,
              cancelledAt: now,
              cancelledBy: CancelledBy.WORKER,
              cancelReason: dto.reason || 'BACKED_OUT',
            }
          : {
              status: JobStatus.OPEN,
              workerId: null,
              acceptedOfferId: null,
              assignedAt: null,
              arrivalCode: null,
              arrivalAttempts: 0,
              arrivalCodeResets: 0,
              arrivalCodeResetAt: null,
              bookedStartAt: null,
              bookedEndAt: null,
              bookingConfirmedAt: null,
              expiresAt: openUntil(
                now,
                job.scheduledFor,
                false,
                readOpenTtl(this.config),
              ),
            },
      });
      if (claimed.count !== 1) {
        throw new AppException(
          'INVALID_TRANSITION',
          409,
          'This job can no longer be cancelled',
        );
      }

      // The quote is no longer accepted. `accepted_at` is kept: together with WITHDRAWN it is how the
      // quote rules recognise "this worker backed out" and refuse a second quote.
      await tx.offer.updateMany({
        where: { jobId, workerId, status: OfferStatus.ACCEPTED },
        data: { status: OfferStatus.WITHDRAWN },
      });

      if (!direct) {
        await tx.billItem.deleteMany({ where: { jobId } });
        await tx.workerLead.deleteMany({
          where: {
            jobId,
            OR: [{ response: null }, { response: LeadResponse.ACCEPTED }],
          },
        });
        await this.deliveries.respond(
          jobId,
          workerId,
          LeadResponse.DECLINED,
          tx,
        );
      }
    });

    const fresh = await this.prisma.job.findUniqueOrThrow({
      where: { id: jobId },
      include: jobInclude,
    });

    // The worker is free again: ask their app for a fresh location (docs BR-21).
    this.events.workerFreed(workerId, jobId);
    if (direct) {
      this.events.statusChanged(fresh);
      this.events.directDeclined(fresh);
    } else {
      this.events.statusChanged(fresh);
      this.events.jobReopened(fresh.customerId, jobId);
      await this.events.leadOpened(fresh);
    }
    return this.views.forWorker(fresh, workerId);
  }
}
