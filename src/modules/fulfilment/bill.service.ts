import { Injectable } from '@nestjs/common';
import { AppException } from '../../common/exceptions/app.exception.js';
import {
  BillItemKind,
  JobMediaKind,
  JobStatus,
} from '../../generated/prisma/enums.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { JobEventsService } from '../jobs/job-events.service.js';
import { transition } from '../jobs/state/job-state-machine.js';
import { MediaPurpose } from '../media/media-rules.js';
import { MediaService } from '../media/media.service.js';
import {
  MAX_WORK_PHOTOS_PER_KIND,
  type ApproveBillDto,
  type PutBillItemsDto,
  type WorkPhotoDto,
} from './dto/fulfilment.dto.js';
import {
  IN_SERVICE_STATUSES,
  explainFailedClaim,
  jobNotFound,
  totalOf,
} from './job-access.js';

export interface BillItemView {
  id: string;
  kind: BillItemKind;
  description: string;
  amount: number;
}

export interface BillView {
  jobId: string;
  status: JobStatus;
  items: BillItemView[];
  /** KaamConnect never takes a cut (BR-1). */
  platformFee: 0;
  total: number;
  /** True once the customer has approved the cost; the items are then frozen. */
  approved: boolean;
  /** Who to pay. The app builds the UPI QR from this; the platform never moves money (BR-2). */
  payTo: { name: string; upiId: string | null };
}

/**
 * The itemised bill: the worker proposes extra items after inspecting, the customer approves the total
 * they were shown, and from then on it is frozen. The visit fee line is created when the quote is accepted.
 */
