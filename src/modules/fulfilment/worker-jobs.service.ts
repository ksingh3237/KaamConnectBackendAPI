import { Injectable } from '@nestjs/common';
import { decodeKeyset, encodeKeyset } from '../../common/utils/keyset.js';
import { referenceOf } from '../../common/utils/reference.js';
import { JobStatus, OfferStatus } from '../../generated/prisma/enums.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  statusesOfTab,
  tabOf,
  type JobTab,
} from '../jobs/state/job-state-machine.js';
import type { WorkerJobsQueryDto } from './dto/fulfilment.dto.js';
import { totalOf } from './job-access.js';

/** The worker's Activity screen only lists jobs the worker was actually given. */
const WORKER_TAB_STATUSES: Record<JobTab, JobStatus[]> = {
  ongoing: statusesOfTab('ongoing').filter((s) => s !== JobStatus.OPEN),
  completed: statusesOfTab('completed'),
  cancelled: statusesOfTab('cancelled'),
};

export interface WorkerJobItem {
  id: string;
  reference: string;
  title: string;
  status: JobStatus;
  category: { id: string; title: string };
  area: string;
  city: string;
  customerName: string;
  scheduledFor: string | null;
  /** The reserved window once the booking is confirmed. */
  bookedStartAt: string | null;
  bookedEndAt: string | null;
  /** Items so far (visit fee, then parts and labour); the final amount once paid. */
  total: number;
  createdAt: string;
}

export interface PendingQuote {
  offerId: string;
  jobId: string;
  reference: string;
  title: string;
  visitFee: number;
  etaMinutes: number;
  scheduledFor: string | null;
  createdAt: string;
}

export interface WorkerJobsPage {
  items: WorkerJobItem[];
  nextCursor: string | null;
  meta: { counts: Record<JobTab, number> };
  /** Ongoing tab, first page only: quotes the customer has not answered yet (flagged apart from jobs). */
  pendingQuotes?: PendingQuote[];
}

const DEFAULT_LIMIT = 20;
const PENDING_QUOTES_CAP = 50;

@Injectable()
export class WorkerJobsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(
    workerId: string,
    query: WorkerJobsQueryDto,
  ): Promise<WorkerJobsPage> {
    const tab = query.tab ?? 'ongoing';
    const limit = query.limit ?? DEFAULT_LIMIT;
    const after = query.cursor ? decodeKeyset(query.cursor) : undefined;

    const rows = await this.prisma.job.findMany({
      where: {
        workerId,
        status: { in: WORKER_TAB_STATUSES[tab] },
        ...(after
          ? {
              OR: [
                { createdAt: { lt: after.at } },
                { createdAt: after.at, id: { lt: after.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      include: {
        area: { include: { city: true } },
        category: { select: { id: true, titleEn: true } },
        customer: { select: { fullName: true } },
        billItems: { select: { amount: true } },
      },
    });

    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    const result: WorkerJobsPage = {
      items: page.map((job) => ({
        id: job.id,
        reference: referenceOf(job.jobNumber),
        title: job.title,
        status: job.status,
        category: { id: job.category.id, title: job.category.titleEn },
        area: job.area.name,
        city: job.area.city.name,
        customerName: job.customer.fullName,
        scheduledFor: job.scheduledFor?.toISOString() ?? null,
        bookedStartAt: job.bookedStartAt?.toISOString() ?? null,
        bookedEndAt: job.bookedEndAt?.toISOString() ?? null,
        total: totalOf(job.billItems),
        createdAt: job.createdAt.toISOString(),
      })),
      nextCursor:
        rows.length > limit && last
          ? encodeKeyset(last.createdAt, last.id)
          : null,
      meta: { counts: await this.counts(workerId) },
    };
    if (tab === 'ongoing' && !after)
      result.pendingQuotes = await this.pendingQuotes(workerId);
    return result;
  }

  private async pendingQuotes(workerId: string): Promise<PendingQuote[]> {
    const offers = await this.prisma.offer.findMany({
      where: {
        workerId,
        status: OfferStatus.PENDING,
        job: { status: JobStatus.OPEN },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: PENDING_QUOTES_CAP,
      include: {
        job: {
          select: {
            id: true,
            jobNumber: true,
            title: true,
            scheduledFor: true,
          },
        },
      },
    });
    return offers.map((o) => ({
      offerId: o.id,
      jobId: o.job.id,
      reference: referenceOf(o.job.jobNumber),
      title: o.job.title,
      visitFee: o.visitFee,
      etaMinutes: o.etaMinutes,
      scheduledFor: o.job.scheduledFor?.toISOString() ?? null,
      createdAt: o.createdAt.toISOString(),
    }));
  }

  private async counts(workerId: string): Promise<Record<JobTab, number>> {
    const grouped = await this.prisma.job.groupBy({
      by: ['status'],
      where: { workerId },
      _count: { _all: true },
    });
    const counts: Record<JobTab, number> = {
      ongoing: 0,
      completed: 0,
      cancelled: 0,
    };
    for (const row of grouped) counts[tabOf(row.status)] += row._count._all;
    return counts;
  }
}
