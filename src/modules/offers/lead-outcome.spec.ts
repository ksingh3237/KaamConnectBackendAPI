import {
  CancelledBy,
  JobStatus,
  OfferStatus,
} from '../../generated/prisma/enums.js';
import { leadOutcome, type LeadOutcomeInput } from './lead-outcome.js';

describe('leadOutcome', () => {
  const ME = 'worker-me';
  const OTHER = 'worker-other';
  const now = new Date('2026-11-17T10:00:00Z');
  const later = new Date('2026-11-17T12:00:00Z');
  const earlier = new Date('2026-11-17T09:00:00Z');
  const open: LeadOutcomeInput = {
    status: JobStatus.OPEN,
    workerId: null,
    expiresAt: later,
    cancelledBy: null,
    cancelReason: null,
    myOffer: null,
  };
  const of = (patch: Partial<LeadOutcomeInput>) =>
    leadOutcome({ ...open, ...patch }, ME, now);

  it('says nothing about an open lead, quoted or not', () => {
    expect(of({})).toBeNull();
    expect(
      of({ myOffer: { status: OfferStatus.PENDING, declinedAt: null } }),
    ).toBeNull();
  });

  it('is QUOTE_DECLINED only when the customer pressed Decline, not when the quote lost earlier', () => {
    expect(
      of({ myOffer: { status: OfferStatus.REJECTED, declinedAt: earlier } }),
    ).toBe('QUOTE_DECLINED');
    // Rejected without a decline: lost to a worker who then backed out, and the request is open again.
    expect(
      of({ myOffer: { status: OfferStatus.REJECTED, declinedAt: null } }),
    ).toBeNull();
  });

  it('is EXPIRED once an open lead is past its time, before and after the sweeper ran', () => {
    expect(of({ expiresAt: earlier })).toBe('EXPIRED');
    expect(of({ expiresAt: now })).toBe('EXPIRED');
    expect(
      of({
        status: JobStatus.CANCELLED,
        cancelledBy: CancelledBy.SYSTEM,
        cancelReason: 'EXPIRED',
      }),
    ).toBe('EXPIRED');
  });

  it('is CANCELLED_BY_CUSTOMER when the customer cancelled before choosing anyone', () => {
    expect(
      of({
        status: JobStatus.CANCELLED,
        cancelledBy: CancelledBy.CUSTOMER,
        myOffer: { status: OfferStatus.REJECTED, declinedAt: null },
      }),
    ).toBe('CANCELLED_BY_CUSTOMER');
  });

  it('is TAKEN_BY_OTHER once another worker was chosen, even if that job was cancelled later', () => {
    for (const status of [
      JobStatus.ASSIGNED,
      JobStatus.ARRIVED,
      JobStatus.IN_PROGRESS,
      JobStatus.WORK_COMPLETED,
      JobStatus.COMPLETED,
    ])
      expect(of({ status, workerId: OTHER })).toBe('TAKEN_BY_OTHER');
    expect(
      of({
        status: JobStatus.CANCELLED,
        workerId: OTHER,
        cancelledBy: CancelledBy.CUSTOMER,
      }),
    ).toBe('TAKEN_BY_OTHER');
  });

  it('is CLOSED for any other ending', () => {
    expect(
      of({
        status: JobStatus.CANCELLED,
        cancelledBy: CancelledBy.WORKER,
        cancelReason: 'DECLINED',
      }),
    ).toBe('CLOSED');
    expect(
      of({ status: JobStatus.CANCELLED, cancelledBy: CancelledBy.SYSTEM }),
    ).toBe('CLOSED');
  });

  it("never labels the worker's own job: the job screen tells that story", () => {
    expect(of({ status: JobStatus.ASSIGNED, workerId: ME })).toBeNull();
    expect(
      of({
        status: JobStatus.CANCELLED,
        workerId: ME,
        cancelledBy: CancelledBy.CUSTOMER,
      }),
    ).toBeNull();
  });
});
