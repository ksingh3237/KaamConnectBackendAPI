import type { Prisma } from '../../generated/prisma/client.js';
import {
  BillItemKind,
  CancelledBy,
  type JobStatus,
} from '../../generated/prisma/enums.js';
import { visitFeeIsDue, type ResolvedReason } from './cancel-reasons.js';

type Db = Prisma.TransactionClient;

/**
 * The visit fee the worker is owed directly, or null: only when they had already arrived and it is not their doing.
 * Read inside the cancelling transaction, so it is the line the customer saw.
 */
export async function visitFeeOwed(
  tx: Db,
  jobId: string,
  stage: JobStatus,
  actor: 'CUSTOMER' | 'WORKER',
  reason: ResolvedReason,
): Promise<number | null> {
  if (!visitFeeIsDue(stage, actor, reason)) return null;
  const fee = await tx.billItem.aggregate({
    where: { jobId, kind: BillItemKind.VISIT_FEE },
    _sum: { amount: true },
  });
  return fee._sum.amount && fee._sum.amount > 0 ? fee._sum.amount : null;
}

/** Appends the row that outlives the job's own `cancelled_*` columns. Call inside the cancelling transaction. */
export async function recordCancellation(
  tx: Db,
  input: {
    jobId: string;
    actorId: string;
    actor: 'CUSTOMER' | 'WORKER';
    workerId: string | null;
    stage: JobStatus;
    reason: ResolvedReason;
    reopened: boolean;
    visitFeeDue: number | null;
  },
): Promise<void> {
  await tx.jobCancellation.create({
    data: {
      jobId: input.jobId,
      actorId: input.actorId,
      actorRole:
        input.actor === 'WORKER' ? CancelledBy.WORKER : CancelledBy.CUSTOMER,
      workerId: input.workerId,
      stage: input.stage,
      reasonCode: input.reason.code,
      note: input.reason.note,
      reopened: input.reopened,
      countsAgainstWorker: input.actor === 'WORKER' && input.reason.workerFault,
      visitFeeDue: input.visitFeeDue,
    },
  });
}
