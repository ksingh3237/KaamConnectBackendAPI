import { JobTiming } from '../../generated/prisma/enums.js';

/** "Today" and "tomorrow" always mean the Tricity calendar day (docs A-14). IST has no daylight saving. */
const IST_OFFSET_MS = (5 * 60 + 30) * 60_000;
const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/** The instant at which the IST calendar day containing `instant` begins. */
export function istDayStart(instant: Date): Date {
  const shifted = instant.getTime() + IST_OFFSET_MS;
  return new Date(Math.floor(shifted / DAY_MS) * DAY_MS - IST_OFFSET_MS);
}

/** The instant of `hour:minute` IST on the IST day that begins at `dayStart`. */
export function istAt(dayStart: Date, hour: number, minute = 0): Date {
  return new Date(dayStart.getTime() + (hour * 60 + minute) * MINUTE_MS);
}

export interface ScheduleLimits {
  /** A requested time must be at least this far ahead. */
  minLeadMin: number;
  maxDays: number;
}

export type ScheduleResult =
  { ok: true; scheduledFor: Date | null } | { ok: false; issue: string };

/** "Afternoon" on the Post Job screen: an appointment that starts between these hours (IST). */
const AFTERNOON_FROM_HOUR = 12;
const AFTERNOON_TO_HOUR = 20;
const AFTERNOON_DEFAULT_HOUR = 14;
const TOMORROW_DEFAULT_HOUR = 10;

/**
 * Turns what the customer asked for into a concrete appointment time.
 *  - IMMEDIATE: no time (as soon as possible); sending one is an error.
 *  - SCHEDULED: an exact time is required.
 *  - AFTERNOON / TOMORROW: an exact time is optional; without one the labels mean 14:00 IST today
 *    (or 30 minutes from now if that is later) and 10:00 IST tomorrow.
 */
export function resolveScheduledFor(
  timing: JobTiming,
  requested: Date | undefined,
  now: Date,
  limits: ScheduleLimits,
): ScheduleResult {
  if (timing === JobTiming.IMMEDIATE) {
    return requested
      ? { ok: false, issue: 'scheduledFor is not allowed for IMMEDIATE jobs' }
      : { ok: true, scheduledFor: null };
  }

  const today = istDayStart(now);
  const earliest = new Date(now.getTime() + limits.minLeadMin * MINUTE_MS);

  if (!requested) {
    if (timing === JobTiming.SCHEDULED)
      return {
        ok: false,
        issue: 'scheduledFor is required for SCHEDULED jobs',
      };
    if (timing === JobTiming.TOMORROW) {
      return {
        ok: true,
        scheduledFor: istAt(
          new Date(today.getTime() + DAY_MS),
          TOMORROW_DEFAULT_HOUR,
        ),
      };
    }
    const fourteen = istAt(today, AFTERNOON_DEFAULT_HOUR);
    return {
      ok: true,
      scheduledFor: fourteen > earliest ? fourteen : earliest,
    };
  }

  if (Number.isNaN(requested.getTime()))
    return { ok: false, issue: 'scheduledFor must be a valid date and time' };
  if (requested < earliest)
    return {
      ok: false,
      issue: `scheduledFor must be at least ${limits.minLeadMin} minutes from now`,
    };
  if (requested.getTime() > now.getTime() + limits.maxDays * DAY_MS)
    return {
      ok: false,
      issue: `scheduledFor must be within ${limits.maxDays} days`,
    };

  const day = istDayStart(requested).getTime();
  if (timing === JobTiming.TOMORROW && day !== today.getTime() + DAY_MS)
    return {
      ok: false,
      issue: 'scheduledFor must be tomorrow for a TOMORROW job',
    };
  if (timing === JobTiming.AFTERNOON) {
    const from = istAt(today, AFTERNOON_FROM_HOUR);
    const to = istAt(today, AFTERNOON_TO_HOUR);
    if (day !== today.getTime() || requested < from || requested >= to)
      return {
        ok: false,
        issue:
          'scheduledFor must be today between 12:00 and 20:00 for an AFTERNOON job',
      };
  }
  return { ok: true, scheduledFor: requested };
}
