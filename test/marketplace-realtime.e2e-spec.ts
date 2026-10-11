import { JobExpiryService } from '../src/modules/jobs/job-expiry.service.js';
import { seedReferenceData } from '../prisma/seed/reference-data.js';
import { api, createTestApp, type TestApp } from './helpers/app.js';
import { resetDatabase } from './helpers/db.js';
import {
  customerIn,
  postJob,
  sendQuote,
  verifiedWorkerIn,
  type Customer,
  type Worker,
} from './helpers/marketplace.js';
import { closeAllSockets, connect, record } from './helpers/socket.js';

const V1 = '/api/v1';
const JOBS = `${V1}/jobs`;

/** Everything a person's phone would have received, so tests can assert who heard what. */
type Inbox = ReturnType<typeof record>;

describe('marketplace push events (e2e, real WebSocket connections)', () => {
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

  const listen = async (who: { accessToken: string }): Promise<Inbox> =>
    record(await connect(t, who.accessToken));
  const settle = () => new Promise((resolve) => setTimeout(resolve, 250));

  /** A customer and four plumbers: two who will quote, one who stays quiet, one in a different trade. */
  async function scene() {
    const customer = await customerIn(t);
    const a = await verifiedWorkerIn(t, { fullName: 'Alpha' });
    const b = await verifiedWorkerIn(t, { fullName: 'Bravo' });
    const quiet = await verifiedWorkerIn(t, { fullName: 'Quiet' });
    const sparky = await verifiedWorkerIn(t, {
      fullName: 'Sparky',
      trades: ['electrician'],
    });
    return {
      customer,
      a,
      b,
      quiet,
      sparky,
      inbox: {
        customer: await listen(customer),
        a: await listen(a),
        b: await listen(b),
        quiet: await listen(quiet),
        sparky: await listen(sparky),
      },
    };
  }

  const secretsIn = (customer: Customer, extra: string[] = []) => [
    'House #1402',
    'Near Subhash Park',
    'addressLine',
    customer.phone,
    'arrivalCode',
    ...extra,
  ];
  const expectNoSecrets = (inboxes: Inbox[], secrets: string[]) => {
    for (const inbox of inboxes) {
      const text = JSON.stringify(inbox.received);
      for (const secret of secrets) expect(text).not.toContain(secret);
    }
  };

  describe('a new request', () => {
    it('reaches every covering plumber, and nobody else', async () => {
      const s = await scene();
      const job = await postJob(t, s.customer, {
        title: 'Pipe burst',
        description: 'Water everywhere',
      });

      for (const worker of [s.inbox.a, s.inbox.b, s.inbox.quiet]) {
        const [lead] = await worker.waitFor('lead.new');
        expect(lead).toEqual({
          id: job.id,
          title: 'Pipe burst',
          categoryId: 'plumber',
          areaName: 'Sector 22',
          distanceKm: null,
          urgency: 'IMMEDIATE',
          postedAt: expect.any(String),
          hasVoiceNote: false,
          offersCount: 0,
          isDirect: false,
        });
      }
      await settle();
      expect(s.inbox.sparky.matching('lead.new')).toEqual([]); // wrong trade
      expect(s.inbox.customer.matching('lead.new')).toEqual([]); // not their own broadcast
      expectNoSecrets(
        [s.inbox.a, s.inbox.b, s.inbox.quiet],
        secretsIn(s.customer, ['Water everywhere']),
      );
    });

    it('sends nothing when the request is rejected', async () => {
      const s = await scene();
      await http
        .post(
          JOBS,
          {
            categoryId: 'plumber',
            title: '   ',
            timing: 'IMMEDIATE',
            addressId: s.customer.addressId,
          },
          { token: s.customer.accessToken },
        )
        .expect(422);
      await settle();
      for (const inbox of [s.inbox.a, s.inbox.b, s.inbox.quiet])
        expect(inbox.received).toEqual([]);
    });

    it('does not tell an unverified worker', async () => {
      const customer = await customerIn(t);
      const pending = await verifiedWorkerIn(t, { verified: false });
      const inbox = await listen(pending);
      await postJob(t, customer);
      await settle();
      expect(inbox.received).toEqual([]);
    });

    it('delivers to every device of a worker', async () => {
      const customer = await customerIn(t);
      const worker = await verifiedWorkerIn(t);
      const phone = await listen(worker);
      const tablet = await listen(worker);
      await postJob(t, customer);
      expect(await phone.waitFor('lead.new')).toHaveLength(1);
      expect(await tablet.waitFor('lead.new')).toHaveLength(1);
    });
  });

  describe('quotes', () => {
    it("a new quote reaches the customer only, with the worker's name and rating", async () => {
      const s = await scene();
      await t.prisma.workerProfile.update({
        where: { userId: s.a.userId },
        data: { ratingSum: 49, reviewCount: 10 },
      });
      const job = await postJob(t, s.customer);
      const quote = await sendQuote(t, s.a, job.id, {
        visitFee: 230,
        etaMinutes: 30,
        message: 'Coming',
      });

      const [event] = await s.inbox.customer.waitFor('offer.new');
      expect(event).toEqual({
        jobId: job.id,
        offerId: quote.id,
        visitFee: 230,
        etaMinutes: 30,
        message: 'Coming',
        status: 'PENDING',
        worker: {
          id: s.a.userId,
          name: 'Alpha',
          rating: 4.9,
          reviewsCount: 10,
        },
      });
      await settle();
      for (const other of [s.inbox.a, s.inbox.b, s.inbox.quiet, s.inbox.sparky])
        expect(other.matching('offer.new')).toEqual([]);
      expectNoSecrets([s.inbox.customer], [s.a.phone]); // the compare screen gets the phone over REST, not in pushes
    });

    it('revising and withdrawing tell the customer', async () => {
      const s = await scene();
      const job = await postJob(t, s.customer);
      const quote = await sendQuote(t, s.a, job.id);

      await http
        .patch(
          `${V1}/offers/${quote.id}`,
          { visitFee: 180 },
          { token: s.a.accessToken },
        )
        .expect(200);
      await http
        .delete(`${V1}/offers/${quote.id}`, { token: s.a.accessToken })
        .expect(204);

      const updates = await s.inbox.customer.waitFor('offer.updated', 2);
      expect(updates.map((u) => [u.visitFee, u.status])).toEqual([
        [180, 'PENDING'],
        [180, 'WITHDRAWN'],
      ]);
    });
  });

  describe('accepting a quote', () => {
    it('tells the winner, the rejected, the rest of the radar and the customer, each exactly what they need', async () => {
      const s = await scene();
      const job = await postJob(t, s.customer);
      const qa = await sendQuote(t, s.a, job.id);
      const qb = await sendQuote(t, s.b, job.id);
      await http
        .post(
          `${JOBS}/${job.id}/offers/${qa.id}/accept`,
          {},
          { token: s.customer.accessToken },
        )
        .expect(200);

      // Winner
      expect(await s.inbox.a.waitFor('offer.accepted')).toEqual([
        { jobId: job.id, offerId: qa.id },
      ]);
      expect((await s.inbox.a.waitFor('job.status'))[0]).toMatchObject({
        jobId: job.id,
        status: 'ASSIGNED',
      });
      // Loser who had quoted
      expect(await s.inbox.b.waitFor('offer.rejected')).toEqual([
        { jobId: job.id, offerId: qb.id },
      ]);
      // Worker who never quoted: the lead simply disappears
      expect(await s.inbox.quiet.waitFor('lead.closed')).toEqual([
        { id: job.id, reason: 'ASSIGNED' },
      ]);
      // Customer
      expect((await s.inbox.customer.waitFor('job.status'))[0]).toMatchObject({
        jobId: job.id,
        status: 'ASSIGNED',
      });

      await settle();
      expect(s.inbox.a.matching('lead.closed')).toEqual([]); // got the specific message instead
      expect(s.inbox.b.matching('lead.closed')).toEqual([]);
      expect(s.inbox.b.matching('job.status')).toEqual([]); // not involved any more
      expect(
        s.inbox.sparky.received.filter((r) => r.event !== 'lead.new'),
      ).toEqual([]);
      expect(s.inbox.quiet.matching('job.status')).toEqual([]);
      // No one in the radar ever receives the arrival code or the address.
      expectNoSecrets(
        [s.inbox.a, s.inbox.b, s.inbox.quiet, s.inbox.sparky],
        secretsIn(s.customer),
      );
      expect(JSON.stringify(s.inbox.customer.received)).not.toContain(
        'arrivalCode',
      );
    });
  });

  describe('a request that ends without a worker', () => {
    it('cancelling removes the lead from every radar and tells the customer', async () => {
      const s = await scene();
      const job = await postJob(t, s.customer);
      await http
        .post(`${JOBS}/${job.id}/cancel`, {}, { token: s.customer.accessToken })
        .expect(200);

      for (const worker of [s.inbox.a, s.inbox.b, s.inbox.quiet]) {
        expect(await worker.waitFor('lead.closed')).toEqual([
          { id: job.id, reason: 'CANCELLED' },
        ]);
      }
      expect((await s.inbox.customer.waitFor('job.status'))[0]).toMatchObject({
        status: 'CANCELLED',
      });
    });

    it('expiry does the same with reason EXPIRED', async () => {
      const s = await scene();
      const job = await postJob(t, s.customer);
      await t.prisma.job.update({
        where: { id: job.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      await t.app.get(JobExpiryService).expireOverdue();

      for (const worker of [s.inbox.a, s.inbox.quiet]) {
        expect(await worker.waitFor('lead.closed')).toEqual([
          { id: job.id, reason: 'EXPIRED' },
        ]);
      }
      expect((await s.inbox.customer.waitFor('job.status'))[0]).toMatchObject({
        status: 'CANCELLED',
      });
    });
  });

  describe('direct booking', () => {
    const book = (s: Awaited<ReturnType<typeof scene>>, worker: Worker) =>
      http.post(
        `${JOBS}/direct-booking`,
        {
          workerId: worker.userId,
          categoryId: 'plumber',
          title: 'Geyser',
          timing: 'IMMEDIATE',
          addressId: s.customer.addressId,
        },
        { token: s.customer.accessToken },
      );

    it('the request reaches only the requested worker', async () => {
      const s = await scene();
      const res = await book(s, s.a).expect(201);

      const [request] = await s.inbox.a.waitFor('direct.request');
      expect(request).toMatchObject({
        id: res.body.id,
        isDirect: true,
        title: 'Geyser',
        categoryId: 'plumber',
      });
      expect(request.expiresAt).toEqual(expect.any(String));
      await settle();
      for (const other of [
        s.inbox.b,
        s.inbox.quiet,
        s.inbox.sparky,
        s.inbox.customer,
      ]) {
        expect(other.received).toEqual([]);
      }
      expectNoSecrets([s.inbox.a], secretsIn(s.customer));
    });

    it('accepting tells the customer; the other plumbers hear nothing at all', async () => {
      const s = await scene();
      const res = await book(s, s.a).expect(201);
      await http
        .post(
          `${JOBS}/${res.body.id}/direct/accept`,
          {},
          { token: s.a.accessToken },
        )
        .expect(200);

      expect((await s.inbox.customer.waitFor('job.status'))[0]).toMatchObject({
        jobId: res.body.id,
        status: 'ASSIGNED',
      });
      expect((await s.inbox.a.waitFor('job.status'))[0]).toMatchObject({
        status: 'ASSIGNED',
      });
      await settle();
      expect(s.inbox.b.received).toEqual([]);
      expect(s.inbox.quiet.received).toEqual([]);
    });

    it('declining tells the customer to pick someone else', async () => {
      const s = await scene();
      const res = await book(s, s.a).expect(201);
      await http
        .post(
          `${JOBS}/${res.body.id}/direct/decline`,
          {},
          { token: s.a.accessToken },
        )
        .expect(200);

      expect(await s.inbox.customer.waitFor('direct.declined')).toEqual([
        { jobId: res.body.id },
      ]);
      expect((await s.inbox.customer.waitFor('job.status'))[0]).toMatchObject({
        status: 'CANCELLED',
      });
      await settle();
      expect(s.inbox.b.received).toEqual([]);
    });

    it('an unanswered request tells the customer it expired, and clears it from the worker', async () => {
      const s = await scene();
      const res = await book(s, s.a).expect(201);
      await t.prisma.job.update({
        where: { id: res.body.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      await t.app.get(JobExpiryService).expireOverdue();

      expect(await s.inbox.customer.waitFor('direct.expired')).toEqual([
        { jobId: res.body.id },
      ]);
      expect(await s.inbox.a.waitFor('lead.closed')).toEqual([
        { id: res.body.id, reason: 'EXPIRED' },
      ]);
      await settle();
      expect(s.inbox.b.received).toEqual([]);
    });
  });
});
