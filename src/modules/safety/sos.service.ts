import { Injectable, Logger } from '@nestjs/common';
import { AppException } from '../../common/exceptions/app.exception.js';
import { referenceOf } from '../../common/utils/reference.js';
import { SosStatus } from '../../generated/prisma/enums.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { IN_SERVICE_STATUSES, jobNotFound } from '../fulfilment/job-access.js';
import type { SosDto } from '../fulfilment/dto/fulfilment.dto.js';
import { SafetyNotifier, type SosNotification } from './safety-notifier.js';

/** A second tap within this long returns the first alert instead of paging the desk again. */
const REPEAT_WINDOW_MS = 60_000;

/**
 * The SOS button on the tracking screen. Either person on a job can raise it while the worker is
 * assigned or on site. The alert is stored before anyone is told, so a failed webhook can never lose it.
 */
@Injectable()
export class SosService {
  private readonly logger = new Logger(SosService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifier: SafetyNotifier,
  ) {}

  async raise(
    userId: string,
    jobId: string,
    dto: SosDto,
  ): Promise<{ alertId: string; repeated: boolean }> {
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
      select: { id: true },
    });
    if (recent) return { alertId: recent.id, repeated: true };

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

    const alert = await this.prisma.sosAlert.create({
      data: {
        userId,
        jobId,
        lat: location?.lat ?? null,
        lng: location?.lng ?? null,
        status: SosStatus.OPEN,
      },
    });

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
    try {
      await this.notifier.notify({
        alertId: alert.id,
        jobReference: referenceOf(job.jobNumber),
        jobStatus: job.status,
        raisedAt: alert.createdAt.toISOString(),
        raisedBy: asCustomer ? customer : worker,
        otherParty: asCustomer ? worker : customer,
        location,
        address: {
          line: job.addressLine,
          area: job.area.name,
          city: job.area.city.name,
        },
      });
    } catch (error) {
      // The alert is safely stored; tell the operators loudly, never the person in trouble.
      this.logger.error(
        `SOS ${alert.id} was stored but the safety channel failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return { alertId: alert.id, repeated: false };
  }
}
