import { describe, expect, it } from 'vitest';
import { LOCATION_FRESH_MS } from '../matching/matching.service.js';
import { FIX_STALE_MS, tripOf } from './trip.js';

const NOW = Date.UTC(2026, 9, 12, 6, 0, 0);
const SECTOR_22 = { lat: 30.7333, lng: 76.7794 };
const PHASE_7 = { lat: 30.711, lng: 76.72 }; // about 6 km from Sector 22
const fix = (ageMs: number, at = PHASE_7) => ({
  ...at,
  updatedAt: new Date(NOW - ageMs),
});
const noCentre = { lat: null, lng: null };

describe('tripOf: nothing is guessed', () => {
  it('has no distance and no ETA when neither the customer nor the area has real coordinates', () => {
    const trip = tripOf({
      fix: fix(10_000),
      job: { lat: null, lng: null, area: noCentre },
      now: NOW,
      avgSpeedKmh: 20,
    });
    expect(trip).toMatchObject({
      distanceKm: null,
      etaMinutes: null,
      distanceBasis: null,
    });
    // ...but the worker's real position is still shown.
    expect(trip.location).toMatchObject({ lat: PHASE_7.lat, stale: false });
  });

  it("uses the job's own coordinates when the customer shared GPS, and says so", () => {
    const trip = tripOf({
      fix: fix(10_000),
      job: { ...SECTOR_22, area: noCentre },
      now: NOW,
      avgSpeedKmh: 20,
    });
    expect(trip.distanceBasis).toBe('JOB_COORDINATES');
    expect(trip.distanceKm).toBeGreaterThan(5);
    expect(trip.distanceKm).toBeLessThan(7);
    expect(trip.etaMinutes).toBe(Math.ceil((trip.distanceKm! / 20) * 60));
  });

  it('falls back to the area centre only as a labelled approximation', () => {
    const trip = tripOf({
      fix: fix(10_000),
      job: { lat: null, lng: null, area: SECTOR_22 },
      now: NOW,
      avgSpeedKmh: 20,
    });
    expect(trip.distanceBasis).toBe('AREA_CENTROID');
    expect(trip.distanceKm).not.toBeNull();
  });

  it('shows no position at all when the worker has not reported one', () => {
    expect(
      tripOf({
        fix: null,
        job: { ...SECTOR_22, area: noCentre },
        now: NOW,
        avgSpeedKmh: 20,
      }),
    ).toMatchObject({ location: null, distanceKm: null, etaMinutes: null });
  });

  it('flags a fix older than two minutes as stale but still uses it for distance', () => {
    const trip = tripOf({
      fix: fix(FIX_STALE_MS + 1000),
      job: { ...SECTOR_22, area: noCentre },
      now: NOW,
      avgSpeedKmh: 20,
    });
    expect(trip.location?.stale).toBe(true);
    expect(trip.distanceKm).not.toBeNull();
  });

  it('refuses to state a distance from a fix older than 30 minutes', () => {
    const trip = tripOf({
      fix: fix(LOCATION_FRESH_MS + 1000),
      job: { ...SECTOR_22, area: noCentre },
      now: NOW,
      avgSpeedKmh: 20,
    });
    expect(trip.location?.stale).toBe(true);
    expect(trip).toMatchObject({ distanceKm: null, etaMinutes: null });
  });
});
