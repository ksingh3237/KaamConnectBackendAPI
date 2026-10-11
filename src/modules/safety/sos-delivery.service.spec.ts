import {
  SOS_MAX_DELIVERY_ATTEMPTS,
  retryDelayMs,
} from './sos-delivery.service.js';

describe('retryDelayMs (back-off between SOS delivery attempts)', () => {
  it('waits 30 s after the first failure and doubles each time', () => {
    expect(retryDelayMs(1)).toBe(30_000);
    expect(retryDelayMs(2)).toBe(60_000);
    expect(retryDelayMs(3)).toBe(120_000);
    expect(retryDelayMs(4)).toBe(240_000);
  });

  it('never waits more than 10 minutes, however many tries failed', () => {
    expect(retryDelayMs(6)).toBe(600_000);
    expect(retryDelayMs(SOS_MAX_DELIVERY_ATTEMPTS)).toBe(600_000);
    expect(retryDelayMs(1000)).toBe(600_000);
  });

  it('does not wait before the first attempt', () => {
    expect(retryDelayMs(0)).toBe(0);
    expect(retryDelayMs(-3)).toBe(0);
  });

  it('keeps trying for a useful while before giving up (about an hour and a half)', () => {
    let total = 0;
    for (let failed = 1; failed < SOS_MAX_DELIVERY_ATTEMPTS; failed += 1)
      total += retryDelayMs(failed);
    expect(total).toBeGreaterThan(30 * 60_000);
    expect(total).toBeLessThan(2 * 60 * 60_000);
  });
});
