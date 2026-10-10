import {
  etaMinutes,
  haversineKm,
  pointOf,
  roundKm,
} from '../../common/utils/geo.js';
import { LOCATION_FRESH_MS } from '../matching/matching.service.js';

/** A worker's fix older than this is shown as "stale" so the app can say the dot may be out of date. */
export const FIX_STALE_MS = 2 * 60 * 1000;

export type DistanceBasis = 'JOB_COORDINATES' | 'AREA_CENTROID' | null;

export interface Trip {
  location: {
    lat: number;
    lng: number;
    updatedAt: string;
    stale: boolean;
  } | null;
  distanceKm: number | null;
  etaMinutes: number | null;
  /** How exact the job's place is: its own coordinates, only the area's centre, or unknown. */
  distanceBasis: DistanceBasis;
}

/**
 * Where the worker is relative to the job. Nothing here is invented: a distance and an ETA exist only
 * when the worker has a recent real fix AND the job's place has real coordinates. If the customer
 * shared no GPS and the area has no verified centre (Q-18), distance and ETA are null, not guessed.
 */
export function tripOf(input: {
  fix: { lat: number; lng: number; updatedAt: Date } | null;
  job: {
    lat: number | null;
    lng: number | null;
    area: { lat: number | null; lng: number | null };
  };
  now: number;
  avgSpeedKmh: number;
}): Trip {
  const exact = pointOf(input.job.lat, input.job.lng);
  const centre = pointOf(input.job.area.lat, input.job.area.lng);
  const target = exact ?? centre;
  const distanceBasis: DistanceBasis = exact
    ? 'JOB_COORDINATES'
    : centre
      ? 'AREA_CENTROID'
      : null;

  const { fix } = input;
  if (!fix)
    return {
      location: null,
      distanceKm: null,
      etaMinutes: null,
      distanceBasis,
    };

  const age = input.now - fix.updatedAt.getTime();
  const location = {
    lat: fix.lat,
    lng: fix.lng,
    updatedAt: fix.updatedAt.toISOString(),
    stale: age > FIX_STALE_MS,
  };
  if (!target || age > LOCATION_FRESH_MS)
    return { location, distanceKm: null, etaMinutes: null, distanceBasis };

  const km = roundKm(haversineKm(fix, target));
  return {
    location,
    distanceKm: km,
    etaMinutes: etaMinutes(km, input.avgSpeedKmh),
    distanceBasis,
  };
}
