import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Messaging } from 'firebase-admin/messaging';
import { AppException } from '../../common/exceptions/app.exception.js';
import { decodeCursor, toPage, type Page } from '../../common/utils/cursor.js';
import type {
  DevicePlatform,
  Language,
  NotificationType,
} from '../../generated/prisma/enums.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { FIREBASE_MESSAGING } from './firebase.provider.js';
import { pushOptionsFor } from './push-alert.js';
import type { PushCopy } from './push-texts.js';
import { safeReason } from './redact.js';

const DEFAULT_LIMIT = 20;
/** FCM accepts at most 500 tokens per multicast. */
const FCM_BATCH = 500;
/** Error codes that mean the token will never work again; the row is removed. */
const DEAD_TOKEN_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
]);

const TITLE_MAX = 120;
const BODY_MAX = 300;

type DataValue = string | number | boolean;

export interface PushInput {
  title: string;
  body: string;
  type: NotificationType;
  /** Deep-link context (job id and the like). Never an address or a phone number. */
  data?: Record<string, DataValue>;
  /**
   * The same notification in Hindi and Punjabi (push-texts.ts). Each recipient gets the language they chose in the
   * app (`users.language`); `title` / `body` above are the English text. Without it everyone gets `title` / `body`.
   */
  translations?: Record<Exclude<Language, 'en'>, PushCopy>;
}

