import { etaMinutes, haversineKm, pointOf, roundKm } from './geo.js';

// Reference points in the Tricity (approximate, used only to sanity-check the maths).
const CHANDIGARH_SECTOR_17 = { lat: 30.741, lng: 76.784 };
const MOHALI_PHASE_7 = { lat: 30.711, lng: 76.72 };

describe('haversineKm', () => {
  it('is 0 for the same point and symmetric', () => {
    expect(haversineKm(CHANDIGARH_SECTOR_17, CHANDIGARH_SECTOR_17)).toBe(0);
    expect(haversineKm(CHANDIGARH_SECTOR_17, MOHALI_PHASE_7)).toBeCloseTo(
      haversineKm(MOHALI_PHASE_7, CHANDIGARH_SECTOR_17),
      9,
    );
  });

  it('matches a known distance: one degree of latitude is about 111.2 km', () => {
    expect(haversineKm({ lat: 0, lng: 0 }, { lat: 1, lng: 0 })).toBeCloseTo(
      111.2,
      1,
    );
  });

  it('gives a plausible Chandigarh to Mohali distance (about 7 km)', () => {
    const km = haversineKm(CHANDIGARH_SECTOR_17, MOHALI_PHASE_7);
    expect(km).toBeGreaterThan(6);
    expect(km).toBeLessThan(8.5);
  });

  it('handles antipodal points without returning NaN', () => {
    expect(haversineKm({ lat: 0, lng: 0 }, { lat: 0, lng: 180 })).toBeCloseTo(
      20015.1,
      0,
    );
  });
});

describe('roundKm', () => {
  it('rounds to one decimal', () => {
    expect(roundKm(0.94)).toBe(0.9);
    expect(roundKm(0.95)).toBe(1);
    expect(roundKm(12.349)).toBe(12.3);
  });
});

describe('etaMinutes', () => {
  it('is distance divided by speed, rounded up', () => {
    expect(etaMinutes(10, 20)).toBe(30);
    expect(etaMinutes(1.1, 20)).toBe(4); // 3.3 min
    expect(etaMinutes(5, 30)).toBe(10);
  });

  it('is never below 1 minute', () => {
    expect(etaMinutes(0, 20)).toBe(1);
    expect(etaMinutes(0.01, 20)).toBe(1);
  });
});

describe('pointOf', () => {
  it('needs both coordinates', () => {
    expect(pointOf(30.7, 76.7)).toEqual({ lat: 30.7, lng: 76.7 });
    expect(pointOf(30.7, null)).toBeNull();
    expect(pointOf(undefined, 76.7)).toBeNull();
    expect(pointOf(null, null)).toBeNull();
  });

  it('accepts zero as a real coordinate', () => {
    expect(pointOf(0, 0)).toEqual({ lat: 0, lng: 0 });
  });
});
