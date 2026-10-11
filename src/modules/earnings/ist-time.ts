/**
 * "Today" for a worker means today in India, not in UTC (decision: stored UTC, days computed in
 * Asia/Kolkata). India has a fixed offset of +05:30 and no daylight saving, so a day is always
 * [00:00 IST, 00:00 IST next day) and no time-zone database is needed.
 */
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export type EarningsPeriod = 'today' | 'week' | 'month';

/** The half-open range [from, to) in UTC that the IST period containing `now` covers. */
export function istRange(
  period: EarningsPeriod,
  now: Date,
): { from: Date; to: Date } {
  // Shift so that UTC getters read IST wall-clock fields.
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  const year = ist.getUTCFullYear();
  const month = ist.getUTCMonth();
  const day = ist.getUTCDate();
  const midnight = (y: number, m: number, d: number) =>
    new Date(Date.UTC(y, m, d) - IST_OFFSET_MS);

  if (period === 'month')
    return { from: midnight(year, month, 1), to: midnight(year, month + 1, 1) };

  const today = midnight(year, month, day);
  if (period === 'today')
    return { from: today, to: new Date(today.getTime() + DAY_MS) };

  // The week starts on Monday.
  const sinceMonday = (ist.getUTCDay() + 6) % 7;
  const from = new Date(today.getTime() - sinceMonday * DAY_MS);
  return { from, to: new Date(from.getTime() + 7 * DAY_MS) };
}
