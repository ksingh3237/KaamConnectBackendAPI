import {
  CancelledBy,
  JobStatus,
  OfferStatus,
} from '../../generated/prisma/enums.js';

/**
 * What became of a lead, from one worker's point of view, so the radar card and the lead screen can say it plainly
 * instead of offering a quote form on something that is gone:
 *  - QUOTE_DECLINED: the customer pressed Decline on this worker's quote. The request is still open; they may quote again.
 *  - CANCELLED_BY_CUSTOMER: the customer cancelled the request before choosing anyone.
 *  - TAKEN_BY_OTHER: the customer chose another worker.
 *  - EXPIRED: nobody was chosen in time.
 *  - CLOSED: closed for another reason (a direct request that was declined, or a worker-side cancellation).
 * null: nothing happened yet (an open lead), or the job is this worker's own (the job screen shows that story).
 */
export type LeadOutcome =
  | 'QUOTE_DECLINED'
  | 'CANCELLED_BY_CUSTOMER'
  | 'TAKEN_BY_OTHER'
  | 'EXPIRED'
  | 'CLOSED';

export interface LeadOutcomeInput {
  status: JobStatus;
  workerId: string | null;
  expiresAt: Date | null;
  cancelledBy: CancelledBy | null;
  cancelReason: string | null;
  /** This worker's own quote on the job, if any. */
  myOffer: { status: OfferStatus; declinedAt: Date | null } | null;
}

/** The cancel_reason the expiry sweeper stores (job-expiry.service.ts). */
const EXPIRED_REASON = 'EXPIRED';

export function leadOutcome(
  job: LeadOutcomeInput,
  viewerId: string,
  now: Date = new Date(),
): LeadOutcome | null {
  if (job.workerId === viewerId) return null;
  const chosenSomeoneElse = job.workerId !== null;

  switch (job.status) {
    case JobStatus.OPEN:
      // Past its time but not swept yet: it is over for everyone already.
      if (job.expiresAt !== null && job.expiresAt.getTime() <= now.getTime())
        return 'EXPIRED';
      return job.myOffer?.status === OfferStatus.REJECTED &&
        job.myOffer.declinedAt !== null
        ? 'QUOTE_DECLINED'
        : null;
    case JobStatus.CANCELLED:
      // Cancelled after another worker had been chosen: for this worker it ended when that choice was made.
      if (chosenSomeoneElse) return 'TAKEN_BY_OTHER';
      if (job.cancelledBy === CancelledBy.CUSTOMER)
        return 'CANCELLED_BY_CUSTOMER';
      if (
        job.cancelledBy === CancelledBy.SYSTEM &&
        job.cancelReason === EXPIRED_REASON
      )
        return 'EXPIRED';
      return 'CLOSED';
    default:
      // ASSIGNED and everything after it, with someone else as the worker.
      return 'TAKEN_BY_OTHER';
  }
}
