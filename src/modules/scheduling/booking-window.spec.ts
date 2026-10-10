import { describe, expect, it } from 'vitest';
import { JobStatus } from '../../generated/prisma/enums.js';
import {
  effectiveEnd,
  findConflicts,
  gapMinutes,
  nextFreeAt,
  windowFor,
  type Candidate,
  type SchedulingRules,
  type Slot,
} from './booking-window.js';

const RULES: SchedulingRules = {
  avgSpeedKmh: 20,
  bufferMin: 15,
  defaultTravelMin: 30,
};
const T0 = new Date('2026-10-12T04:00:00.000Z'); // 09:30 IST
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);
const SECTOR_22 = { lat: 30.7333, lng: 76.7794 };
const PHASE_7 = { lat: 30.711, lng: 76.72 }; // about 6.4 km from Sector 22 (19 min at 20 km/h)

const slot = (
  startMin: number,
  endMin: number,
  extra: Partial<Slot> = {},
): Slot => ({
  jobId: `job-${startMin}`,
  status: JobStatus.ASSIGNED,
  startAt: at(startMin),
  endAt: at(endMin),
  point: null,
  ...extra,
});
const candidate = (
  startMin: number,
  endMin: number,
  point: Candidate['point'] = null,
): Candidate => ({ startAt: at(startMin), endAt: at(endMin), point });

describe('windowFor', () => {
  it('uses the requested time for a scheduled job', () => {
    const w = windowFor({
      scheduledFor: at(300),
      durationMin: 90,
      etaMinutes: 30,
      now: T0,
    });
    expect(w.startAt).toEqual(at(300));
    expect(w.endAt).toEqual(at(390));
  });

  it('starts an immediate job when the worker arrives (now + ETA)', () => {
    const w = windowFor({
      scheduledFor: null,
      durationMin: 60,
      etaMinutes: 30,
      now: T0,
    });
    expect(w.startAt).toEqual(at(30));
    expect(w.endAt).toEqual(at(90));
  });
});

describe('gapMinutes', () => {
  it('is the travel time when it is longer than the buffer', () => {
    expect(gapMinutes(SECTOR_22, PHASE_7, RULES)).toBe(19);
  });

  it('never drops below the buffer, even for the same place', () => {
    expect(gapMinutes(SECTOR_22, SECTOR_22, RULES)).toBe(15);
  });

  it('falls back to the default travel time without coordinates', () => {
    expect(gapMinutes(null, SECTOR_22, RULES)).toBe(30);
    expect(gapMinutes(null, null, RULES)).toBe(30);
  });
});

describe('findConflicts', () => {
  it('finds nothing for a worker with no bookings', () => {
    expect(findConflicts([], candidate(0, 90), RULES, T0)).toEqual([]);
  });

  it('flags overlapping windows, however they overlap', () => {
    const existing = [slot(60, 150)];
    for (const [s, e] of [
      [0, 90], // overlaps the start
      [100, 200], // overlaps the end
      [70, 100], // inside
      [0, 300], // contains it
      [60, 150], // identical
    ] as const) {
      const found = findConflicts(existing, candidate(s, e), RULES, T0);
      expect(found.map((c) => c.reason)).toEqual(['OVERLAP']);
    }
  });

  it('allows a booking that starts after the gap', () => {
    // existing 60-150, no coordinates => 30 min gap => earliest start 180
    expect(
      findConflicts([slot(60, 150)], candidate(180, 270), RULES, T0),
    ).toEqual([]);
  });

  it('flags a booking that starts too soon after another ends (travel buffer)', () => {
    const found = findConflicts(
      [slot(60, 150)],
      candidate(170, 260),
      RULES,
      T0,
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.reason).toBe('TRAVEL_BUFFER');
    expect(found[0]?.nextFreeAt).toEqual(at(180));
  });

  it('flags a booking that ends too close to the next one', () => {
    const found = findConflicts(
      [slot(300, 390)],
      candidate(200, 280),
      RULES,
      T0,
    );
    expect(found.map((c) => c.reason)).toEqual(['TRAVEL_BUFFER']);
    // ...but 30 minutes of room is enough
    expect(
      findConflicts([slot(300, 390)], candidate(200, 270), RULES, T0),
    ).toEqual([]);
  });

  it('uses the real distance between the two places when coordinates are known', () => {
    const existing = [slot(60, 150, { point: SECTOR_22 })];
    // 19 min needed between Sector 22 and Phase 7 (existing booking ends at minute 150)
    expect(
      findConflicts(existing, candidate(168, 250, PHASE_7), RULES, T0),
    ).toHaveLength(1);
    expect(
      findConflicts(existing, candidate(170, 250, PHASE_7), RULES, T0),
    ).toEqual([]);
  });

  it('reports every booking in the way and the time after all of them', () => {
    const existing = [slot(0, 60), slot(100, 160)];
    const found = findConflicts(existing, candidate(30, 130), RULES, T0);
    expect(found).toHaveLength(2);
    expect(nextFreeAt(found)).toEqual(at(190));
    expect(nextFreeAt([])).toBeNull();
  });

  it('keeps a worker on site busy while the job overruns its window', () => {
    const overrunning = slot(-120, -30, { status: JobStatus.IN_PROGRESS });
    expect(effectiveEnd(overrunning, T0)).toEqual(T0);
    // The job was meant to end 30 minutes ago but the worker is still there, so they are busy "now"
    // and need the usual 30 minutes to get anywhere else.
    const found = findConflicts([overrunning], candidate(10, 100), RULES, T0);
    expect(found.map((c) => c.reason)).toEqual(['TRAVEL_BUFFER']);
    expect(found[0]?.nextFreeAt).toEqual(at(30));
    expect(findConflicts([overrunning], candidate(30, 120), RULES, T0)).toEqual(
      [],
    );
  });

  it('does not stretch a booking that has not started yet', () => {
    const late = slot(-120, -30); // ASSIGNED and long past: nothing to stretch
    expect(effectiveEnd(late, T0)).toEqual(at(-30));
  });

  it('lets a worker with a job in progress take a later booking after the gap', () => {
    const inProgress = slot(-30, 60, { status: JobStatus.IN_PROGRESS });
    expect(findConflicts([inProgress], candidate(90, 180), RULES, T0)).toEqual(
      [],
    );
  });
});
