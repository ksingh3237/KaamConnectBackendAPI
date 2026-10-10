import {
  LOCATION_FRESH_MS,
  coverageOf,
  spotOfJob,
  workerPointOf,
  type WorkerGeo,
} from './matching.service.js';

const NOW = Date.UTC(2026, 9, 10, 12, 0, 0);
const SECTOR_22 = { lat: 30.7333, lng: 76.7794 };
const PHASE_7 = { lat: 30.711, lng: 76.72 };

const worker = (overrides: Partial<WorkerGeo> = {}): WorkerGeo => ({
  userId: 'w1',
  radiusKm: 6,
  scheduledRadiusKm: null,
  baseArea: { cityId: 1, lat: SECTOR_22.lat, lng: SECTOR_22.lng },
  location: null,
  ...overrides,
});

describe('spotOfJob', () => {
  const area = { cityId: 2, lat: PHASE_7.lat, lng: PHASE_7.lng };

  it('prefers the exact coordinates the customer shared', () => {
    expect(spotOfJob({ lat: 30.7, lng: 76.7, area })).toEqual({
      point: { lat: 30.7, lng: 76.7 },
      cityId: 2,
      startsAt: null,
    });
  });

  it('falls back to the area centroid, then to nothing', () => {
    expect(spotOfJob({ lat: null, lng: null, area })).toEqual({
      point: PHASE_7,
      cityId: 2,
      startsAt: null,
    });
    expect(
      spotOfJob({
        lat: null,
        lng: null,
        area: { cityId: 2, lat: null, lng: null },
      }),
    ).toEqual({
      point: null,
      cityId: 2,
      startsAt: null,
    });
  });
});

describe('workerPointOf', () => {
  it('uses a fresh live fix over the base area', () => {
    const live = worker({
      location: { lat: 30.8, lng: 76.8, updatedAt: new Date(NOW - 60_000) },
    });
    expect(workerPointOf(live, NOW)).toEqual({ lat: 30.8, lng: 76.8 });
  });

  it('ignores a stale fix and uses the base area instead', () => {
    const stale = worker({
      location: {
        lat: 30.8,
        lng: 76.8,
        updatedAt: new Date(NOW - LOCATION_FRESH_MS - 1),
      },
    });
    expect(workerPointOf(stale, NOW)).toEqual(SECTOR_22);
  });

  it('has no point when there is neither a fresh fix nor a centroid', () => {
    expect(
      workerPointOf(
        worker({ baseArea: { cityId: 1, lat: null, lng: null } }),
        NOW,
      ),
    ).toBeNull();
  });
});

describe('coverageOf', () => {
  it('applies the worker radius when both sides have coordinates', () => {
    const near = coverageOf(
      worker({ radiusKm: 3 }),
      { point: SECTOR_22, cityId: 1 },
      NOW,
    );
    const far = coverageOf(
      worker({ radiusKm: 3 }),
      { point: PHASE_7, cityId: 2 },
      NOW,
    );
    expect(near.covers).toBe(true);
    expect(far.covers).toBe(false);
  });

  it('falls back to the same city when the area centroids are missing', () => {
    const noCoords = worker({ baseArea: { cityId: 1, lat: null, lng: null } });
    expect(coverageOf(noCoords, { point: null, cityId: 1 }, NOW)).toEqual({
      covers: true,
      distanceKm: null,
      extended: false,
    });
    expect(coverageOf(noCoords, { point: null, cityId: 2 }, NOW)).toEqual({
      covers: false,
      distanceKm: null,
      extended: false,
    });
  });
});

describe('coverageOf for scheduled work (BR-19, BR-20)', () => {
  const SECTOR_35 = { lat: 30.724, lng: 76.758 };
  const hoursFromNow = (h: number) => new Date(NOW + h * 3_600_000);
  // About 6.4 km from the base area (Sector 22), 0.2 km from the worker's live fix at Phase 7.
  const atPhase7 = {
    lat: PHASE_7.lat,
    lng: PHASE_7.lng,
    updatedAt: new Date(NOW - 60_000),
  };

  it('judges a job starting soon by the live position', () => {
    const w = worker({ radiusKm: 3, location: atPhase7 });
    const spot = { point: PHASE_7, cityId: 1, startsAt: hoursFromNow(1) };
    expect(coverageOf(w, spot, NOW).covers).toBe(true); // right next to the live fix
  });

  it('judges a job starting later by the base area, ignoring the live position', () => {
    const w = worker({ radiusKm: 3, location: atPhase7 });
    const spot = { point: PHASE_7, cityId: 1, startsAt: hoursFromNow(5) };
    const result = coverageOf(w, spot, NOW);
    expect(result.covers).toBe(false); // 6.4 km from home, outside a 3 km radius
    expect(result.distanceKm).toBeGreaterThan(5);
  });

  it('applies the wider scheduled radius only to future jobs', () => {
    const w = worker({ radiusKm: 3, scheduledRadiusKm: 12 });
    const far = { point: PHASE_7, cityId: 1 };
    expect(
      coverageOf(w, { ...far, startsAt: hoursFromNow(1) }, NOW).covers,
    ).toBe(false);
    expect(coverageOf(w, far, NOW).covers).toBe(false); // immediate: normal radius
    const future = coverageOf(w, { ...far, startsAt: hoursFromNow(48) }, NOW);
    expect(future.covers).toBe(true);
    expect(future.extended).toBe(true);
  });

  it('does not call a spot extended when it is inside the normal radius', () => {
    const w = worker({ radiusKm: 3, scheduledRadiusKm: 12 });
    const result = coverageOf(
      w,
      { point: SECTOR_35, cityId: 1, startsAt: hoursFromNow(48) },
      NOW,
    );
    expect(result).toMatchObject({ covers: true, extended: false });
  });

  it('never goes below the normal radius even if the scheduled one is smaller', () => {
    const w = worker({ radiusKm: 12, scheduledRadiusKm: 6 });
    const spot = { point: PHASE_7, cityId: 1, startsAt: hoursFromNow(48) };
    expect(coverageOf(w, spot, NOW).covers).toBe(true);
  });

  it('keeps the same-city fallback for future jobs when centroids are missing', () => {
    const noCoords = worker({ baseArea: { cityId: 1, lat: null, lng: null } });
    expect(
      coverageOf(
        noCoords,
        { point: null, cityId: 1, startsAt: hoursFromNow(48) },
        NOW,
      ).covers,
    ).toBe(true);
  });
});
