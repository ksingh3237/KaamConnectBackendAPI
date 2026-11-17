import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { EnvVars } from '../../config/env.validation.js';
import { decodeKeyset, encodeKeyset } from '../../common/utils/keyset.js';
import { placeName } from '../../common/utils/place.js';
import { referenceOf } from '../../common/utils/reference.js';
import { JobStatus, type PaymentMethod } from '../../generated/prisma/enums.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { istRange, type EarningsPeriod } from './ist-time.js';

export interface Earnings {
  period: EarningsPeriod | 'all';
  /**
   * The IST period as a half-open range in UTC, so the app can show exactly what was counted. For `all`: from the
   * start of time (1970) to the moment of the request.
   */
  from: string;
  to: string;
  timezone: 'Asia/Kolkata';
  /** Sum of the bills of jobs completed (paid) in the period. Tips are recorded separately and not included. */
  amount: number;
  jobsDone: number;
  /** KaamConnect takes nothing (BR-1). */
  platformFee: 0;
  currency: 'INR';
}

export interface Savings {
  /** What the same jobs would have cost in commission at the benchmark rate. A comparison, not money we hold. */
  commissionSaved: number;
  /** Disclosed so the app can say what the figure is based on (decision D-5). */
  benchmarkRate: number;
  currency: 'INR';
  role: 'customer' | 'worker';
  /** The bills the figure is computed from. */
  jobsCount: number;
  jobsTotal: number;
}

/** One paid job in the Wallet: what the worker was paid for it and when. */
export interface EarningJob {
  jobId: string;
  reference: string;
  title: string;
  category: { id: string; title: { en: string; hi: string; pa: string } };
  customerName: string;
  area: string;
  /** When the job reached COMPLETED (payment recorded): the moment it counts towards the periods above. */
  completedAt: string;
  /** The amount paid (the whole bill; KaamConnect takes nothing). Tips are not included. */
  amount: number;
  method: PaymentMethod;
}

export interface EarningJobsPage {
  items: EarningJob[];
  nextCursor: string | null;
}

const DEFAULT_JOBS_LIMIT = 20;

/** Whole rupees; commission is never shown with paise. */
export function commissionOn(total: number, rate: number): number {
  return Math.round(total * rate);
}

@Injectable()
export class EarningsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<EnvVars, true>,
  ) {}

  /** What the worker earned in the IST period: only jobs that reached COMPLETED (payment recorded). */
  async earnings(
    workerId: string,
    period: EarningsPeriod | 'all' = 'today',
    now: Date = new Date(),
  ): Promise<Earnings> {
    const { from, to } =
      period === 'all' ? { from: new Date(0), to: now } : istRange(period, now);
    const totals = await this.prisma.payment.aggregate({
      where: {
        job: {
          workerId,
          status: JobStatus.COMPLETED,
          completedAt: { gte: from, lt: to },
        },
      },
      _sum: { amount: true },
      _count: { _all: true },
    });
    return {
      period,
      from: from.toISOString(),
      to: to.toISOString(),
      timezone: 'Asia/Kolkata',
      amount: totals._sum.amount ?? 0,
      jobsDone: totals._count._all,
      platformFee: 0,
      currency: 'INR',
    };
  }

  /**
   * The Wallet's job list: the worker's paid (COMPLETED) jobs, most recently paid first, the same jobs and amounts the
   * totals above add up. Keyset paging on (completedAt, id).
   */
  async paidJobs(
    workerId: string,
    query: { limit?: number; cursor?: string },
  ): Promise<EarningJobsPage> {
    const limit = query.limit ?? DEFAULT_JOBS_LIMIT;
    const after = query.cursor ? decodeKeyset(query.cursor) : undefined;
    const rows = await this.prisma.job.findMany({
      where: {
        workerId,
        status: JobStatus.COMPLETED,
        completedAt: { not: null },
        payment: { isNot: null },
        ...(after
          ? {
              OR: [
                { completedAt: { lt: after.at } },
                { completedAt: after.at, id: { lt: after.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ completedAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      select: {
        id: true,
        jobNumber: true,
        title: true,
        completedAt: true,
        localityName: true,
        area: { select: { name: true } },
        category: {
          select: { id: true, titleEn: true, titleHi: true, titlePa: true },
        },
        customer: { select: { fullName: true } },
        payment: { select: { amount: true, method: true } },
      },
    });
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map((job) => ({
        jobId: job.id,
        reference: referenceOf(job.jobNumber),
        title: job.title,
        category: {
          id: job.category.id,
          title: {
            en: job.category.titleEn,
            hi: job.category.titleHi,
            pa: job.category.titlePa,
          },
        },
        customerName: job.customer.fullName,
        area: placeName(job.localityName, job.area.name),
        completedAt: job.completedAt!.toISOString(),
        amount: job.payment!.amount,
        method: job.payment!.method,
      })),
      nextCursor:
        rows.length > limit && last?.completedAt
          ? encodeKeyset(last.completedAt, last.id)
          : null,
    };
  }

  /** "0% Commission Charter Savings": the paid bills of finished jobs times the benchmark rate (BR-11). */
  async savings(
    userId: string,
    requested: 'customer' | 'worker' | undefined,
  ): Promise<Savings> {
    const role = requested ?? (await this.defaultRole(userId));
    const totals = await this.prisma.payment.aggregate({
      where: {
        job: {
          status: JobStatus.COMPLETED,
          ...(role === 'customer'
            ? { customerId: userId }
            : { workerId: userId }),
        },
      },
      _sum: { amount: true },
      _count: { _all: true },
    });
    const jobsTotal = totals._sum.amount ?? 0;
    const benchmarkRate = this.config.get('COMMISSION_BENCHMARK_RATE', {
      infer: true,
    });
    return {
      commissionSaved: commissionOn(jobsTotal, benchmarkRate),
      benchmarkRate,
      currency: 'INR',
      role,
      jobsCount: totals._count._all,
      jobsTotal,
    };
  }

  private async defaultRole(userId: string): Promise<'customer' | 'worker'> {
    const customer = await this.prisma.customerProfile.findUnique({
      where: { userId },
      select: { userId: true },
    });
    if (customer) return 'customer';
    const worker = await this.prisma.workerProfile.findUnique({
      where: { userId },
      select: { userId: true },
    });
    return worker ? 'worker' : 'customer';
  }
}
