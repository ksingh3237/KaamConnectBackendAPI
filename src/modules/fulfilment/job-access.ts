import { AppException } from '../../common/exceptions/app.exception.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { JobStatus } from '../../generated/prisma/enums.js';

type Db = Pick<Prisma.TransactionClient, 'job'>;

/** "Not yours" and "does not exist" are deliberately the same answer. */
export const jobNotFound = () =>
  new AppException('NOT_FOUND', 404, 'Job not found');

/**
 * A conditional update claimed no row. Either the caller has no such job (404, same as an unknown id),
 * or it is theirs but in the wrong state (409). `party` is the ownership test used by the update.
 */
export async function explainFailedClaim(
  db: Db,
  jobId: string,
  party: { customerId: string } | { workerId: string },
): Promise<never> {
  const row = await db.job.findFirst({
    where: { id: jobId, ...party },
    select: { status: true },
  });
  if (!row) throw jobNotFound();
  throw new AppException(
    'INVALID_TRANSITION',
    409,
    `That is not possible while the job is ${row.status}`,
  );
}

/** Statuses in which a worker has been chosen and the bill exists. */
export const IN_SERVICE_STATUSES: readonly JobStatus[] = [
  JobStatus.ASSIGNED,
  JobStatus.ARRIVED,
  JobStatus.IN_PROGRESS,
  JobStatus.WORK_COMPLETED,
];

/** Money: the bill total is the plain sum of its items; the platform adds nothing (BR-1). */
export const totalOf = (items: readonly { amount: number }[]): number =>
  items.reduce((sum, item) => sum + item.amount, 0);