@Injectable()
export class BillService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: JobEventsService,
    private readonly media: MediaService,
  ) {}

  /** Both parties, and nobody else. */
  async get(userId: string, jobId: string): Promise<BillView> {
    const job = await this.prisma.job.findFirst({
      where: {
        id: jobId,
        OR: [{ customerId: userId }, { workerId: userId }],
      },
      select: {
        id: true,
        status: true,
        costApprovedAt: true,
        worker: { select: { fullName: true, upiId: true } },
        billItems: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
      },
    });
    if (!job) throw jobNotFound();
    const worker = job.worker;
    const hasBill =
      !!worker &&
      (IN_SERVICE_STATUSES.includes(job.status) ||
        job.status === JobStatus.COMPLETED);
    if (!hasBill || !worker) {
      throw new AppException(
        'BILL_NOT_AVAILABLE',
        409,
        'There is no bill until a worker has been chosen',
      );
    }
    return {
      jobId: job.id,
      status: job.status,
      items: job.billItems.map((i) => ({
        id: i.id,
        kind: i.kind,
        description: i.description,
        amount: i.amount,
      })),
      platformFee: 0,
      total: totalOf(job.billItems),
      approved: job.costApprovedAt !== null,
      payTo: { name: worker.fullName, upiId: worker.upiId },
    };
  }

  /** Replaces the worker's items (parts, labour, other) while the job is ARRIVED and not yet approved. */
  async putItems(
    workerId: string,
    jobId: string,
    dto: PutBillItemsDto,
  ): Promise<BillView> {
    const customerId = await this.prisma.$transaction(async (tx) => {
      // The conditional update is also the row lock: an approval running at the same moment waits for
      // this edit to commit and then sees the new items, or finds the job already approved and we fail.
      const claimed = await tx.job.updateMany({
        where: { id: jobId, workerId, status: JobStatus.ARRIVED },
        data: { updatedAt: new Date() },
      });
      if (claimed.count !== 1)
        return explainFailedClaim(tx, jobId, { workerId });

      await tx.billItem.deleteMany({
        where: { jobId, kind: { not: BillItemKind.VISIT_FEE } },
      });
      if (dto.items.length > 0) {
        await tx.billItem.createMany({
          data: dto.items.map((item) => ({
            jobId,
            kind: item.kind,
            description: item.description,
            amount: item.amount,
          })),
        });
      }
      return (
        await tx.job.findUniqueOrThrow({
          where: { id: jobId },
          select: { customerId: true },
        })
      ).customerId;
    });

    const bill = await this.get(workerId, jobId);
    this.events.billUpdated(customerId, jobId, bill.total);
    return bill;
  }

  /** The customer approves the cost they were shown: ARRIVED -> IN_PROGRESS, and the items freeze. */
  async approve(
    customerId: string,
    jobId: string,
    dto: ApproveBillDto,
  ): Promise<BillView> {
    const existing = await this.prisma.job.findFirst({
      where: { id: jobId, customerId },
      select: { status: true },
    });
    if (!existing) throw jobNotFound();
    transition('APPROVE_BILL', existing.status);

    await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.job.updateMany({
        where: { id: jobId, customerId, status: JobStatus.ARRIVED },
        data: { status: JobStatus.IN_PROGRESS, costApprovedAt: new Date() },
      });
      if (claimed.count !== 1)
        return explainFailedClaim(tx, jobId, { customerId });

      // We hold the row now, so no edit can change the items under us.
      const items = await tx.billItem.findMany({ where: { jobId } });
      if (totalOf(items) !== dto.expectedTotal) {
        throw new AppException(
          'BILL_CHANGED',
          409,
          'The bill changed. Review the new total before approving.',
          [
            {
              field: 'expectedTotal',
              issue: `the bill is now ${totalOf(items)}`,
            },
          ],
        );
      }
    });

    const job = await this.prisma.job.findUniqueOrThrow({
      where: { id: jobId },
      select: {
        id: true,
        status: true,
        customerId: true,
        workerId: true,
        targetWorkerId: true,
      },
    });
    this.events.statusChanged(job);
    return this.get(customerId, jobId);
  }

  /** "Before" and "after" pictures from the assigned worker, while they are on site. */
  async addPhoto(
    workerId: string,
    jobId: string,
    dto: WorkPhotoDto,
  ): Promise<{ before: string[]; after: string[] }> {
    const job = await this.prisma.job.findFirst({
      where: { id: jobId, workerId },
      select: { status: true },
    });
    if (!job) throw jobNotFound();
    if (
      job.status !== JobStatus.ARRIVED &&
      job.status !== JobStatus.IN_PROGRESS
    ) {
      throw new AppException(
        'INVALID_TRANSITION',
        409,
        `Photos can only be added while you are on site, not while the job is ${job.status}`,
      );
    }
    await this.media.assertOwnedUpload(
      workerId,
      MediaPurpose.WORK_PROOF,
      dto.key,
      'key',
    );

    const kind =
      dto.kind === 'BEFORE'
        ? JobMediaKind.BEFORE_PHOTO
        : JobMediaKind.AFTER_PHOTO;
    await this.prisma.$transaction(async (tx) => {
      // Serialise photo uploads for one job so the per-kind limit holds under parallel requests.
      await tx.job.updateMany({
        where: { id: jobId, workerId },
        data: { updatedAt: new Date() },
      });
      const already = await tx.jobMedia.findMany({
        where: { jobId, kind },
        select: { storageKey: true },
      });
      if (already.some((m) => m.storageKey === dto.key)) return; // same upload sent twice
      if (already.length >= MAX_WORK_PHOTOS_PER_KIND) {
        throw new AppException(
          'PHOTO_LIMIT',
          409,
          `At most ${MAX_WORK_PHOTOS_PER_KIND} ${dto.kind.toLowerCase()} photos`,
        );
      }
      await tx.jobMedia.create({
        data: { jobId, kind, storageKey: dto.key },
      });
    });

    const rows = await this.prisma.jobMedia.findMany({
      where: {
        jobId,
        kind: { in: [JobMediaKind.BEFORE_PHOTO, JobMediaKind.AFTER_PHOTO] },
      },
      orderBy: { createdAt: 'asc' },
    });
    const urls = async (k: JobMediaKind) =>
      (
        await Promise.all(
          rows
            .filter((r) => r.kind === k)
            .map((r) =>
              this.media.readUrl(MediaPurpose.WORK_PROOF, r.storageKey),
            ),
        )
      ).filter((u): u is string => u !== null);
    return {
      before: await urls(JobMediaKind.BEFORE_PHOTO),
      after: await urls(JobMediaKind.AFTER_PHOTO),
    };
  }
}
