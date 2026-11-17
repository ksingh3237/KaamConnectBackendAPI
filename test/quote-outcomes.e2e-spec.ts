import { seedReferenceData } from '../prisma/seed/reference-data.js';
import { CLOSED_LEAD_VISIBLE_MS } from '../src/modules/offers/leads.service.js';
import { api, createTestApp, type TestApp } from './helpers/app.js';
import { resetDatabase } from './helpers/db.js';
import {
  bothProfiles,
  finished,
  payFor,
  VISIT_FEE,
} from './helpers/fulfilment.js';
import {
  customerIn,
  postJob,
  sendQuote,
  verifiedWorkerIn,
  type Customer,
  type Worker,
} from './helpers/marketplace.js';
import { acceptQuote, bookNow, inMinutes } from './helpers/scheduling.js';
import { closeAllSockets, connect, record } from './helpers/socket.js';

const V1 = '/api/v1';
const JOBS = `${V1}/jobs`;
const LEADS = `${V1}/leads`;

type NotificationKind =
  | 'BOOKING_CONFIRMED'
  | 'QUOTE_DECLINED'
  | 'QUOTE_NOT_SELECTED'
  | 'LEAD_CANCELLED'
  | 'NEW_LEAD';

interface FeedItem {
  id: string;
  outcome: string | null;
  myOffer: { status: string } | null;
  availability: unknown;
}

