import type { Prisma, PrismaClient } from '../../generated/prisma/client.js';
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

/**
 * How many quotes a customer can see on each of `jobIds`, by the same rule as above. Jobs with none are absent
 * from the map (read it with `?? 0`).
 *
 * Why this exists: asking Prisma for `_count: { offers: { where: VISIBLE_TO_CUSTOMER } }` while loading MANY jobs
 * makes PostgreSQL count the visible quotes of the ENTIRE `offers` table and join the result, because a filter
 * that reaches into `worker_profiles` cannot be pushed down per job. Measured with 100k quotes: 64 ms for a
 * 21-row page of a customer with 2,000 jobs, 50 ms for the 500-candidate lead feed, against under 1 ms when only
 * the page's own job ids are counted, through the `(job_id, worker_id)` index. For ONE job the join is already
 * fast (0.1 ms), so single-job reads keep using `_count`.
 */
export async function visibleOfferCounts(
  prisma: Pick<PrismaClient, 'offer'>,
  jobIds: readonly string[],
): Promise<Map<string, number>> {
  if (jobIds.length === 0) return new Map();
  const grouped = await prisma.offer.groupBy({
    by: ['jobId'],
    where: { jobId: { in: [...jobIds] }, ...VISIBLE_TO_CUSTOMER },
    _count: { _all: true },
  });
  return new Map(grouped.map((g) => [g.jobId, g._count._all]));
}
