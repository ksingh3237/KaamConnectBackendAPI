import { AppException } from '../../common/exceptions/app.exception.js';
import { JobStatus } from '../../generated/prisma/enums.js';
import {
  ALL_REASON_CODES,
  CUSTOMER_REASONS,
  UNSPECIFIED,
  WORKER_REASONS,
  labelOfReason,
  resolveReason,
  visitFeeIsDue,
} from './cancel-reasons.js';

const refusal = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(AppException);
    expect((error as AppException).getStatus()).toBe(422);
    expect((error as AppException).code).toBe('VALIDATION_FAILED');
    return error as AppException;
  }
  return expect.unreachable('should have been refused');
};

describe('cancel reasons', () => {
  it('every reason has a label a person can read', () => {
    for (const rule of [
      ...Object.values(WORKER_REASONS),
      ...Object.values(CUSTOMER_REASONS),
    ])
      expect(rule.label.length).toBeGreaterThan(3);
  });

  it("a worker back-out re-opens the request only when it was the worker's own doing", () => {
    // A customer who does not answer, or a wrong address, would not be fixed by re-broadcasting the same request.
    for (const [code, rule] of Object.entries(WORKER_REASONS))
      expect([code, rule.reopens]).toEqual([code, rule.workerFault]);
  });

  it('customers are never marked at fault and never re-open anything', () => {
    for (const rule of Object.values(CUSTOMER_REASONS)) {
      expect(rule.workerFault).toBe(false);
      expect(rule.reopens).toBe(false);
    }
  });

  it('lists every code once, including the one both sides share', () => {
    expect(new Set(ALL_REASON_CODES).size).toBe(ALL_REASON_CODES.length);
    expect(ALL_REASON_CODES).toContain('VEHICLE_PROBLEM');
    expect(ALL_REASON_CODES).toContain('CHANGED_MIND');
    expect(ALL_REASON_CODES.filter((c) => c === 'OTHER')).toHaveLength(1);
  });

  describe('resolveReason', () => {
    it('keeps the old behaviour when no code is sent: a worker backs out and the request re-opens', () => {
      const worker = resolveReason('WORKER', undefined, undefined);
      expect(worker).toMatchObject({
        code: UNSPECIFIED,
        workerFault: true,
        reopens: true,
        text: 'BACKED_OUT',
      });
      const customer = resolveReason('CUSTOMER', undefined, undefined);
      expect(customer).toMatchObject({
        code: UNSPECIFIED,
        workerFault: false,
        reopens: false,
        text: null,
      });
    });

    it("uses the person's own words as the text when they gave any, else the label", () => {
      expect(
        resolveReason('WORKER', 'VEHICLE_PROBLEM', '  puncture  ').text,
      ).toBe('puncture');
      expect(resolveReason('WORKER', 'VEHICLE_PROBLEM', '   ').text).toBe(
        'Vehicle problem',
      );
      expect(resolveReason('CUSTOMER', 'CHANGED_MIND', undefined).text).toBe(
        'Changed my mind',
      );
    });

    it('refuses a code that belongs to the other side, and a code nobody has', () => {
      const wrongSide = refusal(() =>
        resolveReason('CUSTOMER', 'VEHICLE_PROBLEM', undefined),
      );
      expect(wrongSide.details).toEqual([
        { field: 'reasonCode', issue: 'not a reason a customer can give' },
      ]);
      refusal(() => resolveReason('WORKER', 'CHANGED_MIND', undefined));
      refusal(() => resolveReason('WORKER', 'NOPE', undefined));
    });

    it('asks for words when the reason is OTHER', () => {
      const missing = refusal(() => resolveReason('WORKER', 'OTHER', '   '));
      expect(missing.details).toEqual([
        { field: 'reason', issue: 'tell us what happened' },
      ]);
      expect(resolveReason('WORKER', 'OTHER', 'family matter').note).toBe(
        'family matter',
      );
    });
  });

  describe('visitFeeIsDue', () => {
    const own = resolveReason('WORKER', 'CANT_DO_WORK', undefined);
    const theirs = resolveReason('WORKER', 'PRICE_DISAGREEMENT', undefined);
    const customers = resolveReason('CUSTOMER', 'PRICE_TOO_HIGH', undefined);

    it('is owed only once the worker is on site', () => {
      for (const stage of [JobStatus.OPEN, JobStatus.ASSIGNED]) {
        expect(visitFeeIsDue(stage, 'CUSTOMER', customers)).toBe(false);
        expect(visitFeeIsDue(stage, 'WORKER', theirs)).toBe(false);
      }
      expect(visitFeeIsDue(JobStatus.ARRIVED, 'CUSTOMER', customers)).toBe(
        true,
      );
    });

    it('is not owed when the worker is the one walking away for their own reason', () => {
      expect(visitFeeIsDue(JobStatus.ARRIVED, 'WORKER', own)).toBe(false);
      expect(visitFeeIsDue(JobStatus.ARRIVED, 'WORKER', theirs)).toBe(true);
    });
  });

  it('labels a stored code, and falls back to the code for one it does not know', () => {
    expect(labelOfReason('WORKER', 'TOO_FAR')).toBe('Too far to reach in time');
    expect(labelOfReason('CUSTOMER', UNSPECIFIED)).toBe('No reason given');
    expect(labelOfReason('WORKER', 'FROM_A_NEWER_SERVER')).toBe(
      'FROM_A_NEWER_SERVER',
    );
  });
});
