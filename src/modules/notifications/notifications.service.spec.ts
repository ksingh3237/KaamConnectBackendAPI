import type { Messaging } from 'firebase-admin/messaging';
import { vi } from 'vitest';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { parseServiceAccount } from './firebase.provider.js';
import { NotificationsService } from './notifications.service.js';
import { PushTexts } from './push-texts.js';

const push = {
  type: 'NEW_QUOTE' as const,
  title: 'New quote',
  body: 'Ravi quoted ₹200',
  data: { jobId: 'job-1' },
};

function build(responses: { error?: { code: string } }[] = []) {
  const prisma = {
    inAppNotification: { createMany: vi.fn().mockResolvedValue({ count: 1 }) },
    user: { findMany: vi.fn().mockResolvedValue([]) },
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
        // both platforms are served by the one message
        android: expect.objectContaining({ priority: 'high' }),
        // NEW_QUOTE is one of the loud ones: the customer is waiting for exactly this (push-alert.ts ALERT_TYPES)
        apns: {
          headers: { 'apns-priority': '10' },
          payload: { aps: { sound: 'new_lead.wav' } },
        },
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

describe('NotificationsService: each person reads it in their own language', () => {
  const lead = {
    type: 'NEW_LEAD' as const,
    ...PushTexts.newLead('Tap leaking'),
    data: { jobId: 'job-1' },
  };
  const inboxRows = (prisma: ReturnType<typeof build>['prisma']) =>
    prisma.inAppNotification.createMany.mock.calls.flatMap(
      (c: { data: { userId: string; title: string; body: string }[] }[]) =>
        c[0].data,
    );

  it('sends Hindi to Hindi readers, Punjabi to Punjabi readers and English to the rest', async () => {
    const { prisma, messaging, service } = build([{}]);
    prisma.user.findMany.mockResolvedValue([
      { id: 'h', language: 'hi' },
      { id: 'p', language: 'pa' },
      { id: 'e', language: 'en' },
    ]);
    await service.sendPushToMany(['h', 'p', 'e', 'gone'], lead);

    const byUser = Object.fromEntries(
      inboxRows(prisma).map((r) => [r.userId, r.title]),
    );
    expect(byUser).toEqual({
      h: 'आपके पास नया काम',
      p: 'ਤੁਹਾਡੇ ਨੇੜੇ ਨਵਾਂ ਕੰਮ',
      e: 'New job near you',
      gone: 'New job near you', // no user row (deleted meanwhile): English
    });
    // What the person typed is never translated
    expect(new Set(inboxRows(prisma).map((r) => r.body))).toEqual(
      new Set(['Tap leaking']),
    );
    const titles = messaging.sendEachForMulticast.mock.calls.map(
      (c: { notification: { title: string } }[]) => c[0].notification.title,
    );
    expect(titles.sort()).toEqual(
      ['New job near you', 'आपके पास नया काम', 'ਤੁਹਾਡੇ ਨੇੜੇ ਨਵਾਂ ਕੰਮ'].sort(),
    );
    // The translations are not stored as data and never reach the phone's payload
    for (const c of messaging.sendEachForMulticast.mock.calls)
      expect(c[0].data).toEqual({ type: 'NEW_LEAD', jobId: 'job-1' });
  });

  it('falls back to English for everyone when the languages cannot be read', async () => {
    const { prisma, service } = build([{}]);
    prisma.user.findMany.mockRejectedValue(new Error('db down'));
    await service.sendPushToMany(['h', 'p'], lead);

    expect(inboxRows(prisma).map((r) => r.title)).toEqual([
      'New job near you',
      'New job near you',
    ]);
  });

  it('does not look languages up for a notification that has no translations', async () => {
    const { prisma, service } = build([{}]);
    await service.sendPush('u1', push);
    expect(prisma.user.findMany).not.toHaveBeenCalled();
  });
});

describe('PushTexts', () => {
  it('translates a reason picked from the list, keeps typed words, and never shows the old BACKED_OUT marker', () => {
    const listed = PushTexts.cancelledByWorker(
      'Geyser',
      'Vehicle problem',
      true,
      null,
    );
    expect(listed.body).toContain('Reason: Vehicle problem.');
    expect(listed.translations.hi.body).toContain('कारण: गाड़ी में खराबी');
    expect(listed.translations.pa.body).toContain('ਕਾਰਨ: ਗੱਡੀ ਵਿੱਚ ਖ਼ਰਾਬੀ');

    const typed = PushTexts.cancelledByCustomer('Geyser', 'gas khatam', 200);
    expect(typed.translations.hi.body).toContain('gas khatam');
    expect(typed.translations.hi.body).toContain('₹200');

    const marker = PushTexts.cancelledByWorker(
      'Geyser',
      'BACKED_OUT',
      true,
      null,
    );
    for (const copy of [marker, marker.translations.hi, marker.translations.pa])
      expect(copy.body).not.toContain('BACKED_OUT');
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
