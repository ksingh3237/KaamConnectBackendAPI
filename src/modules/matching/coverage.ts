import { haversineKm, roundKm, type GeoPoint } from '../../common/utils/geo.js';

export interface Coverage {
  covers: boolean;
  /** Straight-line km (one decimal), or null when coordinates were unavailable. */
  distanceKm: number | null;
  /** Covered only because the worker said they will travel farther for future work (BR-20). */
  extended: boolean;
}

/**
 * Does a worker serve a given spot?
 *  - With coordinates on both sides: the radius decides. `radiusKm` is the radius that applies to this
 *    job; `coreRadiusKm` is the worker's normal one, so a spot that is only inside the wider radius is
 *    reported as `extended`.
 *  - Without (area centroids are not filled yet, decision Q-18): fall back to "same city", and
 *    report no distance rather than inventing one.
 */
export function coverage(input: {
  workerPoint: GeoPoint | null;
  workerCityId: number;
  radiusKm: number;
  coreRadiusKm?: number;
  spotPoint: GeoPoint | null;
  spotCityId: number;
}): Coverage {
  if (input.workerPoint && input.spotPoint) {
    const km = haversineKm(input.workerPoint, input.spotPoint);
    const covers = km <= input.radiusKm;
    return {
      covers,
      distanceKm: roundKm(km),
      extended: covers && km > (input.coreRadiusKm ?? input.radiusKm),
    };
  }
  return {
    covers: input.workerCityId === input.spotCityId,
    distanceKm: null,
    extended: false,
  };
}
