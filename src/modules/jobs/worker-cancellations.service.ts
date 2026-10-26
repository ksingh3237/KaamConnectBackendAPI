import { Injectable } from '@nestjs/common';
import { referenceOf } from '../../common/utils/reference.js';
import { CancelledBy, type JobStatus } from '../../generated/prisma/enums.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  BACK_OUT_WARN_AT,
  BACK_OUT_WINDOW_DAYS,
  labelOfReason,
} from './cancel-reasons.js';

export interface BackOutSummary {
  windowDays: number;
  warnAt: number;
  /** Back-outs inside the window that were the worker's own doing. */
  recent: number;
  /** True from `warnAt` onward: the app shows a warning and the admin list flags the worker. */
  warn: boolean;
}

export interface WorkerCancellationItem {
  id: string;
  jobId: string;
  reference: string;
  title: string;
  stage: JobStatus;
  reasonCode: string;
  reason: string;
  /** The request went back to the customer for new quotes. */
  reopened: boolean;
  countsAgainstWorker: boolean;
  createdAt: string;
}

export interface WorkerCancellations {
  summary: BackOutSummary;
  /** The worker's own cancellations, newest first. A re-opened job leaves their job list, so this is where it is kept. */
  items: WorkerCancellationItem[];
}

const LIST_LIMIT = 20;

/** The worker's own cancellation history and the repeat back-out warning (docs/13-cancellation.md section 6). */
@Injectable()
export class WorkerCancellationsService {
  constructor(private readonly prisma: PrismaService) {}

  async summaryOf(workerId: string, now = new Date()): Promise<BackOutSummary> {
    const since = new Date(now.getTime() - BACK_OUT_WINDOW_DAYS * 86_400_000);
    const recent = await this.prisma.jobCancellation.count({
      where: {
        actorId: workerId,
        actorRole: CancelledBy.WORKER,
        countsAgainstWorker: true,
        createdAt: { gte: since },
      },
    });
    return {
      windowDays: BACK_OUT_WINDOW_DAYS,
      warnAt: BACK_OUT_WARN_AT,
      recent,
      warn: recent >= BACK_OUT_WARN_AT,
    };
  }

  async list(workerId: string): Promise<WorkerCancellations> {
    const [summary, rows] = await Promise.all([
      this.summaryOf(workerId),
      this.prisma.jobCancellation.findMany({
        where: { actorId: workerId, actorRole: CancelledBy.WORKER },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: LIST_LIMIT,
        include: { job: { select: { jobNumber: true, title: true } } },
      }),
    ]);
    return {
      summary,
      items: rows.map((r) => ({
        id: r.id,
        jobId: r.jobId,
        reference: referenceOf(r.job.jobNumber),
        title: r.job.title,
        stage: r.stage,
        reasonCode: r.reasonCode,
        reason: r.note ?? labelOfReason('WORKER', r.reasonCode),
        reopened: r.reopened,
        countsAgainstWorker: r.countsAgainstWorker,
        createdAt: r.createdAt.toISOString(),
      })),
    };
  }
}
