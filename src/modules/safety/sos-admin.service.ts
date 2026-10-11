import { Injectable, Logger } from '@nestjs/common';
import { AppException } from '../../common/exceptions/app.exception.js';
import { referenceOf } from '../../common/utils/reference.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { SosStatus } from '../../generated/prisma/enums.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { RealtimeEvent } from '../realtime/events.js';
import { RealtimePublisher } from '../realtime/realtime-publisher.js';

export interface AdminSosItem {
  alertId: string;
  status: SosStatus;
  raisedAt: string;
  jobId: string | null;
  jobReference: string | null;
  raisedBy: {
    id: string;
    role: 'CUSTOMER' | 'WORKER' | null;
    name: string | null;
    phone: string;
  };
  location: { lat: number; lng: number } | null;
  delivery: {
    delivered: boolean;
    attempts: number;
    lastAttemptAt: string | null;
    lastError: string | null;
  };
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
  resolvedAt: string | null;
  resolvedBy: string | null;
}

const alertInclude = {
  user: { select: { phone: true } },
  job: {
    select: {
      jobNumber: true,
      customerId: true,
      workerId: true,
      customer: { select: { fullName: true } },
      worker: { select: { fullName: true } },
    },
  },
} satisfies Prisma.SosAlertInclude;

type AlertRow = Prisma.SosAlertGetPayload<{ include: typeof alertInclude }>;

function toItem(r: AlertRow): AdminSosItem {
  const asCustomer = r.job?.customerId === r.userId;
  const asWorker = r.job?.workerId === r.userId;
  return {
    alertId: r.id,
    status: r.status,
    raisedAt: r.createdAt.toISOString(),
    jobId: r.jobId,
    jobReference: r.job ? referenceOf(r.job.jobNumber) : null,
    raisedBy: {
      id: r.userId,
      role: asCustomer ? 'CUSTOMER' : asWorker ? 'WORKER' : null,
      name: asCustomer
        ? (r.job?.customer.fullName ?? null)
        : asWorker
          ? (r.job?.worker?.fullName ?? null)
          : null,
      phone: r.user.phone,
    },
    location:
      r.lat !== null && r.lng !== null ? { lat: r.lat, lng: r.lng } : null,
    delivery: {
      delivered: r.deliveredAt !== null,
      attempts: r.deliveryAttempts,
      lastAttemptAt: r.lastAttemptAt?.toISOString() ?? null,
      lastError: r.lastDeliveryError,
    },
    acknowledgedAt: r.acknowledgedAt?.toISOString() ?? null,
    acknowledgedBy: r.acknowledgedById,
    resolvedAt: r.resolvedAt?.toISOString() ?? null,
    resolvedBy: r.resolvedById,
  };
}

/** The safety desk's side: see alerts, say "I have it", say "it is closed". Both steps are idempotent. */
@Injectable()
export class SosAdminService {
  private readonly logger = new Logger(SosAdminService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly publisher: RealtimePublisher,
  ) {}

  async list(
    status: SosStatus | undefined,
    limit: number,
  ): Promise<{ items: AdminSosItem[] }> {
    const rows = await this.prisma.sosAlert.findMany({
      where: status ? { status } : {},
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: alertInclude,
    });
    return { items: rows.map(toItem) };
  }

  /** OPEN -> ACKNOWLEDGED. Repeating it, or acknowledging something already resolved, changes nothing. */
  async acknowledge(adminId: string, alertId: string): Promise<AdminSosItem> {
    await this.mustExist(alertId);
    const changed = await this.prisma.sosAlert.updateMany({
      where: { id: alertId, status: SosStatus.OPEN },
      data: {
        status: SosStatus.ACKNOWLEDGED,
        acknowledgedAt: new Date(),
        acknowledgedById: adminId,
      },
    });
    if (changed.count === 1) {
      this.logger.warn(`SOS ${alertId} acknowledged by admin ${adminId}`);
      await this.tellRaiser(alertId, RealtimeEvent.SOS_ACKNOWLEDGED);
    }
    return this.one(alertId);
  }

  /** OPEN or ACKNOWLEDGED -> RESOLVED (a desk that resolves straight away is acknowledged at the same moment). */
  async resolve(adminId: string, alertId: string): Promise<AdminSosItem> {
    await this.mustExist(alertId);
    const now = new Date();
    const changed = await this.prisma.$transaction(async (tx) => {
      // A straight "resolve" still records who took it on.
      await tx.sosAlert.updateMany({
        where: { id: alertId, status: SosStatus.OPEN },
        data: {
          status: SosStatus.ACKNOWLEDGED,
          acknowledgedAt: now,
          acknowledgedById: adminId,
        },
      });
      return tx.sosAlert.updateMany({
        where: { id: alertId, status: SosStatus.ACKNOWLEDGED },
        data: {
          status: SosStatus.RESOLVED,
          resolvedAt: now,
          resolvedById: adminId,
        },
      });
    });
    if (changed.count === 1) {
      this.logger.warn(`SOS ${alertId} resolved by admin ${adminId}`);
      await this.tellRaiser(alertId, RealtimeEvent.SOS_RESOLVED);
    }
    return this.one(alertId);
  }

  private async mustExist(alertId: string): Promise<void> {
    const found = await this.prisma.sosAlert.findUnique({
      where: { id: alertId },
      select: { id: true },
    });
    if (!found) throw new AppException('NOT_FOUND', 404, 'Alert not found');
  }

  private async one(alertId: string): Promise<AdminSosItem> {
    return toItem(
      await this.prisma.sosAlert.findUniqueOrThrow({
        where: { id: alertId },
        include: alertInclude,
      }),
    );
  }

  private async tellRaiser(alertId: string, event: string): Promise<void> {
    const alert = await this.prisma.sosAlert.findUnique({
      where: { id: alertId },
      select: {
        userId: true,
        status: true,
        acknowledgedAt: true,
        resolvedAt: true,
        jobId: true,
      },
    });
    if (!alert) return;
    this.publisher.toUser(alert.userId, event, {
      alertId,
      jobId: alert.jobId,
      status: alert.status,
      acknowledgedAt: alert.acknowledgedAt?.toISOString() ?? null,
      resolvedAt: alert.resolvedAt?.toISOString() ?? null,
    });
  }
}
