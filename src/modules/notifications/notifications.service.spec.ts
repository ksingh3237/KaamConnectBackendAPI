import type { Messaging } from 'firebase-admin/messaging';
import { vi } from 'vitest';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { parseServiceAccount } from './firebase.provider.js';
import { NotificationsService } from './notifications.service.js';

const push = {
  type: 'NEW_QUOTE' as const,
  title: 'New quote',
  body: 'Ravi quoted ₹200',
  data: { jobId: 'job-1' },
};

function build(responses: { error?: { code: string } }[] = []) {
  const prisma = {
    inAppNotification: { createMany: vi.fn().mockResolvedValue({ count: 1 }) },
    deviceToken: {
      findMany: vi
        .fn()
        .mockResolvedValue(responses.map((_, i) => ({ token: `tok-${i}` }))),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
  };
  const messaging = {
    sendEachForMulticast: vi.fn().mockResolvedValue({ responses }),
  };
  const service = new NotificationsService(
    prisma as unknown as PrismaService,
    messaging as unknown as Messaging,
  );
  return { prisma, messaging, service };
}

describe('NotificationsService.sendPush', () => {
  it('writes the inbox row and sends the push with string-only data', async () => {
    const { prisma, messaging, service } = build([{}]);
    await service.sendPush('u1', push);

    expect(prisma.inAppNotification.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          userId: 'u1',
          type: 'NEW_QUOTE',
          data: { type: 'NEW_QUOTE', jobId: 'job-1' },
        }),
      ],
    });
    expect(messaging.sendEachForMulticast).toHaveBeenCalledWith(
      expect.objectContaining({
        tokens: ['tok-0'],
        data: { type: 'NEW_QUOTE', jobId: 'job-1' },
      }),
    );
  });

  it('removes only the tokens FCM reports as unregistered', async () => {
    const { prisma, service } = build([
      {},
      { error: { code: 'messaging/registration-token-not-registered' } },
      { error: { code: 'messaging/internal-error' } },
    ]);
    await service.sendPush('u1', push);

    expect(prisma.deviceToken.deleteMany).toHaveBeenCalledTimes(1);
    expect(prisma.deviceToken.deleteMany).toHaveBeenCalledWith({
      where: { token: { in: ['tok-1'] } },
    });
  });

  it('still writes the inbox row when Firebase is not configured', async () => {
    const { prisma } = build();
    const service = new NotificationsService(
      prisma as unknown as PrismaService,
      null,
    );
    await service.sendPush('u1', push);

    expect(prisma.inAppNotification.createMany).toHaveBeenCalledTimes(1);
    expect(prisma.deviceToken.findMany).not.toHaveBeenCalled();
  });

  it('never throws: a failing push must not fail the booking that triggered it', async () => {
    const { messaging, service } = build([{}]);
    messaging.sendEachForMulticast.mockRejectedValue(new Error('fcm down'));
    await expect(service.sendPush('u1', push)).resolves.toBeUndefined();
  });

  it('sends one inbox row per user but notifies each user once', async () => {
    const { prisma, service } = build([{}]);
    await service.sendPushToMany(['a', 'b', 'a'], push);

    const rows = prisma.inAppNotification.createMany.mock.calls[0]![0].data;
    expect(rows.map((r: { userId: string }) => r.userId)).toEqual(['a', 'b']);
  });

  it('does nothing for an empty audience', async () => {
    const { prisma, service } = build();
    await service.sendPushToMany([], push);
    expect(prisma.inAppNotification.createMany).not.toHaveBeenCalled();
  });
});

describe('parseServiceAccount', () => {
  const json = JSON.stringify({ project_id: 'kaam' });

  it('accepts raw JSON and base64 JSON', () => {
    expect(parseServiceAccount(json)).toEqual({ project_id: 'kaam' });
    expect(parseServiceAccount(Buffer.from(json).toString('base64'))).toEqual({
      project_id: 'kaam',
    });
  });

  it('rejects anything else', () => {
    expect(parseServiceAccount('not json')).toBeNull();
    expect(parseServiceAccount('[1]')).toBeNull();
  });
});
