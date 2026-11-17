import { AppException } from '../../common/exceptions/app.exception.js';

/**
 * A booked appointment (a job with a time: Afternoon, Tomorrow, an exact time) is not "on the way" the moment a quote
 * is accepted. The worker may enter the arrival code from `earlyMin` minutes before the appointment, not earlier
 * (docs/17-booked-appointments.md). An "as soon as possible" job has no appointment and is never held back.
 */
export function arrivalOpensAt(
  scheduledFor: Date | null,
  earlyMin: number,
): Date | null {
  return scheduledFor
    ? new Date(scheduledFor.getTime() - earlyMin * 60_000)
    : null;
}

/** "3 Nov, 10:00 am" in Indian time. */
export function istLabel(at: Date): string {
  return at.toLocaleString('en-IN', {
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: 'Asia/Kolkata',
  });
}

export const tooEarly = (scheduledFor: Date, opensAt: Date) =>
  new AppException(
    'TOO_EARLY',
    409,
    `This job is booked for ${istLabel(scheduledFor)}. You can enter the arrival code from ${istLabel(opensAt)}.`,
    [{ field: 'scheduledFor', issue: opensAt.toISOString() }],
  );
