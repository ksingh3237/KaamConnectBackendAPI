import {
  etaMinutes,
  haversineKm,
  type GeoPoint,
} from '../../common/utils/geo.js';
import { JobStatus } from '../../generated/prisma/enums.js';

/** The arrival choices on the Send Quote screen. Shared by quoting and by the availability checks. */
export const QUOTE_ETA_CHOICES = [15, 30, 45] as const;

/** Statuses in which a worker's reserved window blocks other bookings (docs BR-14, BR-17). */
export const OCCUPYING_STATUSES: readonly JobStatus[] = [
  JobStatus.ASSIGNED,
  JobStatus.ARRIVED,
  JobStatus.IN_PROGRESS,
];

/** A job the worker is physically at or about to be at: its window stretches while it overruns. */
const ON_SITE_STATUSES: readonly JobStatus[] = [
  JobStatus.ARRIVED,
  JobStatus.IN_PROGRESS,
];

export interface SchedulingRules {
  avgSpeedKmh: number;
  /** Smallest gap between two bookings, however close they are. */
  bufferMin: number;
  /** Used for the gap when either place has no coordinates. */
  defaultTravelMin: number;
}

/** An existing booking of the worker. */
export interface Slot {
  jobId: string;
  status: JobStatus;
  startAt: Date;
  endAt: Date;
  point: GeoPoint | null;
}

/** The booking being considered. */
export interface Candidate {
  startAt: Date;
  endAt: Date;
  point: GeoPoint | null;
}

export type ConflictReason = 'OVERLAP' | 'TRAVEL_BUFFER';

export interface Conflict {
  reason: ConflictReason;
  jobId: string;
  startAt: Date;
  endAt: Date;
  /** Earliest time the candidate could start if only this booking were in the way. */
  nextFreeAt: Date;
}

const MINUTE_MS = 60_000;

/** The window a job occupies: the requested time, or "arrival" (confirmation + ETA) for an immediate job. */
export function windowFor(input: {
  scheduledFor: Date | null;
  durationMin: number;
  etaMinutes: number;
  now: Date;
}): { startAt: Date; endAt: Date } {
  const startAt =
    input.scheduledFor ??
    new Date(input.now.getTime() + input.etaMinutes * MINUTE_MS);
  return {
    startAt,
    endAt: new Date(startAt.getTime() + input.durationMin * MINUTE_MS),
  };
}

/** Minutes the worker needs between the end of one booking and the start of the next. */
export function gapMinutes(
  a: GeoPoint | null,
  b: GeoPoint | null,
  rules: SchedulingRules,
): number {
  const travel =
    a && b
      ? etaMinutes(haversineKm(a, b), rules.avgSpeedKmh)
      : rules.defaultTravelMin;
  return Math.max(rules.bufferMin, travel);
}

/**
 * When the booking really ends. A job the worker is already on site for keeps them busy until it is
 * finished, even if it has run past its planned window.
 */
export function effectiveEnd(slot: Slot, now: Date): Date {
  return ON_SITE_STATUSES.includes(slot.status) && now > slot.endAt
    ? now
    : slot.endAt;
}

/**
 * Every existing booking the candidate clashes with: either the windows overlap, or the gap between
 * them is shorter than the travel (plus buffer) the worker needs. Pure; the caller decides what to do.
 */
export function findConflicts(
  slots: readonly Slot[],
  candidate: Candidate,
  rules: SchedulingRules,
  now: Date,
): Conflict[] {
  const conflicts: Conflict[] = [];
  for (const slot of slots) {
    const slotEnd = effectiveEnd(slot, now);
    const gapMs = gapMinutes(slot.point, candidate.point, rules) * MINUTE_MS;
    const base = {
      jobId: slot.jobId,
      startAt: slot.startAt,
      endAt: slotEnd,
      nextFreeAt: new Date(slotEnd.getTime() + gapMs),
    };

    const overlaps =
      candidate.startAt < slotEnd && slot.startAt < candidate.endAt;
    if (overlaps) {
      conflicts.push({ reason: 'OVERLAP', ...base });
    } else if (slotEnd <= candidate.startAt) {
      // The existing booking comes first: the worker must be able to get from it to the candidate.
      if (candidate.startAt.getTime() < slotEnd.getTime() + gapMs)
        conflicts.push({ reason: 'TRAVEL_BUFFER', ...base });
    } else if (slot.startAt.getTime() < candidate.endAt.getTime() + gapMs) {
      // The candidate comes first: the worker must be able to get from it to the existing booking.
      conflicts.push({ reason: 'TRAVEL_BUFFER', ...base });
    }
  }
  return conflicts;
}

/** Earliest start that clears every conflict, or null when there are none. */
export function nextFreeAt(conflicts: readonly Conflict[]): Date | null {
  if (conflicts.length === 0) return null;
  return new Date(Math.max(...conflicts.map((c) => c.nextFreeAt.getTime())));
}
