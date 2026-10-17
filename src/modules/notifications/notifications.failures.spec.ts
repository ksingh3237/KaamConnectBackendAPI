// Failure behaviour of the push sender: partial FCM failures, whole-call failures across batches, an inbox that
// cannot be written, over-long text, and what may appear in the log. (The happy path is in notifications.service.spec.ts.)
import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { Messaging } from 'firebase-admin/messaging';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { firebaseMessagingProvider } from './firebase.provider.js';
import { NotificationsService } from './notifications.service.js';
import { safeReason } from './redact.js';

const push = {
  type: 'NEW_LEAD' as const,
  title: 'New job near you',
  body: 'Fix a tap',
  data: { jobId: 'job-1' },
};

const SECRET_TOKEN =
  'dXyZ0123456789abcdefghijklmnopqrstuvwxyz:APA91bHsecretsecretsecret';

function build(tokenCount: number) {
  const tokens = Array.from({ length: tokenCount }, (_, i) => ({
    token: `tok-${i}`,
  }));
  const prisma = {
    inAppNotification: { createMany: vi.fn().mockResolvedValue({ count: 1 }) },
    deviceToken: {
      findMany: vi.fn().mockResolvedValue(tokens),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
  };
  const messaging = { sendEachForMulticast: vi.fn() };
  const service = new NotificationsService(
    prisma as unknown as PrismaService,
    messaging as unknown as Messaging,
  );
  return { prisma, messaging, service };
}

const ok = (n: number) => ({
  responses: Array.from({ length: n }, () => ({ success: true })),
});

afterEach(() => vi.restoreAllMocks());

describe('NotificationsService failure handling', () => {
  it('still pushes when the inbox cannot be written', async () => {
    const { prisma, messaging, service } = build(2);
    prisma.inAppNotification.createMany.mockRejectedValue(new Error('db down'));
    messaging.sendEachForMulticast.mockResolvedValue(ok(2));
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    await expect(service.sendPush('u1', push)).resolves.toBeUndefined();
    expect(messaging.sendEachForMulticast).toHaveBeenCalledTimes(1);
  });

  it('keeps the inbox row when the token lookup fails', async () => {
    const { prisma, messaging, service } = build(1);
    prisma.deviceToken.findMany.mockRejectedValue(new Error('db down'));
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    await expect(service.sendPush('u1', push)).resolves.toBeUndefined();
    expect(prisma.inAppNotification.createMany).toHaveBeenCalledTimes(1);
    expect(messaging.sendEachForMulticast).not.toHaveBeenCalled();
  });

  it('a failed batch loses only itself: later batches are sent and earlier dead tokens are removed', async () => {
    const { prisma, messaging, service } = build(1100); // 500 + 500 + 100
    messaging.sendEachForMulticast
      .mockImplementationOnce(({ tokens }: { tokens: string[] }) =>
        Promise.resolve({
          responses: tokens.map((_, i) =>
            i === 3
              ? {
                  success: false,
                  error: {
                    code: 'messaging/registration-token-not-registered',
                  },
                }
              : { success: true },
          ),
        }),
      )
      .mockRejectedValueOnce(new Error('503 unavailable'))
      .mockResolvedValueOnce(ok(100));
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    await service.sendPush('u1', push);

    expect(messaging.sendEachForMulticast).toHaveBeenCalledTimes(3);
    expect(prisma.deviceToken.deleteMany).toHaveBeenCalledTimes(1);
    expect(prisma.deviceToken.deleteMany).toHaveBeenCalledWith({
      where: { token: { in: ['tok-3'] } },
    });
  });

  it('treats a short responses array as "no news" rather than crashing', async () => {
    const { prisma, messaging, service } = build(3);
    messaging.sendEachForMulticast.mockResolvedValue({ responses: [] });
    await service.sendPush('u1', push);
    expect(prisma.deviceToken.deleteMany).not.toHaveBeenCalled();
  });

  it('keeps tokens for temporary and ambiguous errors', async () => {
    const { prisma, messaging, service } = build(4);
    const codes = [
      'messaging/internal-error',
      'messaging/server-unavailable',
      'messaging/message-rate-exceeded',
      'messaging/invalid-argument', // may be a bad payload: deleting would wipe healthy devices
    ];
    messaging.sendEachForMulticast.mockResolvedValue({
      responses: codes.map((code) => ({ success: false, error: { code } })),
    });
    await service.sendPush('u1', push);
    expect(prisma.deviceToken.deleteMany).not.toHaveBeenCalled();
  });

  it('removes tokens FCM calls invalid as well as unregistered', async () => {
    const { prisma, messaging, service } = build(2);
    messaging.sendEachForMulticast.mockResolvedValue({
      responses: [
        {
          success: false,
          error: { code: 'messaging/invalid-registration-token' },
        },
        { success: true },
      ],
    });
    await service.sendPush('u1', push);
    expect(prisma.deviceToken.deleteMany).toHaveBeenCalledWith({
      where: { token: { in: ['tok-0'] } },
    });
  });

  it('shortens text that would not fit the columns instead of losing the notification', async () => {
    const { prisma, messaging, service } = build(0);
    messaging.sendEachForMulticast.mockResolvedValue(ok(0));
    await service.sendPush('u1', {
      ...push,
      title: 'T'.repeat(500),
      body: 'B'.repeat(900),
    });
    const [row] = prisma.inAppNotification.createMany.mock.calls[0]![0].data;
    expect(row.title).toHaveLength(120);
    expect(row.body).toHaveLength(300);
  });

  it('does not write device tokens or credentials to the log when a call fails', async () => {
    const { prisma, messaging, service } = build(1);
    messaging.sendEachForMulticast.mockRejectedValue(
      new Error(`Request for ${SECRET_TOKEN} failed`),
    );
    prisma.deviceToken.deleteMany.mockRejectedValue(
      new Error(
        `Invalid invocation: where: { token: { in: ["${SECRET_TOKEN}"] } }`,
      ),
    );
    const logged: string[] = [];
    vi.spyOn(Logger.prototype, 'error').mockImplementation((m) => {
      logged.push(String(m));
    });
    vi.spyOn(Logger.prototype, 'log').mockImplementation((m) => {
      logged.push(String(m));
    });

    await service.sendPush('u1', push);

    expect(logged.length).toBeGreaterThan(0);
    expect(logged.join('\n')).not.toContain(SECRET_TOKEN);
    expect(logged.join('\n')).not.toContain('APA91b');
  });
});

describe('safeReason', () => {
  it('hides long token-like runs and keeps short readable codes', () => {
    const text = safeReason(
      new Error(`messaging/internal-error for ${SECRET_TOKEN} (retry)`),
    );
    expect(text).toBe('messaging/internal-error for [redacted] (retry)');
  });

  it('caps the length and copes with non-errors', () => {
    expect(safeReason('x '.repeat(400))).toHaveLength(300);
    expect(safeReason(undefined)).toBe('undefined');
  });
});

describe('Firebase start-up', () => {
  const start = (value: string | undefined) => {
    const config = { get: vi.fn().mockReturnValue(value) };
    const factory = (
      firebaseMessagingProvider as unknown as {
        useFactory: (c: ConfigService) => Messaging | null;
      }
    ).useFactory;
    return factory(config as unknown as ConfigService);
  };

  it('is off, with a warning, when no credentials are configured', () => {
    const warn = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    expect(start(undefined)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('is off, with an error, when the value is not JSON', () => {
    const error = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    expect(start('definitely not json')).toBeNull();
    expect(error).toHaveBeenCalledTimes(1);
  });

  it('stays off and never logs the key when the credential is unusable', () => {
    const privateKey = `-----BEGIN PRIVATE KEY-----\n${'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC'.repeat(6)}\n-----END PRIVATE KEY-----\n`;
    const lines: string[] = [];
    vi.spyOn(Logger.prototype, 'error').mockImplementation((m) => {
      lines.push(String(m));
    });
    vi.spyOn(Logger.prototype, 'warn').mockImplementation((m) => {
      lines.push(String(m));
    });
    const account = JSON.stringify({
      type: 'service_account',
      project_id: 'kaam-test',
      client_email: 'svc@kaam-test.iam.gserviceaccount.com',
      private_key: privateKey,
    });

    expect(start(account)).toBeNull();

    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join('\n')).not.toContain('MIIEvQIBADANBgkqhkiG9w0BAQEFAASC');
    expect(lines.join('\n')).not.toContain('BEGIN PRIVATE KEY');
  });
});
