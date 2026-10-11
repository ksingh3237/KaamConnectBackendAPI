import { Injectable } from '@nestjs/common';
import { AppException } from '../../common/exceptions/app.exception.js';
import { referenceOf } from '../../common/utils/reference.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { SosStatus } from '../../generated/prisma/enums.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { IN_SERVICE_STATUSES, jobNotFound } from '../fulfilment/job-access.js';
import type { SosDto } from '../fulfilment/dto/fulfilment.dto.js';
import type { SosNotification } from './safety-notifier.js';
import { SosDeliveryService } from './sos-delivery.service.js';

/** A second tap within this long returns the first alert instead of paging the desk again. */
const REPEAT_WINDOW_MS = 60_000;

/** What the person who raised an alert can see about it. */
export interface SosStatusView {
  alertId: string;
  status: SosStatus;
  raisedAt: string;
  /** True once the safety desk has confirmed it received the alert. */
  delivered: boolean;
  acknowledgedAt: string | null;
  resolvedAt: string | null;
}

export interface SosRaised extends SosStatusView {
  /** True when this tap returned an alert raised a moment ago instead of creating a new one. */
  repeated: boolean;
}

const viewOf = (a: {
  id: string;
  status: SosStatus;
  createdAt: Date;
  deliveredAt: Date | null;
  acknowledgedAt: Date | null;
  resolvedAt: Date | null;
}): SosStatusView => ({
  alertId: a.id,
  status: a.status,
  raisedAt: a.createdAt.toISOString(),
  delivered: a.deliveredAt !== null,
  acknowledgedAt: a.acknowledgedAt?.toISOString() ?? null,
  resolvedAt: a.resolvedAt?.toISOString() ?? null,
});

/**
 * The SOS button on the tracking screen. Either person on a job can raise it while the worker is
 * assigned or on site. The alert is stored before anyone is told, so a failed webhook can never lose it; delivery is
 * then tracked and retried (SosDeliveryService) until the safety desk confirms it, and a person at the desk
 * acknowledges and resolves it (SosAdminService).
 */
@Injectable()
export class SosService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly delivery: SosDeliveryService,
  ) {}

  async raise(userId: string, jobId: string, dto: SosDto): Promise<SosRaised> {
    if ((dto.lat === undefined) !== (dto.lng === undefined)) {
      throw new AppException(
        'VALIDATION_FAILED',
        422,
        'Request validation failed',
        [{ field: 'lat', issue: 'send both lat and lng, or neither' }],
      );
    }

    const job = await this.prisma.job.findFirst({
      where: {
        id: jobId,
        OR: [{ customerId: userId }, { workerId: userId }],
      },
      include: {
        area: { include: { city: true } },
        customer: {
          select: { fullName: true, user: { select: { phone: true } } },
        },
        worker: {
          select: {
            fullName: true,
            user: { select: { phone: true } },
            location: true,
          },
        },
      },
    });
    if (!job) throw jobNotFound();
    if (!job.worker || !IN_SERVICE_STATUSES.includes(job.status)) {
      throw new AppException(
        'SOS_NOT_AVAILABLE',
        409,
        'SOS is available while a worker is assigned to the job',
      );
    }

    const recent = await this.prisma.sosAlert.findFirst({
      where: {
        userId,
        jobId,
        createdAt: { gt: new Date(Date.now() - REPEAT_WINDOW_MS) },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (recent) return { ...viewOf(recent), repeated: true };

    const asCustomer = job.customerId === userId;
    // Where: what the phone sent; failing that, for a worker, their last stored fix (labelled as such).
    const fix = !asCustomer ? job.worker.location : null;
    const location: SosNotification['location'] =
      dto.lat !== undefined && dto.lng !== undefined
        ? { lat: dto.lat, lng: dto.lng, source: 'REPORTED' }
        : fix
          ? {
              lat: fix.lat,
              lng: fix.lng,
              source: 'LAST_WORKER_FIX',
              fixAgeSec: Math.round(
                (Date.now() - fix.updatedAt.getTime()) / 1000,
              ),
            }
          : null;

    const customer = {
      role: 'CUSTOMER' as const,
      name: job.customer.fullName,
      phone: job.customer.user.phone,
    };
    const worker = {
      role: 'WORKER' as const,
      name: job.worker.fullName,
      phone: job.worker.user.phone,
    };

    // The alert and exactly what the desk is told are stored together, so a retry later sends the same thing.
    const alert = await this.prisma.$transaction(async (tx) => {
      const created = await tx.sosAlert.create({
        data: {
          userId,
          jobId,
          lat: location?.lat ?? null,
          lng: location?.lng ?? null,
          status: SosStatus.OPEN,
        },
      });
      const notification: SosNotification = {
        alertId: created.id,
        jobReference: referenceOf(job.jobNumber),
        jobStatus: job.status,
        raisedAt: created.createdAt.toISOString(),
        raisedBy: asCustomer ? customer : worker,
        otherParty: asCustomer ? worker : customer,
        location,
        address: {
          line: job.addressLine,
          area: job.area.name,
          city: job.area.city.name,
        },
      };
      return tx.sosAlert.update({
        where: { id: created.id },
        data: { payload: notification as unknown as Prisma.InputJsonValue },
      });
    });

    // Best effort and never throws: the person in trouble is told the alert is stored whatever the desk's state.
    await this.delivery.deliver(alert.id);
    const latest = await this.prisma.sosAlert.findUniqueOrThrow({
      where: { id: alert.id },
    });
    return { ...viewOf(latest), repeated: false };
  }

  /** The caller's own alerts on this job, newest first, so the app can show "sent / received / being handled". */
  async statusFor(userId: string, jobId: string): Promise<SosStatusView[]> {
    const job = await this.prisma.job.findFirst({
      where: {
        id: jobId,
        OR: [{ customerId: userId }, { workerId: userId }],
      },
      select: { id: true },
    });
    if (!job) throw jobNotFound();
    const alerts = await this.prisma.sosAlert.findMany({
      where: { jobId, userId },
      orderBy: { createdAt: 'desc' },
      take: 10,
    });
    return alerts.map(viewOf);
  }
}
