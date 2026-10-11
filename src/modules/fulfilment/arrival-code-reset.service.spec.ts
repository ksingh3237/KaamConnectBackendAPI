import { vi } from 'vitest';
import {
  ARRIVAL_CODE_RESET_COOLDOWN_SEC,
  ArrivalCodeResetService,
  MAX_ARRIVAL_CODE_RESETS,
  resetRefusal,
} from './arrival-code-reset.service.js';

describe('resetRefusal (arrival-code reset limits)', () => {
  const now = new Date('2026-10-11T10:00:00.000Z');
  const ago = (sec: number) => new Date(now.getTime() - sec * 1000);

  it('allows the first reset', () => {
    expect(
      resetRefusal({ arrivalCodeResets: 0, arrivalCodeResetAt: null }, now),
    ).toBeNull();
  });

  it('refuses inside the cooldown and says how long to wait', () => {
    expect(
      resetRefusal({ arrivalCodeResets: 1, arrivalCodeResetAt: ago(20) }, now),
    ).toEqual({
      reason: 'COOLDOWN',
      retryAfterSec: ARRIVAL_CODE_RESET_COOLDOWN_SEC - 20,
    });
  });

  it('allows again exactly when the cooldown has passed', () => {
    expect(
      resetRefusal(
        {
          arrivalCodeResets: 1,
          arrivalCodeResetAt: ago(ARRIVAL_CODE_RESET_COOLDOWN_SEC),
        },
        now,
      ),
    ).toBeNull();
  });

  it('refuses once the cap is reached, however long ago the last reset was', () => {
    expect(
      resetRefusal(
        {
          arrivalCodeResets: MAX_ARRIVAL_CODE_RESETS,
          arrivalCodeResetAt: ago(10_000),
        },
        now,
      ),
    ).toEqual({ reason: 'LIMIT' });
  });

  it('keeps the agreed limits: 3 resets, 60 seconds apart', () => {
    expect(MAX_ARRIVAL_CODE_RESETS).toBe(3);
    expect(ARRIVAL_CODE_RESET_COOLDOWN_SEC).toBe(60);
  });
});

describe('ArrivalCodeResetService.reset: redrawing a repeated code and RESET_FAILED', () => {
  // A new code equal to the old one is refused by the UPDATE itself (1 in 10,000). Forcing three of
  // those in a row with real random numbers is not practical, so the database is stubbed.
  const allowedJob = {
    status: 'ASSIGNED',
    arrivalCodeResets: 0,
    arrivalCodeResetAt: null,
  };

  function build(updateResults: boolean[]) {
    const transaction = vi.fn();
    for (const result of updateResults)
      transaction.mockResolvedValueOnce(result);
    const prisma = {
      $transaction: transaction,
      job: {
        findFirst: vi.fn().mockResolvedValue(allowedJob),
        findUniqueOrThrow: vi
          .fn()
          .mockResolvedValue({ id: 'job-1', workerId: 'worker-1' }),
      },
      jobSecurityEvent: { findFirst: vi.fn(), create: vi.fn() },
    };
    const events = { arrivalCodeReset: vi.fn() };
    const views = { forCustomer: vi.fn().mockResolvedValue({ id: 'job-1' }) };
    const service = new ArrivalCodeResetService(
      prisma as never,
      events as never,
      views as never,
    );
    return { service, prisma, events, views, transaction };
  }

  it('after three repeated codes in a row it answers 503 RESET_FAILED and changes, audits and pushes nothing', async () => {
    const { service, prisma, events, views, transaction } = build([
      false,
      false,
      false,
    ]);
    await expect(
      service.reset('customer-1', 'job-1', '10.0.0.1'),
    ).rejects.toMatchObject({ code: 'RESET_FAILED', status: 503 });
    expect(transaction).toHaveBeenCalledTimes(3);
    expect(prisma.jobSecurityEvent.create).not.toHaveBeenCalled();
    expect(prisma.job.findUniqueOrThrow).not.toHaveBeenCalled();
    expect(events.arrivalCodeReset).not.toHaveBeenCalled();
    expect(views.forCustomer).not.toHaveBeenCalled();
  });

  it('a repeated code followed by a good one succeeds on the second draw, with one push and no refusal audit', async () => {
    const { service, prisma, events, transaction } = build([false, true]);
    await expect(
      service.reset('customer-1', 'job-1', undefined),
    ).resolves.toEqual({
      id: 'job-1',
    });
    expect(transaction).toHaveBeenCalledTimes(2);
    expect(events.arrivalCodeReset).toHaveBeenCalledTimes(1);
    expect(events.arrivalCodeReset).toHaveBeenCalledWith('worker-1', 'job-1');
    expect(prisma.jobSecurityEvent.create).not.toHaveBeenCalled();
  });

  it('an unknown or not-owned job is a 404 straight away (no redraw, no audit)', async () => {
    const { service, prisma, transaction } = build([false]);
    prisma.job.findFirst.mockResolvedValueOnce(null);
    await expect(
      service.reset('customer-1', 'job-x', '10.0.0.1'),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(prisma.jobSecurityEvent.create).not.toHaveBeenCalled();
  });
});