describe('what became of a quote, the offline worker who is chosen, "is anyone there", and the Wallet (e2e)', () => {
  let t: TestApp;
  let http: ReturnType<typeof api>;

  beforeAll(async () => {
    t = await createTestApp();
    http = api(t.app);
  });
  afterAll(async () => {
    closeAllSockets();
    await t.close();
  });
  afterEach(() => closeAllSockets());
  beforeEach(async () => {
    await resetDatabase(t.prisma);
    await seedReferenceData(t.prisma);
  });

  /** One FCM token per user. The whole id: ids made in the same millisecond share their first characters. */
  const tokenOf = (userId: string) => `fcm-${userId}`;
  /** Without a registered phone nothing is pushed (the inbox row is still written). */
  const giveDevice = (userId: string) =>
    t.prisma.deviceToken.create({
      data: {
        userId,
        token: tokenOf(userId),
        platform: 'ANDROID',
      },
    });
  /** Pushes are sent after the request answers, so wait (briefly) for them. */
  const pushesOf = async (
    type: NotificationKind,
    jobId: string,
    atLeast = 1,
  ) => {
    const deadline = Date.now() + 5000;
    for (;;) {
      const sent = t.messaging.sent.filter(
        (m) => m.data.type === type && m.data.jobId === jobId,
      );
      if (sent.length >= atLeast || Date.now() > deadline) return sent;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };
  const inboxOf = async (userId: string, type: NotificationKind) => {
    const deadline = Date.now() + 5000;
    for (;;) {
      const rows = await t.prisma.inAppNotification.findMany({
        where: { userId, type },
      });
      if (rows.length > 0 || Date.now() > deadline) return rows;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };
  /** Gives fire-and-forget pushes time to (not) happen. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 300));

  const feed = async (worker: Worker, query = ''): Promise<FeedItem[]> =>
    (
      await http
        .get(`${LEADS}${query}`, { token: worker.accessToken })
        .expect(200)
    ).body.items;
  const lead = async (worker: Worker, jobId: string) =>
    (
      await http
        .get(`${LEADS}/${jobId}`, { token: worker.accessToken })
        .expect(200)
    ).body as FeedItem & { status: string };
  const switchOff = (worker: Worker) =>
    http
      .patch(
        `${V1}/workers/me`,
        { isAvailable: false },
        { token: worker.accessToken },
      )
      .expect(200);
  const isAvailable = async (worker: Worker) =>
    (
      await t.prisma.workerProfile.findUniqueOrThrow({
        where: { userId: worker.userId },
      })
    ).isAvailable;
  const declineQuote = (customer: Customer, jobId: string, offerId: string) =>
    http.post(
      `${JOBS}/${jobId}/offers/${offerId}/decline`,
      {},
      { token: customer.accessToken },
    );
  const cancel = (customer: Customer, jobId: string) =>
    http.post(`${JOBS}/${jobId}/cancel`, {}, { token: customer.accessToken });

  describe('1. a worker who is switched off', () => {
    it('still sees and can quote on leads, and quoting leaves them switched off', async () => {
      const customer = await customerIn(t);
      const worker = await verifiedWorkerIn(t);
      await switchOff(worker);
      const job = await postJob(t, customer);

      expect((await feed(worker)).map((l) => l.id)).toEqual([job.id]);
      await sendQuote(t, worker, job.id);
      expect(await isAvailable(worker)).toBe(false);
    });

    it('is switched back on when the customer accepts their quote: database, live event and push all say so', async () => {
      const customer = await customerIn(t);
      const worker = await verifiedWorkerIn(t);
      await giveDevice(worker.userId);
      await switchOff(worker);
      const job = await postJob(t, customer);
      const offer = await sendQuote(t, worker, job.id);
      const phone = record(await connect(t, worker.accessToken));

      await acceptQuote(t, customer, job.id, offer.id).expect(200);

      expect(await isAvailable(worker)).toBe(true);
      const [event] = await phone.waitFor('worker.availability');
      expect(event).toEqual({
        isAvailable: true,
        reason: 'BOOKING_CONFIRMED',
        jobId: job.id,
      });
      const [push] = await pushesOf('BOOKING_CONFIRMED', job.id);
      expect(push!.notification.body).toContain('You are online again.');
      // The app reads the same switch back from the profile.
      const me = await http
        .get(`${V1}/workers/me`, { token: worker.accessToken })
        .expect(200);
      expect(me.body.isAvailable).toBe(true);
    });

    it('a worker who was already on hears nothing about going online', async () => {
      const customer = await customerIn(t);
      const worker = await verifiedWorkerIn(t);
      await giveDevice(worker.userId);
      const phone = record(await connect(t, worker.accessToken));
      const job = await postJob(t, customer);
      const offer = await sendQuote(t, worker, job.id);

      await acceptQuote(t, customer, job.id, offer.id).expect(200);

      const [push] = await pushesOf('BOOKING_CONFIRMED', job.id);
      expect(push!.notification.body).not.toContain('online');
      await phone.expectNone('worker.availability');
      expect(await isAvailable(worker)).toBe(true);
    });

    it('a refused accept switches nobody on', async () => {
      const customer = await customerIn(t);
      const worker = await verifiedWorkerIn(t);
      const job = await postJob(t, customer);
      const offer = await sendQuote(t, worker, job.id);
      await switchOff(worker);
      await cancel(customer, job.id).expect(200);

      await acceptQuote(t, customer, job.id, offer.id).expect(409);
      expect(await isAvailable(worker)).toBe(false);
    });
  });

  describe('2. the worker always sees what became of their quote', () => {
    it('declined by the customer: push + inbox, marked on the radar, and quoting again clears it', async () => {
      const customer = await customerIn(t);
      const worker = await verifiedWorkerIn(t);
      await giveDevice(worker.userId);
      const job = await postJob(t, customer);
      const offer = await sendQuote(t, worker, job.id);

      await declineQuote(customer, job.id, offer.id).expect(200);

      const [push] = await pushesOf('QUOTE_DECLINED', job.id);
      expect(push!.notification.title).toBe('The customer declined your quote');
      expect(await inboxOf(worker.userId, 'QUOTE_DECLINED')).toHaveLength(1);
      const [card] = await feed(worker);
      expect(card).toMatchObject({
        id: job.id,
        outcome: 'QUOTE_DECLINED',
        myOffer: { status: 'REJECTED' },
      });
      expect((await lead(worker, job.id)).outcome).toBe('QUOTE_DECLINED');

      await sendQuote(t, worker, job.id, { visitFee: 200 });
      expect((await feed(worker))[0]!.outcome).toBeNull();
      expect(
        (await t.prisma.offer.findUniqueOrThrow({ where: { id: offer.id } }))
          .declinedAt,
      ).toBeNull();
    });

    it('another worker chosen: the loser is told, keeps the card marked, and cannot quote any more', async () => {
      const customer = await customerIn(t);
      const winner = await verifiedWorkerIn(t);
      const loser = await verifiedWorkerIn(t);
      const silent = await verifiedWorkerIn(t);
      await giveDevice(loser.userId);
      await giveDevice(silent.userId);
      const job = await postJob(t, customer);
      const won = await sendQuote(t, winner, job.id);
      await sendQuote(t, loser, job.id);

      await acceptQuote(t, customer, job.id, won.id).expect(200);

      const sent = await pushesOf('QUOTE_NOT_SELECTED', job.id);
      expect(sent).toHaveLength(1);
      expect(sent[0]!.tokens).toEqual([tokenOf(loser.userId)]);
      const [card] = await feed(loser);
      expect(card).toMatchObject({ id: job.id, outcome: 'TAKEN_BY_OTHER' });
      expect(card!.availability).toBeNull();
      // A worker who never quoted just loses the lead from the radar.
      expect(await feed(silent)).toEqual([]);
      const refused = await http
        .post(
          `${LEADS}/${job.id}/offers`,
          { visitFee: 100, etaMinutes: 15 },
          { token: loser.accessToken },
        )
        .expect(409);
      expect(refused.body.code).toBe('JOB_NOT_OPEN');
    });

    it('open request cancelled by the customer: quoters are told and see it marked; others are not pushed but can open it', async () => {
      const customer = await customerIn(t);
      const quoter = await verifiedWorkerIn(t);
      const looker = await verifiedWorkerIn(t);
      await giveDevice(quoter.userId);
      await giveDevice(looker.userId);
      const job = await postJob(t, customer);
      const offer = await sendQuote(t, quoter, job.id);

      await cancel(customer, job.id).expect(200);

      const sent = await pushesOf('LEAD_CANCELLED', job.id);
      expect(sent).toHaveLength(1);
      expect(sent[0]!.tokens).toEqual([tokenOf(quoter.userId)]);
      await settle();
      expect(
        t.messaging.sent.filter(
          (m) =>
            m.data.type === 'LEAD_CANCELLED' &&
            m.tokens.includes(tokenOf(looker.userId)),
        ),
      ).toEqual([]);

      const [card] = await feed(quoter);
      expect(card).toMatchObject({
        id: job.id,
        outcome: 'CANCELLED_BY_CUSTOMER',
      });
      // The worker who only got the "new job" alert opens it on what happened, not on an error.
      const opened = await lead(looker, job.id);
      expect(opened).toMatchObject({
        status: 'CANCELLED',
        outcome: 'CANCELLED_BY_CUSTOMER',
      });
      expect(await feed(looker)).toEqual([]);

      // And the API refuses a quote or a change on it, whatever the app shows.
      expect(
        (
          await http
            .post(
              `${LEADS}/${job.id}/offers`,
              { visitFee: 100, etaMinutes: 15 },
              { token: looker.accessToken },
            )
            .expect(409)
        ).body.code,
      ).toBe('JOB_NOT_OPEN');
      expect(
        (
          await http
            .patch(
              `${V1}/offers/${offer.id}`,
              { visitFee: 100 },
              { token: quoter.accessToken },
            )
            .expect(409)
        ).body.code,
      ).toBe('OFFER_NOT_PENDING');
    });

    it('expired requests are marked, and closed cards leave the radar after a day', async () => {
      const customer = await customerIn(t);
      const worker = await verifiedWorkerIn(t);
      const expiring = await postJob(t, customer, { title: 'Expiring' });
      const old = await postJob(t, customer, { title: 'Old' });
      await sendQuote(t, worker, expiring.id);
      await sendQuote(t, worker, old.id);
      await t.prisma.job.update({
        where: { id: expiring.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      await cancel(customer, old.id).expect(200);
      await t.prisma.job.update({
        where: { id: old.id },
        data: {
          cancelledAt: new Date(Date.now() - CLOSED_LEAD_VISIBLE_MS - 60_000),
        },
      });

      const items = await feed(worker);
      expect(items.map((l) => [l.id, l.outcome])).toEqual([
        [expiring.id, 'EXPIRED'],
      ]);
    });

    it('keeps newest-first order and paging across open and closed cards', async () => {
      const customer = await customerIn(t);
      const worker = await verifiedWorkerIn(t);
      const first = await postJob(t, customer, { title: 'First' });
      await sendQuote(t, worker, first.id);
      const second = await postJob(t, customer, { title: 'Second' });
      const third = await postJob(t, customer, { title: 'Third' });
      await cancel(customer, first.id).expect(200);

      const page1 = await http
        .get(`${LEADS}?limit=2`, { token: worker.accessToken })
        .expect(200);
      expect(page1.body.items.map((l: FeedItem) => l.id)).toEqual([
        third.id,
        second.id,
      ]);
      const page2 = await http
        .get(`${LEADS}?limit=2&cursor=${page1.body.nextCursor}`, {
          token: worker.accessToken,
        })
        .expect(200);
      expect(page2.body.items.map((l: FeedItem) => [l.id, l.outcome])).toEqual([
        [first.id, 'CANCELLED_BY_CUSTOMER'],
      ]);
      expect(page2.body.nextCursor).toBeNull();
    });
  });

  describe('4. GET /jobs/availability', () => {
    const check = (who: Customer, query: Record<string, string | number>) =>
      http.get(
        `${JOBS}/availability?${new URLSearchParams(
          Object.entries(query).map(([k, v]) => [k, String(v)]),
        ).toString()}`,
        { token: who.accessToken },
      );
    it('NONE when nobody offers the service there, AVAILABLE when someone free does', async () => {
      const customer = await customerIn(t);
      const areaId = customer.areaId;
      await verifiedWorkerIn(t, { trades: ['plumber'] });
      // Someone in another city does not count.
      await verifiedWorkerIn(t, {
        trades: ['electrician'],
        area: 'Phase 7',
        city: 'Mohali (SAS Nagar)',
      });

      const none = await check(customer, {
        categoryId: 'electrician',
        areaId,
        timing: 'IMMEDIATE',
      }).expect(200);
      expect(none.body).toEqual({ state: 'NONE', scheduledFor: null });

      const available = await check(customer, {
        categoryId: 'plumber',
        areaId,
        timing: 'IMMEDIATE',
      }).expect(200);
      expect(available.body.state).toBe('AVAILABLE');
    });

    it('ALL_BUSY when the only ones there are switched off, or booked at that time', async () => {
      const customer = await customerIn(t);
      const other = await customerIn(t);
      const areaId = customer.areaId;
      const offline = await verifiedWorkerIn(t);
      await switchOff(offline);
      const now = { categoryId: 'plumber', areaId, timing: 'IMMEDIATE' };
      expect((await check(customer, now).expect(200)).body.state).toBe(
        'ALL_BUSY',
      );

      // The other one is on, but out on a job right now.
      const busy = await verifiedWorkerIn(t);
      await bookNow(t, other, busy);
      expect((await check(customer, now).expect(200)).body.state).toBe(
        'ALL_BUSY',
      );

      // Checked against the time asked for: the same worker is free tomorrow.
      const tomorrow = inMinutes(26 * 60);
      const later = await check(customer, {
        ...now,
        timing: 'SCHEDULED',
        scheduledFor: tomorrow,
      }).expect(200);
      expect(later.body).toEqual({
        state: 'AVAILABLE',
        scheduledFor: new Date(tomorrow).toISOString(),
      });
    });

    it('never counts the customer themself, and checks its input', async () => {
      // One person who is both a customer and the only plumber around.
      const customer = await bothProfiles(t);
      const areaId = customer.areaId;
      expect(
        (
          await check(customer, {
            categoryId: 'plumber',
            areaId,
            timing: 'IMMEDIATE',
          }).expect(200)
        ).body.state,
      ).toBe('NONE');
      await check(customer, {
        categoryId: 'plumber',
        areaId: 999999,
        timing: 'IMMEDIATE',
      }).expect(422);
      await check(customer, {
        categoryId: 'no-such',
        areaId,
        timing: 'IMMEDIATE',
      }).expect(422);
      await check(customer, {
        categoryId: 'plumber',
        areaId,
        timing: 'SCHEDULED',
      }).expect(422);
      await check(customer, {
        categoryId: 'plumber',
        areaId,
        timing: 'IMMEDIATE',
        lat: 30.7,
      }).expect(422);
      await http.get(`${JOBS}/availability?categoryId=plumber`).expect(401);
    });
  });

  describe('5. the Wallet', () => {
    it('adds up every paid job for period=all and lists them, most recently paid first, with paging', async () => {
      const customer = await customerIn(t);
      const worker = await verifiedWorkerIn(t);
      const one = await finished(t, customer, worker, 100);
      await payFor(t, customer, one.job.id).expect(200);
      const two = await finished(t, customer, worker, 300);
      await payFor(t, customer, two.job.id, 'CASH').expect(200);
      // An old one, from before this month: in the lifetime total only.
      await t.prisma.job.update({
        where: { id: one.job.id },
        data: { completedAt: new Date('2025-01-15T10:00:00Z') },
      });

      const all = await http
        .get(`${V1}/workers/me/earnings?period=all`, {
          token: worker.accessToken,
        })
        .expect(200);
      expect(all.body).toMatchObject({
        period: 'all',
        amount: VISIT_FEE * 2 + 400,
        jobsDone: 2,
        platformFee: 0,
      });
      const month = await http
        .get(`${V1}/workers/me/earnings?period=month`, {
          token: worker.accessToken,
        })
        .expect(200);
      expect(month.body.amount).toBe(VISIT_FEE + 300);

      const page1 = await http
        .get(`${V1}/workers/me/earnings/jobs?limit=1`, {
          token: worker.accessToken,
        })
        .expect(200);
      expect(page1.body.items).toEqual([
        expect.objectContaining({
          jobId: two.job.id,
          amount: VISIT_FEE + 300,
          method: 'CASH',
          customerName: expect.any(String),
          category: expect.objectContaining({ id: 'plumber' }),
        }),
      ]);
      const page2 = await http
        .get(
          `${V1}/workers/me/earnings/jobs?limit=1&cursor=${page1.body.nextCursor}`,
          { token: worker.accessToken },
        )
        .expect(200);
      expect(page2.body.items.map((j: { jobId: string }) => j.jobId)).toEqual([
        one.job.id,
      ]);
      expect(page2.body.items[0].completedAt).toBe('2025-01-15T10:00:00.000Z');
      expect(page2.body.nextCursor).toBeNull();
    });

    it('lists only paid jobs of this worker, and needs a worker profile', async () => {
      const customer = await customerIn(t);
      const worker = await verifiedWorkerIn(t);
      const other = await verifiedWorkerIn(t);
      await finished(t, customer, worker); // done, not paid yet
      const paid = await finished(t, customer, other);
      await payFor(t, customer, paid.job.id).expect(200);

      const mine = await http
        .get(`${V1}/workers/me/earnings/jobs`, { token: worker.accessToken })
        .expect(200);
      expect(mine.body).toEqual({ items: [], nextCursor: null });
      await http
        .get(`${V1}/workers/me/earnings/jobs`, { token: customer.accessToken })
        .expect(403);
      await http
        .get(`${V1}/workers/me/earnings?period=year`, {
          token: worker.accessToken,
        })
        .expect(422);
    });
  });
});
