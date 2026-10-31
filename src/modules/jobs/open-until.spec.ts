import { describe, expect, it } from 'vitest';
import { openUntil, type OpenTtlSettings } from './open-until.js';

const TTL: OpenTtlSettings = {
  openTtlHours: 24,
  immediateTtlMin: 120,
  directTtlMin: 10,
  scheduledTtlHours: 72,
};
const NOW = new Date('2026-10-12T04:00:00.000Z');
const later = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);

describe('openUntil', () => {
  it('gives a request with no time and no immediacy flag the normal 24 hours', () => {
    expect(openUntil(NOW, null, false, TTL)).toEqual(later(24 * 60));
  });

  it('closes a request for right now after two hours: last night’s urgent job is not a lead today', () => {
    expect(openUntil(NOW, null, false, TTL, true)).toEqual(later(120));
    // A direct request keeps its own short window
    expect(openUntil(NOW, null, true, TTL, true)).toEqual(later(10));
  });

  it('gives a direct request only the short acceptance window', () => {
    expect(openUntil(NOW, null, true, TTL)).toEqual(later(10));
    expect(openUntil(NOW, later(5 * 24 * 60), true, TTL)).toEqual(later(10));
  });

  it('stops a scheduled request at its appointment, or at 72 hours, whichever is sooner', () => {
    expect(openUntil(NOW, later(24 * 60), false, TTL)).toEqual(later(24 * 60));
    expect(openUntil(NOW, later(10 * 24 * 60), false, TTL)).toEqual(
      later(72 * 60),
    );
  });

  it('always leaves at least ten minutes for a quote, even for an appointment about to start', () => {
    expect(openUntil(NOW, later(5), false, TTL)).toEqual(later(10));
    expect(openUntil(NOW, later(-30), false, TTL)).toEqual(later(10));
  });
});
