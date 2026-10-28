import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../prisma/prisma.service.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const READ_KEEP_DAYS = 30;
const ANY_KEEP_DAYS = 90;

/** Housekeeping so the inbox does not grow for ever. Safe to run on several instances. */
@Injectable()
export class NotificationsCleanupService {
  private readonly logger = new Logger(NotificationsCleanupService.name);

  constructor(private readonly prisma: PrismaService) {}

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async scheduledPurge(): Promise<void> {
    try {
      const deleted = await this.purge();
      this.logger.log(`Purged ${deleted} old inbox notification(s)`);
    } catch (error) {
      this.logger.error(
        `Inbox purge failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Read ones after 30 days; anything, read or not, after 90 days. A recent unread one is never touched. */
  async purge(now: Date = new Date()): Promise<number> {
    const readCutoff = new Date(now.getTime() - READ_KEEP_DAYS * DAY_MS);
    const anyCutoff = new Date(now.getTime() - ANY_KEEP_DAYS * DAY_MS);
    const r = await this.prisma.inAppNotification.deleteMany({
      where: {
        OR: [
          { isRead: true, createdAt: { lt: readCutoff } },
          { createdAt: { lt: anyCutoff } },
        ],
      },
    });
    return r.count;
  }
}
