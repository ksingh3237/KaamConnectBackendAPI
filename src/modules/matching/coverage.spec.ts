import { coverage } from './coverage.js';

const SECTOR_22 = { lat: 30.7333, lng: 76.7794 };
const SECTOR_35 = { lat: 30.724, lng: 76.758 }; // about 2.3 km from sector 22
const PHASE_7 = { lat: 30.711, lng: 76.72 }; // about 6.4 km from sector 22

const base = { workerCityId: 1, spotCityId: 1 };

describe('coverage with coordinates', () => {
  it('covers a spot inside the worker radius and reports the distance', () => {
    const result = coverage({
      ...base,
      workerPoint: SECTOR_22,
      spotPoint: SECTOR_35,
      radiusKm: 3,
    });
    expect(result.covers).toBe(true);
    expect(result.distanceKm).toBeGreaterThan(1.5);
    expect(result.distanceKm).toBeLessThan(3);
  });

  it('does not cover a spot outside the radius, but still reports the distance', () => {
    const result = coverage({
      ...base,
      workerPoint: SECTOR_22,
      spotPoint: PHASE_7,
      radiusKm: 3,
    });
    expect(result.covers).toBe(false);
    expect(result.distanceKm).toBeGreaterThan(5);
  });

  it('the same spot is covered once the radius is large enough (3, 6 or 12 km)', () => {
    const at = (radiusKm: number) =>
      coverage({
        ...base,
        workerPoint: SECTOR_22,
        spotPoint: PHASE_7,
        radiusKm,
      }).covers;
    expect(at(3)).toBe(false);
    expect(at(12)).toBe(true);
  });

  it('uses coordinates even across cities (a Mohali spot near a Chandigarh worker)', () => {
    const result = coverage({
      workerPoint: SECTOR_22,
      workerCityId: 1,
      spotPoint: PHASE_7,
      spotCityId: 2,
      radiusKm: 12,
    });
    expect(result.covers).toBe(true);
  });

  it('covers a spot exactly at the worker', () => {
    expect(
      coverage({
        ...base,
        workerPoint: SECTOR_22,
        spotPoint: SECTOR_22,
        radiusKm: 3,
      }),
    ).toEqual({
      covers: true,
      distanceKm: 0,
      extended: false,
    });
  });
});

describe('coverage without coordinates (area centroids not filled yet)', () => {
  it('falls back to the same city, reporting no distance', () => {
    expect(
      coverage({ ...base, workerPoint: null, spotPoint: null, radiusKm: 3 }),
    ).toEqual({
      covers: true,
      distanceKm: null,
      extended: false,
    });
  });

  it('does not cover another city', () => {
    expect(
      coverage({
        workerPoint: null,
        workerCityId: 1,
        spotPoint: null,
        spotCityId: 2,
        radiusKm: 12,
      }),
    ).toEqual({
      covers: false,
      distanceKm: null,
      extended: false,
    });
  });

  it('falls back when only one side has coordinates', () => {
    expect(
      coverage({
        ...base,
        workerPoint: SECTOR_22,
        spotPoint: null,
        radiusKm: 3,
      }).distanceKm,
    ).toBeNull();
    expect(
      coverage({
        ...base,
        workerPoint: null,
        spotPoint: SECTOR_22,
        radiusKm: 3,
      }).distanceKm,
    ).toBeNull();
  });
});

describe('coverage with a wider radius for future work', () => {
  it('reports a spot beyond the normal radius as extended', () => {
    const result = coverage({
      ...base,
      workerPoint: SECTOR_22,
      spotPoint: PHASE_7,
      radiusKm: 12,
      coreRadiusKm: 3,
    });
    expect(result).toMatchObject({ covers: true, extended: true });
  });

  it('does not report extended for a spot inside the normal radius', () => {
    const result = coverage({
      ...base,
      workerPoint: SECTOR_22,
      spotPoint: SECTOR_35,
      radiusKm: 12,
      coreRadiusKm: 3,
    });
    expect(result).toMatchObject({ covers: true, extended: false });
  });
});
