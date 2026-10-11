import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client.js';
import { LeadResponse } from '../../generated/prisma/enums.js';
import { PrismaService } from '../../prisma/prisma.service.js';

type Db = Prisma.TransactionClient;

export interface LeadRecipient {
  workerId: string;
  response: LeadResponse | null;
}

/**
 * Remembers which leads reached which worker (docs BR-18, BR-22). The `(job, worker)` row is the
 * "already sent" guard: a push goes out only when `claim` newly inserted that row, so a lead found
 * by the new-job fan-out, by a location refresh and by a re-open reaches a worker exactly once.
 * The same row records the worker's answer (accepted / declined).
 */
@Injectable()
export class LeadDeliveryService {
  constructor(private readonly prisma: PrismaService) {}

  /** Marks the lead as sent to each worker; returns only the workers it had NOT been sent to before. */
  async claim(
    jobId: string,
    workerIds: readonly string[],
    db: Db = this.prisma,
  ): Promise<string[]> {
    if (workerIds.length === 0) return [];
    const rows = await db.$queryRaw<{ worker_id: string }[]>`
      INSERT INTO worker_leads (job_id, worker_id)
      SELECT ${jobId}::uuid, w FROM unnest(${[...workerIds]}::uuid[]) AS w
      ON CONFLICT (job_id, worker_id) DO NOTHING
      RETURNING worker_id`;
    return rows.map((r) => r.worker_id);
  }

  /** The same guard seen from the worker's side: which of these jobs had NOT been sent to them before. */
  async claimJobs(
    workerId: string,
    jobIds: readonly string[],
    db: Db = this.prisma,
  ): Promise<string[]> {
    if (jobIds.length === 0) return [];
    const rows = await db.$queryRaw<{ job_id: string }[]>`
      INSERT INTO worker_leads (job_id, worker_id)
      SELECT j, ${workerId}::uuid FROM unnest(${[...jobIds]}::uuid[]) AS j
      ON CONFLICT (job_id, worker_id) DO NOTHING
      RETURNING job_id`;
    return rows.map((r) => r.job_id);
  }

  /** Records the worker's answer, creating the row if the lead reached them some other way (the REST feed). */
  async respond(
    jobId: string,
    workerId: string,
    response: LeadResponse,
    db: Db = this.prisma,
  ): Promise<void> {
    const respondedAt = new Date();
    await db.workerLead.upsert({
      where: { jobId_workerId: { jobId, workerId } },
      create: { jobId, workerId, response, respondedAt },
      update: { response, respondedAt },
    });
  }

  async responseOf(
    jobId: string,
    workerId: string,
    db: Db = this.prisma,
  ): Promise<LeadResponse | null> {
    const row = await db.workerLead.findUnique({
      where: { jobId_workerId: { jobId, workerId } },
      select: { response: true },
    });
    return row?.response ?? null;
  }

  /** Everyone the lead was sent to, with their answer, so closing it reaches them too. */
  async recipientsOf(jobId: string): Promise<LeadRecipient[]> {
    const rows = await this.prisma.workerLead.findMany({
      where: { jobId },
      select: { workerId: true, response: true },
    });
    return rows;
  }
}

export { LeadResponse };
