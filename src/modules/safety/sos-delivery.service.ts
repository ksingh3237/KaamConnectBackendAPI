import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Prisma } from '../../generated/prisma/client.js';
import { SosStatus } from '../../generated/prisma/enums.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { SafetyNotifier, type SosNotification } from './safety-notifier.js';

/** After this many failed tries the alert is left for a human (logged loudly); it is never lost. */
export const SOS_MAX_DELIVERY_ATTEMPTS = 10;
const BASE_DELAY_MS = 30_000;
const MAX_DELAY_MS = 10 * 60_000;
/** How many undelivered alerts one sweep handles; the next sweep picks up the rest. */
const BATCH = 50;

/**
 * How long to wait before the next try, given how many tries have already failed:
 * 30 s, 1 min, 2 min, 4 min ... capped at 10 min. An emergency is retried often, but a dead desk is not hammered.
 */
export function retryDelayMs(failedAttempts: number): number {
  if (failedAttempts <= 0) return 0;
  return Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** (failedAttempts - 1));
}

/**
 * Gets a stored SOS alert to the safety desk and remembers whether that worked.
 *
 * The alert row is written first (SosService). Delivery then happens right away and, if it fails, again from a
 * sweep every 30 seconds until the desk confirms receipt (the webhook answers 2xx) or the tries run out. Every try is
 * claimed with a conditional update, so several instances never send the same try twice.
 */
@Injectable()
export class SosDeliveryService {
  private readonly logger = new Logger(SosDeliveryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifier: SafetyNotifier,
  ) {}

  /** Tries once. Returns true when the desk has the alert (now or already). Never throws. */
  async deliver(alertId: string): Promise<boolean> {
    const alert = await this.prisma.sosAlert.findUnique({
      where: { id: alertId },
      select: {
        deliveredAt: true,
        deliveryAttempts: true,
        payload: true,
        status: true,
      },
    });
    if (!alert) return false;
    if (alert.deliveredAt) return true;
    if (alert.payload === null) return false; // an alert from before delivery tracking: nothing to send

    // Claim this attempt: only one caller can move the counter from the value it read.
    const claimed = await this.prisma.sosAlert.updateMany({
      where: {
        id: alertId,
        deliveredAt: null,
        deliveryAttempts: alert.deliveryAttempts,
      },
      data: {
        deliveryAttempts: { increment: 1 },
        lastAttemptAt: new Date(),
      },
    });
    if (claimed.count !== 1) return false; // someone else is sending it

    const attempt = alert.deliveryAttempts + 1;
    try {
      await this.notifier.notify(alert.payload as unknown as SosNotification);
      await this.prisma.sosAlert.update({
        where: { id: alertId },
        data: { deliveredAt: new Date(), lastDeliveryError: null },
      });
      if (attempt > 1)
        this.logger.log(`SOS ${alertId} delivered on attempt ${attempt}`);
      return true;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await this.prisma.sosAlert
        .update({
          where: { id: alertId },
          data: { lastDeliveryError: reason.slice(0, 200) },
        })
        .catch(() => undefined);
      if (attempt >= SOS_MAX_DELIVERY_ATTEMPTS) {
        this.logger.error(
          `SOS ${alertId} could NOT be delivered after ${attempt} attempts (${reason}). It is stored: handle it by hand.`,
        );
      } else {
        this.logger.error(
          `SOS ${alertId} delivery attempt ${attempt} failed (${reason}); retrying in ${Math.round(retryDelayMs(attempt) / 1000)} s`,
        );
      }
      return false;
    }
  }

  @Cron(CronExpression.EVERY_30_SECONDS)
  async scheduled(): Promise<void> {
    try {
      const retried = await this.retryUndelivered();
      if (retried > 0) this.logger.log(`Retried ${retried} undelivered SOS`);
    } catch (error) {
      this.logger.error(
        `SOS retry sweep failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** One sweep: tries every still-open alert whose back-off has passed. Returns how many it tried. */
  async retryUndelivered(now: Date = new Date()): Promise<number> {
    const where: Prisma.SosAlertWhereInput = {
      deliveredAt: null,
      payload: { not: Prisma.DbNull },
      deliveryAttempts: { lt: SOS_MAX_DELIVERY_ATTEMPTS }, // 0 = the process stopped before the first try
      status: SosStatus.OPEN, // a human who already took it on needs no more pushes
    };
    const candidates = await this.prisma.sosAlert.findMany({
      where,
      orderBy: { createdAt: 'asc' },
      take: BATCH,
      select: { id: true, deliveryAttempts: true, lastAttemptAt: true },
    });

    let tried = 0;
    for (const c of candidates) {
      const waitedMs = c.lastAttemptAt
        ? now.getTime() - c.lastAttemptAt.getTime()
        : Number.POSITIVE_INFINITY;
      if (waitedMs < retryDelayMs(c.deliveryAttempts)) continue;
      tried += 1;
      await this.deliver(c.id);
    }
    return tried;
  }
}
