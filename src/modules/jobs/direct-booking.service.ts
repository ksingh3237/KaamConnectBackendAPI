import { Injectable } from '@nestjs/common';
import { AppException } from '../../common/exceptions/app.exception.js';
import { etaMinutes } from '../../common/utils/geo.js';
import { ConfigService } from '@nestjs/config';
import type { EnvVars } from '../../config/env.validation.js';
import {
  BillItemKind,
  CancelledBy,
  JobStatus,
  OfferStatus,
} from '../../generated/prisma/enums.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  coverageOf,
  spotOfJob,
  workerGeoSelect,
} from '../matching/matching.service.js';
import { AvailabilityService } from '../scheduling/availability.service.js';
import { generateArrivalCode } from './arrival-code.js';
import { JobEventsService } from './job-events.service.js';
import {
  JobViewService,
  jobInclude,
  type JobView,
} from './job-view.service.js';
import { transition } from './state/job-state-machine.js';

/** The ETA stored on a direct booking's system offer is kept within the database's 5..240 minute range. */
const clampEta = (minutes: number) => Math.min(240, Math.max(5, minutes));
/** Used when no coordinates are known to estimate travel time. */
const DEFAULT_ETA_MINUTES = 30;

/**
 * The worker's side of "Book Pro" (decision D-3): the customer asked one worker, who must say yes.
 * Accepting records a system offer at the worker's own visiting fee, so a direct job and a quoted
 * job look the same to everything after assignment.
 */
@Injectable()
export class DirectBookingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<EnvVars, true>,
    private readonly events: JobEventsService,
    private readonly views: JobViewService,
    private readonly availability: AvailabilityService,
  ) {}

  async accept(workerId: string, jobId: string): Promise<JobView> {
    const job = await this.findRequestedJob(workerId, jobId);
    transition('ACCEPT_DIRECT', job.status);
    if (job.expiresAt && job.expiresAt.getTime() <= Date.now())
      throw jobNotOpen();

    const worker = await this.prisma.workerProfile.findUniqueOrThrow({
      where: { userId: workerId },
      select: { ...workerGeoSelect, visitingFee: true },
    });
    const visitFee = worker.visitingFee ?? job.category.baseVisitFee;
    const { distanceKm } = coverageOf(worker, spotOfJob(job));
    const eta =
      distanceKm === null
        ? DEFAULT_ETA_MINUTES
        : clampEta(
            etaMinutes(
              distanceKm,
              this.config.get('AVG_SPEED_KMH', { infer: true }),
            ),
          );

    try {
      await this.prisma.$transaction(async (tx) => {
        const now = new Date();
        // The authoritative availability check (BR-16): under a per-worker lock, no clash with any
        // confirmed booking. Fails with 409 SCHEDULE_CONFLICT; the worker can then decline instead.
        const window = await this.availability.reserve(
          tx,
          workerId,
          job,
          eta,
          'worker',
          now,
        );
        const claimed = await tx.job.updateMany({
          where: {
            id: jobId,
            targetWorkerId: workerId,
            status: JobStatus.OPEN,
            expiresAt: { gt: now },
          },
          data: {
            status: JobStatus.ASSIGNED,
            workerId,
            assignedAt: now,
            arrivalCode: generateArrivalCode(),
            bookedStartAt: window.startAt,
            bookedEndAt: window.endAt,
            bookingConfirmedAt: now,
          },
        });
        if (claimed.count !== 1) throw jobNotOpen();

        const offer = await tx.offer.create({
          data: {
            jobId,
            workerId,
            visitFee,
            etaMinutes: eta,
            status: OfferStatus.ACCEPTED,
            acceptedAt: now,
          },
        });
        await tx.job.update({
          where: { id: jobId },
          data: { acceptedOfferId: offer.id },
        });
        await tx.billItem.create({
          data: {
            jobId,
            kind: BillItemKind.VISIT_FEE,
            description: 'Visiting & Inspection Fee',
            amount: visitFee,
          },
        });
      });
    } catch (error) {
      throw this.availability.asConflict(error, 'worker');
    }

    const assigned = await this.prisma.job.findUniqueOrThrow({
      where: { id: jobId },
      include: jobInclude,
    });
    this.events.statusChanged(assigned);
    this.events.bookingConfirmed(assigned);
    return this.views.forWorker(assigned, workerId);
  }

  async decline(workerId: string, jobId: string): Promise<JobView> {
    const job = await this.findRequestedJob(workerId, jobId);
    transition('DECLINE_DIRECT', job.status);

    const claimed = await this.prisma.job.updateMany({
      where: { id: jobId, targetWorkerId: workerId, status: JobStatus.OPEN },
      data: {
        status: JobStatus.CANCELLED,
        cancelledAt: new Date(),
        cancelledBy: CancelledBy.WORKER,
        cancelReason: 'DECLINED',
      },
    });
    if (claimed.count !== 1) throw jobNotOpen();

    const declined = await this.prisma.job.findUniqueOrThrow({
      where: { id: jobId },
      include: jobInclude,
    });
    this.events.directDeclined(declined);
    this.events.statusChanged(declined);
    return this.views.forWorker(declined, workerId);
  }

  /** Only the requested worker can act; anyone else (or an unknown id) gets the same 404. */
  private async findRequestedJob(workerId: string, jobId: string) {
    const job = await this.prisma.job.findFirst({
      where: { id: jobId, targetWorkerId: workerId },
      include: jobInclude,
    });
    if (!job) throw new AppException('NOT_FOUND', 404, 'Job not found');
    return job;
  }
}

const jobNotOpen = () =>
  new AppException('JOB_NOT_OPEN', 409, 'This request is no longer open');
