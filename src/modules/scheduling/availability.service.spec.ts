import { ConfigService } from '@nestjs/config';
import { describe, expect, it } from 'vitest';
import { JobStatus } from '../../generated/prisma/enums.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import {
  AvailabilityService,
  isExclusionViolation,
  type JobTimeInput,
} from './availability.service.js';
import type { Slot } from './booking-window.js';

const config = {
  get: (key: string) =>
    ({
      AVG_SPEED_KMH: 20,
      BOOKING_BUFFER_MIN: 15,
      BOOKING_DEFAULT_TRAVEL_MIN: 30,
    })[key],
} as unknown as ConfigService<never, true>;
const service = new AvailabilityService({} as PrismaService, config);

const NOW = new Date('2026-10-12T04:00:00.000Z'); // 09:30 IST
const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);

const slot = (startMin: number, endMin: number): Slot => ({
  jobId: `j${startMin}`,
  status: JobStatus.ASSIGNED,
  startAt: at(startMin),
  endAt: at(endMin),
  point: null,
});

const immediate: JobTimeInput = {
  scheduledFor: null,
  durationMin: 60,
  lat: null,
  lng: null,
  area: { lat: null, lng: null },
};
const scheduled = (startMin: number): JobTimeInput => ({
  ...immediate,
  scheduledFor: at(startMin),
});

describe('AvailabilityService.assess', () => {
  it('is free with an empty calendar, and offers all three quote times for an immediate job', () => {
    const a = service.assess([], immediate, NOW);
    expect(a).toMatchObject({ free: true, etaOptions: [15, 30, 45] });
  });

  it('offers only the arrival times the worker can keep', () => {
    // Busy until minute 40; with a 30 min gap the earliest arrival that works is 70 > 45... so none.
    const none = service.assess([slot(-30, 40)], immediate, NOW);
    expect(none.free).toBe(false);
    expect(none.etaOptions).toEqual([]);
    expect(none.reason).toBeTruthy();
    expect(none.nextFreeAt).toEqual(at(70));

    // Busy until minute 10: arrival at 45 (>= 10 + 30) works, 15 and 30 do not.
    const late = service.assess([slot(-30, 10)], immediate, NOW);
    expect(late).toMatchObject({ free: true, etaOptions: [45] });
  });

  it('tests a single arrival time when one is given', () => {
    const slots = [slot(-30, 10)];
    expect(service.assess(slots, immediate, NOW, 15).free).toBe(false);
    expect(service.assess(slots, immediate, NOW, 45).free).toBe(true);
  });

  it('judges a scheduled job at its own time, whatever the worker is doing now', () => {
    const busyNow = [slot(-30, 60)];
    expect(service.assess(busyNow, scheduled(24 * 60), NOW).free).toBe(true);
    expect(service.assess(busyNow, scheduled(45), NOW).free).toBe(false);
    expect(
      service.assess(busyNow, scheduled(24 * 60), NOW).etaOptions,
    ).toBeNull();
  });

  it('allows several future bookings as long as each leaves room', () => {
    const calendar = [slot(24 * 60, 24 * 60 + 90), slot(30 * 60, 30 * 60 + 90)];
    expect(service.assess(calendar, scheduled(27 * 60), NOW).free).toBe(true);
    expect(service.assess(calendar, scheduled(24 * 60 + 100), NOW).free).toBe(
      false,
    );
  });
});

describe('isExclusionViolation', () => {
  it('recognises PostgreSQL error 23P01 at any depth', () => {
    expect(isExclusionViolation({ code: '23P01' })).toBe(true);
    expect(isExclusionViolation({ cause: { cause: { code: '23P01' } } })).toBe(
      true,
    );
  });

  it('recognises the constraint name in the message or metadata', () => {
    expect(
      isExclusionViolation(
        new Error(
          'conflicting key value violates exclusion constraint "jobs_worker_no_overlap"',
        ),
      ),
    ).toBe(true);
    expect(
      isExclusionViolation({
        meta: { driverAdapterError: 'jobs_worker_no_overlap' },
      }),
    ).toBe(true);
  });

  it('ignores unrelated errors and survives cycles', () => {
    expect(isExclusionViolation(new Error('boom'))).toBe(false);
    expect(isExclusionViolation(undefined)).toBe(false);
    const loop: { cause?: unknown } = {};
    loop.cause = loop;
    expect(isExclusionViolation(loop)).toBe(false);
  });

  it('maps a database refusal to the same answer as the application check', () => {
    const mapped = service.asConflict({ code: '23P01' }, 'customer') as {
      code: string;
    };
    expect(mapped.code).toBe('WORKER_UNAVAILABLE');
    const worker = service.asConflict({ code: '23P01' }, 'worker') as {
      code: string;
    };
    expect(worker.code).toBe('SCHEDULE_CONFLICT');
    const other = new Error('boom');
    expect(service.asConflict(other, 'customer')).toBe(other);
  });
});
