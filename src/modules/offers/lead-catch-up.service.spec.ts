import { describe, expect, it } from 'vitest';
import {
  CATCHUP_MIN_INTERVAL_MS,
  shouldRematch,
  type MatchMark,
} from './lead-catch-up.service.js';

const NOW = Date.UTC(2026, 9, 10, 12, 0, 0);
const SECTOR_22 = { lat: 30.7333, lng: 76.7794 };
const SECTOR_35 = { lat: 30.724, lng: 76.758 }; // about 2.3 km away
const NEARBY = { lat: 30.7338, lng: 76.7799 }; // a few tens of metres away

const mark = (ageMs: number, at = SECTOR_22): MatchMark => ({
  ...at,
  at: NOW - ageMs,
});

describe('shouldRematch', () => {
  it('always looks for the first fix of a worker', () => {
    expect(shouldRematch(undefined, SECTOR_22, NOW)).toBe(true);
  });

  it('does not look again for a tiny move soon after the last look', () => {
    expect(shouldRematch(mark(5_000), NEARBY, NOW)).toBe(false);
  });

  it('looks again after a real move, even right away', () => {
    expect(shouldRematch(mark(5_000), SECTOR_35, NOW)).toBe(true);
  });

  it('looks again once a minute has passed, even without moving', () => {
    expect(shouldRematch(mark(CATCHUP_MIN_INTERVAL_MS - 1), NEARBY, NOW)).toBe(
      false,
    );
    expect(shouldRematch(mark(CATCHUP_MIN_INTERVAL_MS), NEARBY, NOW)).toBe(
      true,
    );
  });
});
