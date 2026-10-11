import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppException } from '../../common/exceptions/app.exception.js';
import type { EnvVars } from '../../config/env.validation.js';
import { JobStatus, VerificationStatus } from '../../generated/prisma/enums.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { JobEventsService } from '../jobs/job-events.service.js';
import {
  WorkersService,
  type LocationChange,
} from '../workers/workers.service.js';
import { IN_SERVICE_STATUSES, jobNotFound } from './job-access.js';
import { tripOf, type Trip } from './trip.js';

export interface Tracking extends Trip {
  status: JobStatus;
  /** Customer only: who is coming. */
  worker?: {
    id: string;
    name: string;
    trade: string;
    vehicle: string | null;
    phone: string;
    verified: boolean;
  };
  /** Worker only: who they are going to. The address stays in `GET /jobs/:id`. */
  customer?: { name: string };
  /** Customer only, while the worker is on the way or has just arrived. */
  arrivalCode?: string;
}

/**
 * "Where is my worker?" (docs/03-api-spec.md section 2.8). The first screen load is `GET /jobs/:id/tracking`;
 * after that a `job.location` event arrives for each location update the worker sends while on the way.
 */
@Injectable()
export class TrackingService implements OnModuleInit {
  private readonly logger = new Logger(TrackingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<EnvVars, true>,
    private readonly events: JobEventsService,
    private readonly workers: WorkersService,
  ) {}

  onModuleInit(): void {
    this.workers.onLocationFix((change) => this.broadcast(change));
  }

  /** The customer, and the assigned worker. Everyone else gets the same 404 as an unknown job. */
  async get(userId: string, jobId: string): Promise<Tracking> {
    const job = await this.prisma.job.findFirst({
      where: {
        id: jobId,
        OR: [{ customerId: userId }, { workerId: userId }],
      },
      include: {
        area: { select: { lat: true, lng: true } },
        category: { select: { titleEn: true } },
        customer: { select: { fullName: true } },
        worker: {
          select: {
            userId: true,
            fullName: true,
            vehicle: true,
            verificationStatus: true,
            user: { select: { phone: true } },
            location: true,
          },
        },
      },
    });
    if (!job) throw jobNotFound();
    if (!job.worker || !IN_SERVICE_STATUSES.includes(job.status)) {
      throw new AppException(
        'TRACKING_NOT_AVAILABLE',
        409,
        'Tracking is available once a worker is on the job and until the work is done',
      );
    }

    const trip = tripOf({
      fix: job.worker.location,
      job,
      now: Date.now(),
      avgSpeedKmh: this.config.get('AVG_SPEED_KMH', { infer: true }),
    });
    const base = { status: job.status, ...trip };
    if (job.customerId === userId) {
      return {
        ...base,
        worker: {
          id: job.worker.userId,
          name: job.worker.fullName,
          trade: job.category.titleEn,
          vehicle: job.worker.vehicle,
          phone: job.worker.user.phone,
          verified:
            job.worker.verificationStatus === VerificationStatus.VERIFIED,
        },
        ...(job.arrivalCode &&
        (job.status === JobStatus.ASSIGNED || job.status === JobStatus.ARRIVED)
          ? { arrivalCode: job.arrivalCode }
          : {}),
      };
    }
    return { ...base, customer: { name: job.customer.fullName } };
  }

  /** A stored fix arrived: tell whoever is watching a job this worker is on the way to. */
  async broadcast(change: LocationChange): Promise<void> {
    const jobs = await this.prisma.job.findMany({
      where: { workerId: change.workerId, status: JobStatus.ASSIGNED },
      select: {
        id: true,
        lat: true,
        lng: true,
        area: { select: { lat: true, lng: true } },
      },
    });
    if (jobs.length === 0) return;
    const updatedAt = new Date();
    for (const job of jobs) {
      const trip = tripOf({
        fix: { lat: change.lat, lng: change.lng, updatedAt },
        job,
        now: updatedAt.getTime(),
        avgSpeedKmh: this.config.get('AVG_SPEED_KMH', { infer: true }),
      });
      if (!trip.location) continue;
      this.events.jobLocation({
        jobId: job.id,
        lat: trip.location.lat,
        lng: trip.location.lng,
        updatedAt: trip.location.updatedAt,
        distanceKm: trip.distanceKm,
        etaMinutes: trip.etaMinutes,
        distanceBasis: trip.distanceBasis,
      });
    }
  }
}
