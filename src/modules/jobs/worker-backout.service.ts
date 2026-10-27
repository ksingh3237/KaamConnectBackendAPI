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
import { resolveReason } from './cancel-reasons.js';
import { recordCancellation, visitFeeOwed } from './cancellation-record.js';
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
 * The assigned worker cancels (decision Q-5; docs/13-cancellation.md). Two stages:
 *
 *  - ASSIGNED (on the way). A broadcast request goes back to OPEN with EVERYTHING the assignment set cleared, so
 *    the worker's calendar slot, the arrival code and the visit-fee bill line are gone. That is unless the reason
 *    says the customer or the address is the problem (not answering, wrong address...): re-broadcasting the same
 *    request would not help, so it is closed. A direct booking (D-3) is always closed.
 *  - ARRIVED (on site, cost not yet approved). Always closed: the customer has seen this worker, so quietly
 *    re-opening would be a surprise. The bill lines stay, and when it is not the worker's doing the visit fee is
 *    recorded as owed to them directly. The worker is released at once (one job on site at a time).
 *
 * Every cancellation is recorded in `job_cancellations`; the customer is told by push and inbox as well as the socket.
 *
 * The once-only lead guard is reset for a re-open, otherwise the covering workers (who were told the lead closed
 * when it was assigned) would never hear that it is open again. Workers who DECLINED the lead, and the worker who
 * just backed out, stay out.
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

    const reason = resolveReason('WORKER', dto.reasonCode, dto.reason);
    const stage = job.status;
    const direct = job.targetWorkerId !== null;
    // Closed (CANCELLED) or re-opened (OPEN)? On site and direct bookings are always closed.
    const closes = stage === JobStatus.ARRIVED || direct || !reason.reopens;
    transition(
      stage === JobStatus.ARRIVED
        ? 'WORKER_CANCEL_ARRIVED'
        : closes
          ? 'WORKER_CANCEL_DIRECT'
          : 'WORKER_CANCEL',
      stage,
    );

    const now = new Date();
    const visitFeeDue = await this.prisma.$transaction(async (tx) => {
      // Conditional update: if the worker has just arrived (or the customer cancelled), refuse.
      const claimed = await tx.job.updateMany({
        where: { id: jobId, workerId, status: stage },
        data: closes
          ? {
              status: JobStatus.CANCELLED,
              cancelledAt: now,
              cancelledBy: CancelledBy.WORKER,
              cancelReason: reason.text,
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

      const feeDue = await visitFeeOwed(tx, jobId, stage, 'WORKER', reason);

      if (!closes) {
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

      await recordCancellation(tx, {
        jobId,
        actorId: workerId,
        actor: 'WORKER',
        workerId,
        stage,
        reason,
        reopened: !closes,
        visitFeeDue: feeDue,
      });
      return feeDue;
    });

    const fresh = await this.prisma.job.findUniqueOrThrow({
      where: { id: jobId },
      include: jobInclude,
    });

    // The worker is free again: ask their app for a fresh location (docs BR-21).
    this.events.workerFreed(workerId, jobId);
    this.events.statusChanged(fresh);
    if (direct) this.events.directDeclined(fresh, { push: false }); // cancelledByWorker below is the one notice
    if (!closes) {
      this.events.jobReopened(fresh.customerId, jobId);
      await this.events.leadOpened(fresh);
    }
    this.events.cancelledByWorker(fresh, reason.text, !closes, visitFeeDue);
    return this.views.forWorker(fresh, workerId);
  }
}
