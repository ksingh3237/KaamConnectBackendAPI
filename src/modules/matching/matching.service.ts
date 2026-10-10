import { Injectable, Logger } from '@nestjs/common';
import { pointOf, type GeoPoint } from '../../common/utils/geo.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { VerificationStatus } from '../../generated/prisma/enums.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { coverage, type Coverage } from './coverage.js';

/** Safety valve: far above launch scale. If ever reached the result is incomplete, so it is logged. */
const WORKER_CAP = 20_000;

/** A live GPS fix older than this is ignored and the worker's base area is used instead. */
export const LOCATION_FRESH_MS = 30 * 60 * 1000;

/**
 * A job starting within this long is judged by where the worker is now; a job starting later is
 * judged by their base area, because their position today says nothing about where they will be
 * (docs BR-19).
 */
export const NEAR_TERM_MS = 2 * 60 * 60 * 1000;

/** The only worker columns the matching rules need. */
export const workerGeoSelect = {
  userId: true,
  radiusKm: true,
  scheduledRadiusKm: true,
  baseArea: { select: { cityId: true, lat: true, lng: true } },
  location: { select: { lat: true, lng: true, updatedAt: true } },
} satisfies Prisma.WorkerProfileSelect;

export type WorkerGeo = Prisma.WorkerProfileGetPayload<{
  select: typeof workerGeoSelect;
}>;

/**
 * Where a job (or a customer browsing workers) is. Coordinates are optional; the city always is.
 * `startsAt` is when the appointment begins; null/absent means "as soon as possible" or "not a job".
 */
export interface Spot {
  point: GeoPoint | null;
  cityId: number;
  startsAt?: Date | null;
}

export interface JobSpotInput {
  lat: number | null;
  lng: number | null;
  scheduledFor?: Date | null;
  area: { cityId: number; lat: number | null; lng: number | null };
}

export interface CoveringWorker {
  workerId: string;
  distanceKm: number | null;
}

/** Exact job coordinates when the customer shared GPS, otherwise the area centroid, otherwise none. */
export function spotOfJob(job: JobSpotInput): Spot {
  return {
    point: pointOf(job.lat, job.lng) ?? pointOf(job.area.lat, job.area.lng),
    cityId: job.area.cityId,
    startsAt: job.scheduledFor ?? null,
  };
}

/** A fresh live fix, otherwise the base area centroid, otherwise none. */
export function workerPointOf(
  worker: WorkerGeo,
  now: number = Date.now(),
): GeoPoint | null {
  const fix = worker.location;
  if (fix && now - fix.updatedAt.getTime() <= LOCATION_FRESH_MS)
    return { lat: fix.lat, lng: fix.lng };
  return pointOf(worker.baseArea.lat, worker.baseArea.lng);
}

/** True when the spot's appointment is far enough ahead that the worker's position today is irrelevant. */
export function isFutureSpot(spot: Spot, now: number = Date.now()): boolean {
  return !!spot.startsAt && spot.startsAt.getTime() - now > NEAR_TERM_MS;
}

/**
 * Near-term or immediate work: the worker's live position and normal radius.
 * Future work: their base area and the wider of their two radii (`scheduledRadiusKm`, BR-19, BR-20).
 */
export function coverageOf(
  worker: WorkerGeo,
  spot: Spot,
  now: number = Date.now(),
): Coverage {
  const future = isFutureSpot(spot, now);
  return coverage({
    workerPoint: future
      ? pointOf(worker.baseArea.lat, worker.baseArea.lng)
      : workerPointOf(worker, now),
    workerCityId: worker.baseArea.cityId,
    radiusKm: future
      ? Math.max(worker.radiusKm, worker.scheduledRadiusKm ?? 0)
      : worker.radiusKm,
    coreRadiusKm: worker.radiusKm,
    spotPoint: spot.point,
    spotCityId: spot.cityId,
  });
}

/**
 * One rule, used everywhere a worker and a place meet: lead feed, "who do I notify", worker
 * discovery. At launch it loads the verified workers of one trade and filters in memory; that is
 * fine for a single metro (hundreds to low thousands). Move it into SQL/PostGIS only when needed.
 */
@Injectable()
export class MatchingService {
  private readonly logger = new Logger(MatchingService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Verified workers offering this trade who serve this spot, excluding the customer themself. */
  async findCoveringWorkers(input: {
    categoryId: string;
    customerId?: string;
    spot: Spot;
  }): Promise<CoveringWorker[]> {
    const workers = await this.prisma.workerProfile.findMany({
      where: {
        verificationStatus: VerificationStatus.VERIFIED,
        trades: { some: { categoryId: input.categoryId } },
        ...(input.customerId ? { userId: { not: input.customerId } } : {}),
      },
      select: workerGeoSelect,
      take: WORKER_CAP,
    });
    if (workers.length === WORKER_CAP) {
      this.logger.warn(
        `findCoveringWorkers hit its ${WORKER_CAP}-worker safety cap; notifications may be incomplete.`,
      );
    }
    const now = Date.now();
    const result: CoveringWorker[] = [];
    for (const worker of workers) {
      const c = coverageOf(worker, input.spot, now);
      if (c.covers)
        result.push({ workerId: worker.userId, distanceKm: c.distanceKm });
    }
    return result;
  }

  /** Coverage of one worker, or null if they are not a verified worker. */
  async coverageForWorker(
    workerId: string,
    spot: Spot,
  ): Promise<Coverage | null> {
    const worker = await this.prisma.workerProfile.findFirst({
      where: {
        userId: workerId,
        verificationStatus: VerificationStatus.VERIFIED,
      },
      select: workerGeoSelect,
    });
    return worker ? coverageOf(worker, spot) : null;
  }
}
