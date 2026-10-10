import { Injectable } from '@nestjs/common';
import { AppException } from '../../common/exceptions/app.exception.js';
import { referenceOf } from '../../common/utils/reference.js';
import {
  BillItemKind,
  JobStatus,
  PaymentMethod,
} from '../../generated/prisma/enums.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { JobEventsService } from '../jobs/job-events.service.js';
import { transition } from '../jobs/state/job-state-machine.js';
import type { PaymentDto } from './dto/fulfilment.dto.js';
import { explainFailedClaim, jobNotFound, totalOf } from './job-access.js';

export interface PaymentView {
  jobId: string;
  status: JobStatus;
  receiptNo: string;
  method: PaymentMethod;
  /** Computed on the server from the bill; the app never sends an amount. */
  amount: number;
  platformFee: 0;
  markedAt: string;
}

export interface Receipt {
  receiptNo: string;
  date: string;
  jobTitle: string;
  customer: { name: string };
  worker: { name: string };
  items: { kind: BillItemKind; description: string; amount: number }[];
  platformFee: 0;
  total: number;
  method: PaymentMethod;
}

/**
 * The customer records that they paid the worker directly by UPI or cash (BR-2: we only record). The
 * amount is the bill total, always; a second call returns the first result unchanged.
 */
@Injectable()
export class PaymentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: JobEventsService,
  ) {}

  async pay(
    customerId: string,
    jobId: string,
    dto: PaymentDto,
  ): Promise<PaymentView> {
    const job = await this.prisma.job.findFirst({
      where: { id: jobId, customerId },
      include: { payment: true },
    });
    if (!job) throw jobNotFound();
    if (job.status === JobStatus.COMPLETED && job.payment)
      return toView(job.id, job.status, job.jobNumber, job.payment);
    transition('MARK_PAID', job.status); // 409 unless WORK_COMPLETED

    let created: { payment: PaymentRow } | null = null;
    try {
      created = await this.prisma.$transaction(async (tx) => {
        const claimed = await tx.job.updateMany({
          where: { id: jobId, customerId, status: JobStatus.WORK_COMPLETED },
          data: { status: JobStatus.COMPLETED, completedAt: new Date() },
        });
        if (claimed.count !== 1) throw new LostRace();
        const items = await tx.billItem.findMany({ where: { jobId } });
        const payment = await tx.payment.create({
          data: { jobId, method: dto.method, amount: totalOf(items) },
        });
        return { payment };
      });
    } catch (error) {
      if (!(error instanceof LostRace)) throw error;
    }

    if (!created) {
      // Someone else (a second tap) paid at the same moment: return what they recorded.
      const again = await this.prisma.job.findFirst({
        where: { id: jobId, customerId },
        include: { payment: true },
      });
      if (again?.payment)
        return toView(again.id, again.status, again.jobNumber, again.payment);
      return explainFailedClaim(this.prisma, jobId, { customerId });
    }

    const done = await this.prisma.job.findUniqueOrThrow({
      where: { id: jobId },
      select: {
        id: true,
        jobNumber: true,
        status: true,
        customerId: true,
        workerId: true,
        targetWorkerId: true,
      },
    });
    this.events.statusChanged(done);
    return toView(done.id, done.status, done.jobNumber, created.payment);
  }

  /** The customer or the worker of a finished job. */
  async receipt(userId: string, jobId: string): Promise<Receipt> {
    const job = await this.prisma.job.findFirst({
      where: {
        id: jobId,
        OR: [{ customerId: userId }, { workerId: userId }],
      },
      include: {
        payment: true,
        billItems: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
        customer: { select: { fullName: true } },
        worker: { select: { fullName: true } },
      },
    });
    if (!job) throw jobNotFound();
    if (job.status !== JobStatus.COMPLETED || !job.payment || !job.worker) {
      throw new AppException(
        'RECEIPT_NOT_AVAILABLE',
        409,
        'A receipt exists once the payment has been recorded',
      );
    }
    return {
      receiptNo: referenceOf(job.jobNumber),
      date: (job.completedAt ?? job.payment.markedAt).toISOString(),
      jobTitle: job.title,
      customer: { name: job.customer.fullName },
      worker: { name: job.worker.fullName },
      items: job.billItems.map((i) => ({
        kind: i.kind,
        description: i.description,
        amount: i.amount,
      })),
      platformFee: 0,
      total: job.payment.amount,
      method: job.payment.method,
    };
  }
}

type PaymentRow = { method: PaymentMethod; amount: number; markedAt: Date };

class LostRace extends Error {}

function toView(
  jobId: string,
  status: JobStatus,
  jobNumber: number,
  payment: PaymentRow,
): PaymentView {
  return {
    jobId,
    status,
    receiptNo: referenceOf(jobNumber),
    method: payment.method,
    amount: payment.amount,
    platformFee: 0,
    markedAt: payment.markedAt.toISOString(),
  };
}
