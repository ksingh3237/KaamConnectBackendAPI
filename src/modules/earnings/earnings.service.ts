import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { EnvVars } from '../../config/env.validation.js';
import { JobStatus } from '../../generated/prisma/enums.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { istRange, type EarningsPeriod } from './ist-time.js';

export interface Earnings {
  period: EarningsPeriod;
  /** The IST period as a half-open range in UTC, so the app can show exactly what was counted. */
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
    period: EarningsPeriod = 'today',
    now: Date = new Date(),
  ): Promise<Earnings> {
    const { from, to } = istRange(period, now);
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
