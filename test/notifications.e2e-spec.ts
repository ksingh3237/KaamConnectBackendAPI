// Push notifications and the in-app inbox, against the real database with a recording fake in place of Firebase:
// ownership of every endpoint, device-token handling, delivery and failure behaviour, the lifecycle hooks, and
// the cleanup when an account is deleted.

import request from 'supertest';
import { seedReferenceData } from '../prisma/seed/reference-data.js';
import { AccountDeletionService } from '../src/modules/account/account-deletion.service.js';
import { NotificationsCleanupService } from '../src/modules/notifications/notifications-cleanup.service.js';
import { NotificationsService } from '../src/modules/notifications/notifications.service.js';
import { api, createTestApp, freshIp, type TestApp } from './helpers/app.js';
import { loginAs, type LoggedIn } from './helpers/auth.js';
import { resetDatabase } from './helpers/db.js';
import { nextPhone } from './helpers/factories.js';
import { V1, finished } from './helpers/fulfilment.js';
import {
  customerIn,
  postJob,
  verifiedWorkerIn,
} from './helpers/marketplace.js';

const NOTES = `${V1}/notifications`;
const token = (label: string) => `fcm-${label}-`.padEnd(40, 'x');

describe('notifications (e2e)', () => {
  let t: TestApp;
  let http: ReturnType<typeof api>;

  beforeAll(async () => {
    t = await createTestApp();
    http = api(t.app);
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await resetDatabase(t.prisma);
    await seedReferenceData(t.prisma);
    t.messaging.reset();
  });

  const as = (u: LoggedIn) => ({ token: u.accessToken });
  const registerToken = (u: LoggedIn, value: string, platform = 'ANDROID') =>
    http.post(`${NOTES}/device-token`, { token: value, platform }, as(u));
  const deleteToken = (u: LoggedIn, value: string) =>
    request(t.app.getHttpServer())
      .delete(`${NOTES}/device-token`)
      .set('X-Forwarded-For', freshIp())
      .set('Authorization', `Bearer ${u.accessToken}`)
      .send({ token: value });
  const give = (userId: string, title: string, isRead = false) =>
    t.prisma.inAppNotification.create({
      data: { userId, type: 'NEW_QUOTE', title, body: 'body', isRead },
    });
  const inbox = async (u: LoggedIn) =>
    (await http.get(NOTES, as(u)).expect(200)).body.items as {
      id: string;
      type: string;
      title: string;
      isRead: boolean;
      data: Record<string, unknown>;
    }[];
  const typesOf = async (u: LoggedIn) => (await inbox(u)).map((n) => n.type);
  /** Pushes are sent after the request has answered, so wait (briefly) for them to land. */
  const eventually = async (check: () => Promise<boolean>): Promise<void> => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (await check()) return;
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    throw new Error('the notification never arrived');
  };
  const tokensOf = async (userId: string) =>
    (await t.prisma.deviceToken.findMany({ where: { userId } }))
      .map((d) => d.token)
      .sort();

  describe('ownership and access', () => {
    it('refuses every route without a sign-in', async () => {
      const id = '00000000-0000-7000-8000-000000000000';
      await http.get(NOTES).expect(401);
      await http.get(`${NOTES}/unread-count`).expect(401);
      await http.patch(`${NOTES}/read-all`).expect(401);
      await http.patch(`${NOTES}/${id}/read`).expect(401);
      await http.delete(`${NOTES}/${id}`).expect(401);
      await http.delete(NOTES).expect(401);
      await http
        .post(`${NOTES}/device-token`, {
          token: token('a'),
          platform: 'ANDROID',
        })
        .expect(401);
      await request(t.app.getHttpServer())
        .delete(`${NOTES}/device-token`)
        .set('X-Forwarded-For', freshIp())
        .send({ token: token('a') })
        .expect(401);
    });

    it('lists and counts only the caller’s own notifications', async () => {
      const a = await loginAs(t, nextPhone());
      const b = await loginAs(t, nextPhone());
      await give(a.userId, 'for A');
      await give(a.userId, 'for A too');
      await give(b.userId, 'for B');

      expect((await inbox(a)).map((n) => n.title).sort()).toEqual([
        'for A',
        'for A too',
      ]);
      expect((await inbox(b)).map((n) => n.title)).toEqual(['for B']);
      expect(
        (await http.get(`${NOTES}/unread-count`, as(a)).expect(200)).body,
      ).toEqual({ count: 2 });
      expect(
        (await http.get(`${NOTES}/unread-count`, as(b)).expect(200)).body,
      ).toEqual({ count: 1 });
    });

    it('answers 404 (and changes nothing) when marking someone else’s notification read', async () => {
      const a = await loginAs(t, nextPhone());
      const b = await loginAs(t, nextPhone());
      const mine = await give(b.userId, 'B only');

      const res = await http
        .patch(`${NOTES}/${mine.id}/read`, {}, as(a))
        .expect(404);
      expect(res.body.error?.code ?? res.body.code).toBe('NOT_FOUND');
      expect(
        (
          await t.prisma.inAppNotification.findUniqueOrThrow({
            where: { id: mine.id },
          })
        ).isRead,
      ).toBe(false);
      // An id that does not exist looks exactly the same as someone else's
      await http
        .patch(`${NOTES}/00000000-0000-7000-8000-000000000000/read`, {}, as(a))
        .expect(404);
    });

    it('read-all only touches the caller’s own notifications', async () => {
      const a = await loginAs(t, nextPhone());
      const b = await loginAs(t, nextPhone());
      await give(a.userId, 'a1');
      await give(a.userId, 'a2');
      await give(b.userId, 'b1');

      const res = await http.patch(`${NOTES}/read-all`, {}, as(a)).expect(200);
      expect(res.body).toEqual({ updated: 2 });
      expect(
        (await http.get(`${NOTES}/unread-count`, as(a)).expect(200)).body.count,
      ).toBe(0);
      expect(
        (await http.get(`${NOTES}/unread-count`, as(b)).expect(200)).body.count,
      ).toBe(1);
    });

    it('marks one notification read, and doing it twice is fine', async () => {
      const a = await loginAs(t, nextPhone());
      const n = await give(a.userId, 'x');
      await give(a.userId, 'y');
      await http.patch(`${NOTES}/${n.id}/read`, {}, as(a)).expect(204);
      await http.patch(`${NOTES}/${n.id}/read`, {}, as(a)).expect(204);
      expect(
        (await http.get(`${NOTES}/unread-count`, as(a)).expect(200)).body.count,
      ).toBe(1);
    });

    it('deletes one of the caller’s notifications and answers 404 for someone else’s or a missing one', async () => {
      const a = await loginAs(t, nextPhone());
      const b = await loginAs(t, nextPhone());
      const mine = await give(a.userId, 'mine');
      await give(a.userId, 'keep');
      const theirs = await give(b.userId, 'theirs');

      await http.delete(`${NOTES}/${theirs.id}`, as(a)).expect(404);
      expect(await inbox(b)).toHaveLength(1);

      await http.delete(`${NOTES}/${mine.id}`, as(a)).expect(204);
      expect((await inbox(a)).map((n) => n.title)).toEqual(['keep']);
      // Already gone: the same answer as an id that never existed
      await http.delete(`${NOTES}/${mine.id}`, as(a)).expect(404);
      await http.delete(`${NOTES}/not-a-uuid`, as(a)).expect((r) => {
        expect([400, 422]).toContain(r.status);
      });
    });

    it('clear-all empties the caller’s inbox and nobody else’s', async () => {
      const a = await loginAs(t, nextPhone());
      const b = await loginAs(t, nextPhone());
      await give(a.userId, 'a1');
      await give(a.userId, 'a2', true);
      await give(b.userId, 'b1');

      const res = await http.delete(NOTES, as(a)).expect(200);
      expect(res.body).toEqual({ deleted: 2 });
      expect(await inbox(a)).toEqual([]);
      expect(
        (await http.get(`${NOTES}/unread-count`, as(a)).expect(200)).body.count,
      ).toBe(0);
      expect(await inbox(b)).toHaveLength(1);
      await http.delete(NOTES).expect(401);
    });

    it('purges read notifications after 30 days and any after 90, never a recent unread one', async () => {
      const a = await loginAs(t, nextPhone());
      const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000);
      const make = (title: string, isRead: boolean, days: number) =>
        t.prisma.inAppNotification.create({
          data: {
            userId: a.userId,
            type: 'NEW_QUOTE',
            title,
            body: 'body',
            isRead,
            createdAt: daysAgo(days),
          },
        });
      await make('read 40d', true, 40);
      await make('unread 40d', false, 40);
      await make('read 10d', true, 10);
      await make('unread 100d', false, 100);
      await make('unread 1d', false, 1);

      const removed = await t.app.get(NotificationsCleanupService).purge();
      expect(removed).toBe(2);
      expect((await inbox(a)).map((n) => n.title).sort()).toEqual([
        'read 10d',
        'unread 1d',
        'unread 40d',
      ]);
    });

    it('rejects a malformed id before touching the database', async () => {
      const a = await loginAs(t, nextPhone());
      const res = await http
        .patch(`${NOTES}/not-a-uuid/read`, {}, as(a))
        .expect((r) => expect([400, 422]).toContain(r.status));
      expect(res.status).not.toBe(500);
    });

    it('is closed to a disabled account', async () => {
      const a = await loginAs(t, nextPhone());
      await t.prisma.user.update({
        where: { id: a.userId },
        data: { isActive: false },
      });
      await http.get(NOTES, as(a)).expect(403);
      await http.get(`${NOTES}/unread-count`, as(a)).expect(403);
    });
  });

  describe('paging', () => {
    it('walks newest first with no repeats, then ends', async () => {
      const a = await loginAs(t, nextPhone());
      for (const title of ['n1', 'n2', 'n3', 'n4', 'n5'])
        await give(a.userId, title);

      const seen: string[] = [];
      let cursor: string | null = null;
      for (let guard = 0; guard < 5; guard += 1) {
        const query: string = `?limit=2${cursor ? `&cursor=${cursor}` : ''}`;
        const page: { items: { title: string }[]; nextCursor: string | null } =
          (await http.get(`${NOTES}${query}`, as(a)).expect(200)).body;
        seen.push(...page.items.map((n) => n.title));
        cursor = page.nextCursor;
        if (!cursor) break;
      }
      expect(seen).toEqual(['n5', 'n4', 'n3', 'n2', 'n1']);
    });

    it('refuses a bad cursor and an oversized page', async () => {
      const a = await loginAs(t, nextPhone());
      await http.get(`${NOTES}?cursor=garbage`, as(a)).expect(422);
      await http.get(`${NOTES}?limit=51`, as(a)).expect(422);
      await http.get(`${NOTES}?limit=0`, as(a)).expect(422);
    });

    it('does not let a cursor from one user open another user’s rows', async () => {
      const a = await loginAs(t, nextPhone());
      const b = await loginAs(t, nextPhone());
      const first = await give(a.userId, 'a-old');
      await give(b.userId, 'b-new');
      const bPage = (await http.get(`${NOTES}?limit=1`, as(b)).expect(200))
        .body;
      expect(bPage.items.map((n: { title: string }) => n.title)).toEqual([
        'b-new',
      ]);
      const cursor = Buffer.from(first.id, 'utf8').toString('base64url');
      const res = await http
        .get(`${NOTES}?cursor=${cursor}`, as(b))
        .expect(200);
      expect(res.body.items).toEqual([]); // A's row id is a position, never a way to read A's rows
    });
  });

  describe('device tokens', () => {
    it('registers a token, and registering it again does not duplicate it', async () => {
      const a = await loginAs(t, nextPhone());
      await registerToken(a, token('one')).expect(204);
      await registerToken(a, token('one')).expect(204);
      expect(await tokensOf(a.userId)).toEqual([token('one')]);
    });

    it('validates the token and the platform', async () => {
      const a = await loginAs(t, nextPhone());
      await registerToken(a, 'short').expect(422);
      await registerToken(a, token('ok'), 'WINDOWS').expect(422);
      await http.post(`${NOTES}/device-token`, {}, as(a)).expect(422);
      expect(await tokensOf(a.userId)).toEqual([]);
    });

    it('moves a token to whoever signs in on that phone next, leaving the old owner’s other devices alone', async () => {
      const a = await loginAs(t, nextPhone());
      const b = await loginAs(t, nextPhone());
      await registerToken(a, token('phone')).expect(204);
      await registerToken(a, token('tablet')).expect(204);

      await registerToken(b, token('phone')).expect(204);

      expect(await tokensOf(a.userId)).toEqual([token('tablet')]);
      expect(await tokensOf(b.userId)).toEqual([token('phone')]);
      // ...and a push for A no longer reaches B's phone
      await t.app.get(NotificationsService).sendPush(a.userId, {
        type: 'NEW_QUOTE',
        title: 'hello',
        body: 'hi',
      });
      expect(t.messaging.sent).toHaveLength(1);
      expect(t.messaging.sent[0]!.tokens).toEqual([token('tablet')]);
    });

    it('unregistering removes only the caller’s own token', async () => {
      const a = await loginAs(t, nextPhone());
      const b = await loginAs(t, nextPhone());
      await registerToken(a, token('a-phone')).expect(204);
      await registerToken(b, token('b-phone')).expect(204);

      // B names A's token: allowed to ask, but nothing of A's changes
      await deleteToken(b, token('a-phone')).expect(204);
      expect(await tokensOf(a.userId)).toEqual([token('a-phone')]);

      await deleteToken(a, token('a-phone')).expect(204);
      expect(await tokensOf(a.userId)).toEqual([]);
      expect(await tokensOf(b.userId)).toEqual([token('b-phone')]);
    });
  });

  describe('delivery', () => {
    it('gives every recipient an inbox row and pushes to all of their devices', async () => {
      const customer = await customerIn(t);
      const withTwo = await verifiedWorkerIn(t);
      const withNone = await verifiedWorkerIn(t);
      await registerToken(withTwo, token('w-phone')).expect(204);
      await registerToken(withTwo, token('w-tablet')).expect(204);

      const job = await postJob(t, customer);

      await eventually(async () =>
        (await typesOf(withNone)).includes('NEW_LEAD'),
      );
      await eventually(async () => t.messaging.sent.length > 0);
      expect(await typesOf(withTwo)).toContain('NEW_LEAD');
      const sent = t.messaging.sent.find((m) => m.data.type === 'NEW_LEAD')!;
      expect([...sent.tokens].sort()).toEqual(
        [token('w-phone'), token('w-tablet')].sort(),
      );
      expect(sent.data.jobId).toBe(job.id);
      expect(sent.notification.title).toBe('New job near you');
      // a worker with no registered device still sees it in the bell
      expect((await inbox(withNone))[0]!.data.jobId).toBe(job.id);
    });

    it('reaches an Android phone and an iPhone of the same person in one message, with the Apple settings', async () => {
      const customer = await customerIn(t);
      const worker = await verifiedWorkerIn(t);
      await registerToken(worker, token('w-android'), 'ANDROID').expect(204);
      await registerToken(worker, token('w-iphone'), 'IOS').expect(204);

      await postJob(t, customer);

      await eventually(async () => t.messaging.sent.length > 0);
      const sent = t.messaging.sent[0]!;
      expect([...sent.tokens].sort()).toEqual(
        [token('w-android'), token('w-iphone')].sort(),
      );
      // a new lead rings the bell on both platforms
      expect(sent.apns).toEqual({
        headers: { 'apns-priority': '10' },
        payload: { aps: { sound: 'new_lead.wav' } },
      });
      expect(sent.android).toMatchObject({
        priority: 'high',
        notification: { channelId: 'new_leads', sound: 'new_lead' },
      });
    });

    it('does not fail the booking when Firebase is down, and still fills the inbox', async () => {
      const customer = await customerIn(t);
      const worker = await verifiedWorkerIn(t);
      await registerToken(worker, token('w-phone')).expect(204);
      t.messaging.throwNext = new Error('fcm down');

      const job = await postJob(t, customer); // expects 201

      expect(job.status).toBe('OPEN');
      await eventually(async () =>
        (await typesOf(worker)).includes('NEW_LEAD'),
      );
      expect(await tokensOf(worker.userId)).toEqual([token('w-phone')]); // a temporary failure keeps the token
    });

    it('removes only tokens FCM says are dead; temporary errors and healthy tokens stay', async () => {
      const customer = await customerIn(t);
      const worker = await verifiedWorkerIn(t);
      for (const label of ['alive', 'gone', 'busy', 'badarg'])
        await registerToken(worker, token(label)).expect(204);
      t.messaging.replies.set(
        token('gone'),
        'messaging/registration-token-not-registered',
      );
      t.messaging.replies.set(token('busy'), 'messaging/internal-error');
      t.messaging.replies.set(token('badarg'), 'messaging/invalid-argument');

      await postJob(t, customer);
      await eventually(
        async () => (await tokensOf(worker.userId)).length === 3,
      );

      expect(await tokensOf(worker.userId)).toEqual(
        [token('alive'), token('badarg'), token('busy')].sort(),
      );
    });

    it('carries each moment of a job to the right person', async () => {
      const customer = await customerIn(t);
      const worker = await verifiedWorkerIn(t);
      await registerToken(customer, token('c-phone')).expect(204);
      await registerToken(worker, token('w-phone')).expect(204);

      const { job } = await finished(t, customer, worker);

      await eventually(async () =>
        (await typesOf(customer)).includes('WORK_COMPLETED'),
      );
      expect((await typesOf(customer)).sort()).toEqual(
        [
          'NEW_QUOTE',
          'WORKER_EN_ROUTE',
          'WORKER_ARRIVED',
          'BILL_CREATED',
          'WORK_COMPLETED',
        ].sort(),
      );
      expect((await typesOf(worker)).sort()).toEqual(
        ['NEW_LEAD', 'BOOKING_CONFIRMED'].sort(),
      );
      // each push went to the owner's phone only, and always carries the job to open
      for (const m of t.messaging.sent) {
        expect(m.data.jobId).toBe(job.id);
        const forCustomer = m.tokens.includes(token('c-phone'));
        const forWorker = m.tokens.includes(token('w-phone'));
        expect(forCustomer !== forWorker).toBe(true);
      }
      // no phone number, address or arrival code in any push
      expect(JSON.stringify(t.messaging.sent)).not.toMatch(
        /\+91|House #|arrivalCode/,
      );
    });

    it('stops pushing to a phone after its owner signs out of it', async () => {
      const customer = await customerIn(t);
      const worker = await verifiedWorkerIn(t);
      await registerToken(worker, token('w-phone')).expect(204);
      await deleteToken(worker, token('w-phone')).expect(204);

      await postJob(t, customer);

      await eventually(async () =>
        (await typesOf(worker)).includes('NEW_LEAD'),
      );
      expect(t.messaging.sent).toEqual([]);
    });
  });

  describe('account deletion', () => {
    it('removes the person’s devices and inbox, and nobody else’s', async () => {
      const a = await loginAs(t, nextPhone());
      const b = await loginAs(t, nextPhone());
      await registerToken(a, token('a-phone')).expect(204);
      await registerToken(b, token('b-phone')).expect(204);
      await give(a.userId, 'a1');
      await give(b.userId, 'b1');

      await t.app.get(AccountDeletionService).reapplyFromLedger(a.userId);

      expect(await tokensOf(a.userId)).toEqual([]);
      expect(
        await t.prisma.inAppNotification.count({ where: { userId: a.userId } }),
      ).toBe(0);
      expect(await tokensOf(b.userId)).toEqual([token('b-phone')]);
      expect(
        await t.prisma.inAppNotification.count({ where: { userId: b.userId } }),
      ).toBe(1);
    });
  });
});
