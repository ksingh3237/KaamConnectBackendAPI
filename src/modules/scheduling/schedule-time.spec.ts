import { describe, expect, it } from 'vitest';
import { JobTiming } from '../../generated/prisma/enums.js';
import {
  istAt,
  istDayStart,
  resolveScheduledFor,
  type ScheduleLimits,
} from './schedule-time.js';

const LIMITS: ScheduleLimits = { minLeadMin: 30, maxDays: 30 };
// 2026-10-12 10:00 IST (04:30 UTC)
const NOW = new Date('2026-10-12T04:30:00.000Z');
const ist = (isoLocal: string) => new Date(`${isoLocal}+05:30`);

describe('istDayStart / istAt', () => {
  it('finds midnight IST, which is 18:30 UTC the evening before', () => {
    expect(istDayStart(NOW).toISOString()).toBe('2026-10-11T18:30:00.000Z');
  });

  it('keeps 23:59 IST and 00:01 IST on different days', () => {
    expect(istDayStart(ist('2026-10-12T23:59:00')).toISOString()).toBe(
      '2026-10-11T18:30:00.000Z',
    );
    expect(istDayStart(ist('2026-10-13T00:01:00')).toISOString()).toBe(
      '2026-10-12T18:30:00.000Z',
    );
  });

  it('builds a wall-clock time on that day', () => {
    expect(istAt(istDayStart(NOW), 14).toISOString()).toBe(
      '2026-10-12T08:30:00.000Z',
    );
  });
});

describe('resolveScheduledFor', () => {
  it('IMMEDIATE has no appointment time and refuses one', () => {
    expect(
      resolveScheduledFor(JobTiming.IMMEDIATE, undefined, NOW, LIMITS),
    ).toEqual({ ok: true, scheduledFor: null });
    expect(
      resolveScheduledFor(
        JobTiming.IMMEDIATE,
        ist('2026-10-12T15:00:00'),
        NOW,
        LIMITS,
      ).ok,
    ).toBe(false);
  });

  it('SCHEDULED requires a time inside the allowed range', () => {
    expect(
      resolveScheduledFor(JobTiming.SCHEDULED, undefined, NOW, LIMITS).ok,
    ).toBe(false);
    const ok = resolveScheduledFor(
      JobTiming.SCHEDULED,
      ist('2026-10-20T11:00:00'),
      NOW,
      LIMITS,
    );
    expect(ok).toEqual({ ok: true, scheduledFor: ist('2026-10-20T11:00:00') });
  });

  it('rejects a time that is too soon, in the past or too far away', () => {
    for (const requested of [
      new Date(NOW.getTime() + 10 * 60_000), // 10 minutes ahead (limit is 30)
      new Date(NOW.getTime() - 60_000),
      new Date(NOW.getTime() + 31 * 24 * 3_600_000),
    ]) {
      expect(
        resolveScheduledFor(JobTiming.SCHEDULED, requested, NOW, LIMITS).ok,
      ).toBe(false);
    }
  });

  it('AFTERNOON defaults to 14:00 IST today', () => {
    expect(
      resolveScheduledFor(JobTiming.AFTERNOON, undefined, NOW, LIMITS),
    ).toEqual({ ok: true, scheduledFor: ist('2026-10-12T14:00:00') });
  });

  it('AFTERNOON posted after 14:00 starts 30 minutes from now instead', () => {
    const late = ist('2026-10-12T15:00:00');
    const result = resolveScheduledFor(
      JobTiming.AFTERNOON,
      undefined,
      late,
      LIMITS,
    );
    expect(result).toEqual({
      ok: true,
      scheduledFor: new Date(late.getTime() + 30 * 60_000),
    });
  });

  it('AFTERNOON accepts an exact time only for today between 12:00 and 20:00', () => {
    const pick = (t: string) =>
      resolveScheduledFor(JobTiming.AFTERNOON, ist(t), NOW, LIMITS).ok;
    expect(pick('2026-10-12T16:30:00')).toBe(true);
    expect(pick('2026-10-12T11:00:00')).toBe(false);
    expect(pick('2026-10-12T20:00:00')).toBe(false);
    expect(pick('2026-10-13T16:30:00')).toBe(false);
  });

  it('TOMORROW defaults to 10:00 IST tomorrow and accepts any time tomorrow', () => {
    expect(
      resolveScheduledFor(JobTiming.TOMORROW, undefined, NOW, LIMITS),
    ).toEqual({ ok: true, scheduledFor: ist('2026-10-13T10:00:00') });
    expect(
      resolveScheduledFor(
        JobTiming.TOMORROW,
        ist('2026-10-13T07:15:00'),
        NOW,
        LIMITS,
      ).ok,
    ).toBe(true);
    expect(
      resolveScheduledFor(
        JobTiming.TOMORROW,
        ist('2026-10-14T07:15:00'),
        NOW,
        LIMITS,
      ).ok,
    ).toBe(false);
  });

  it('decides "tomorrow" in IST, not UTC', () => {
    // 00:15 IST on the 13th is still the 12th in UTC (18:45), but in Chandigarh today is the 13th.
    const justAfterMidnight = ist('2026-10-13T00:15:00');
    expect(justAfterMidnight.toISOString().slice(0, 10)).toBe('2026-10-12');
    const result = resolveScheduledFor(
      JobTiming.TOMORROW,
      undefined,
      justAfterMidnight,
      LIMITS,
    );
    expect(result).toEqual({
      ok: true,
      scheduledFor: ist('2026-10-14T10:00:00'),
    });
  });
});