export interface NotificationItem {
  id: string;
  type: NotificationType;
  title: string;
  body: string;
  data: Record<string, unknown>;
  isRead: boolean;
  createdAt: string;
}

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(FIREBASE_MESSAGING) private readonly messaging: Messaging | null,
  ) {}

  // ───────────────────────── Sending (call AFTER the business transaction has committed) ─────────────────────────

  /** Inbox row plus a push to every active device of the user. Best effort: never throws. */
  sendPush(userId: string, input: PushInput): Promise<void> {
    return this.sendPushToMany([userId], input);
  }

  /** Same message to several users (one lead, many workers): one insert, one token lookup, batched FCM calls. */
  async sendPushToMany(
    userIds: readonly string[],
    input: PushInput,
  ): Promise<void> {
    const ids = [...new Set(userIds)];
    if (ids.length === 0) return;
    for (const group of await this.inTheirLanguage(ids, input))
      await this.deliver(group.ids, group.input);
  }

  /**
   * Splits the recipients by the language each one chose, with the text in that language. If the languages cannot be
   * read, everyone still gets the English text: a notification in the wrong language beats no notification.
   */
  private async inTheirLanguage(
    ids: string[],
    input: PushInput,
  ): Promise<{ ids: string[]; input: PushInput }[]> {
    const { translations, ...english } = input;
    if (!translations) return [{ ids, input: english }];
    let rows: { id: string; language: Language }[];
    try {
      rows = await this.prisma.user.findMany({
        where: { id: { in: ids } },
        select: { id: true, language: true },
      });
    } catch (error) {
      this.logger.error(
        `Could not read the language of ${ids.length} user(s) for ${input.type}: ${safeReason(error)}`,
      );
      return [{ ids, input: english }];
    }
    const languageOf = new Map(rows.map((r) => [r.id, r.language]));
    const groups = new Map<Language, string[]>();
    for (const id of ids) {
      const language = languageOf.get(id) ?? 'en';
      groups.set(language, [...(groups.get(language) ?? []), id]);
    }
    return [...groups].map(([language, members]) => ({
      ids: members,
      input:
        language === 'en' ? english : { ...english, ...translations[language] },
    }));
  }

  private async deliver(ids: string[], input: PushInput): Promise<void> {
    const message: PushInput = {
      ...input,
      // Column limits (VARCHAR 120 / 300): a long value must never cost the whole notification
      title: input.title.slice(0, TITLE_MAX),
      body: input.body.slice(0, BODY_MAX),
    };
    const data: Record<string, DataValue> = {
      type: message.type,
      ...message.data,
    };
    // The inbox and the phone push are independent: the failure of one must not suppress the other, and neither may
    // fail the business operation that triggered this (callers do not await the result).
    try {
      await this.prisma.inAppNotification.createMany({
        data: ids.map((userId) => ({
          userId,
          type: message.type,
          title: message.title,
          body: message.body,
          data,
        })),
      });
    } catch (error) {
      this.logger.error(
        `Could not save ${ids.length} inbox notification(s) of ${message.type}: ${safeReason(error)}`,
      );
    }
    try {
      await this.dispatch(ids, message, data);
    } catch (error) {
      this.logger.error(
        `Could not push ${message.type} to ${ids.length} user(s): ${safeReason(error)}`,
      );
    }
  }

  private async dispatch(
    userIds: string[],
    input: PushInput,
    data: Record<string, DataValue>,
  ): Promise<void> {
    if (!this.messaging) return;
    const tokens = await this.prisma.deviceToken.findMany({
      where: { userId: { in: userIds }, isActive: true },
      select: { token: true },
    });
    if (tokens.length === 0) return;

    // FCM data values must all be strings.
    const stringData = Object.fromEntries(
      Object.entries(data).map(([k, v]) => [k, String(v)]),
    );
    for (let i = 0; i < tokens.length; i += FCM_BATCH) {
      const batch = tokens.slice(i, i + FCM_BATCH).map((t) => t.token);
      try {
        const result = await this.messaging.sendEachForMulticast({
          tokens: batch,
          notification: { title: input.title, body: input.body },
          data: stringData,
          // Per type: a new lead rings the bell, the rest are a normal heads-up (push-alert.ts)
          ...pushOptionsFor(input.type),
        });
        // Only tokens FCM says will never work again are removed. Temporary errors (unavailable, internal-error,
        // quota) keep the token, and so does `invalid-argument`, which can equally mean a bad payload.
        const dead = batch.filter((_, index) => {
          const code = result.responses[index]?.error?.code;
          return code !== undefined && DEAD_TOKEN_CODES.has(code);
        });
        if (dead.length > 0) {
          await this.prisma.deviceToken.deleteMany({
            where: { token: { in: dead } },
          });
          this.logger.log(`Removed ${dead.length} dead device token(s)`);
        }
      } catch (error) {
        // A whole-call failure (network, auth) loses this batch only; later batches still get their turn.
        this.logger.error(
          `FCM call failed for ${batch.length} device(s): ${safeReason(error)}`,
        );
      }
    }
  }

  // ───────────────────────── Device tokens ─────────────────────────

  /** One row per token; a token seen again (new sign-in on the same phone) moves to the current user and is re-enabled. */
  async registerToken(
    userId: string,
    token: string,
    platform: DevicePlatform,
  ): Promise<void> {
    await this.prisma.deviceToken.upsert({
      where: { token },
      create: { userId, token, platform },
      update: { userId, platform, isActive: true },
    });
  }

  /** Sign-out: stop pushing to this phone. Only the caller's own row is touched. */
  async unregisterToken(userId: string, token: string): Promise<void> {
    await this.prisma.deviceToken.deleteMany({ where: { userId, token } });
  }

  // ───────────────────────── Inbox ─────────────────────────

  async list(
    userId: string,
    limit = DEFAULT_LIMIT,
    cursor?: string,
  ): Promise<Page<NotificationItem>> {
    // UUIDv7 ids sort by creation time, so the id alone is a stable newest-first keyset.
    const rows = await this.prisma.inAppNotification.findMany({
      where: {
        userId,
        ...(cursor ? { id: { lt: decodeCursor(cursor) } } : {}),
      },
      orderBy: { id: 'desc' },
      take: limit + 1,
    });
    const page = toPage(rows, limit, (r) => r.id);
    return {
      items: page.items.map((r) => ({
        id: r.id,
        type: r.type,
        title: r.title,
        body: r.body,
        data: (r.data ?? {}) as Record<string, unknown>,
        isRead: r.isRead,
        createdAt: r.createdAt.toISOString(),
      })),
      nextCursor: page.nextCursor,
    };
  }

  async unreadCount(userId: string): Promise<{ count: number }> {
    return {
      count: await this.prisma.inAppNotification.count({
        where: { userId, isRead: false },
      }),
    };
  }

  async markRead(userId: string, id: string): Promise<void> {
    const found = await this.prisma.inAppNotification.updateMany({
      where: { id, userId },
      data: { isRead: true },
    });
    if (found.count === 0)
      throw new AppException('NOT_FOUND', 404, 'Notification not found');
  }

  async markAllRead(userId: string): Promise<{ updated: number }> {
    const r = await this.prisma.inAppNotification.updateMany({
      where: { userId, isRead: false },
      data: { isRead: true },
    });
    return { updated: r.count };
  }

  /** The inbox is a convenience copy; the job itself keeps the record, so removing a row is a plain delete. */
  async remove(userId: string, id: string): Promise<void> {
    const r = await this.prisma.inAppNotification.deleteMany({
      where: { id, userId },
    });
    if (r.count === 0)
      throw new AppException('NOT_FOUND', 404, 'Notification not found');
  }

  async clearAll(userId: string): Promise<{ deleted: number }> {
    const r = await this.prisma.inAppNotification.deleteMany({
      where: { userId },
    });
    return { deleted: r.count };
  }
}
