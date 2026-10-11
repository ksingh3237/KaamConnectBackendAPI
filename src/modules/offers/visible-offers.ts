import type { Prisma } from '../../generated/prisma/client.js';
import {
  OfferStatus,
  VerificationStatus,
} from '../../generated/prisma/enums.js';

/**
 * Which quotes a CUSTOMER may see, count and accept (K-36, the other half of decision D-8).
 *
 * When a verified worker changes their name or photo they go back for review and disappear from customers.
 * Their quotes that are still waiting for an answer must disappear with them: otherwise the new, unreviewed
 * identity would be shown on a quote the customer can accept. So:
 *  - a PENDING quote counts only while its worker is VERIFIED; it comes back by itself once they are;
 *  - an ACCEPTED quote always counts: that worker was chosen while verified and is now doing the job, and a
 *    re-review must never strand a customer mid-job (D-8, Phase 5 constraint).
 * Rejected and withdrawn quotes were never shown.
 *
 * One definition, used by the quote list, by every "how many quotes" number and by the accept check, so they
 * cannot disagree.
 */
export const VISIBLE_TO_CUSTOMER = {
  OR: [
    { status: OfferStatus.ACCEPTED },
    {
      status: OfferStatus.PENDING,
      worker: { verificationStatus: VerificationStatus.VERIFIED },
    },
  ],
} satisfies Prisma.OfferWhereInput;
