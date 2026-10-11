// K-36: when a verified worker changes their name or photo they go back for review (D-8) and disappear from
// customers. Quotes they sent that are still waiting must disappear with them, from the list, from every
// "how many quotes" number, and from acceptance, until they are verified again. A worker who was already
// CHOSEN is never affected: a re-review must not strand a customer mid-job.

import { seedReferenceData } from '../prisma/seed/reference-data.js';
import { api, createTestApp, type TestApp } from './helpers/app.js';
import { loginAs } from './helpers/auth.js';
import { resetDatabase } from './helpers/db.js';
import { nextPhone } from './helpers/factories.js';
import { V1 } from './helpers/fulfilment.js';
import {
  customerIn,
  postJob,
  sendQuote,
  verifiedWorkerIn,
  type Customer,
  type Worker,
} from './helpers/marketplace.js';
import { acceptQuote } from './helpers/scheduling.js';

describe('K-36: quotes of a worker who is under review are hidden and cannot be accepted (e2e)', () => {
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
  });

  /** A customer with an open request and quotes from two verified plumbers: w1 faster (15 min), w2 slower (30). */
  async function scene() {
    const customer = await customerIn(t);
    const w1 = await verifiedWorkerIn(t, { fullName: 'Rajesh Kumar' });
    const w2 = await verifiedWorkerIn(t, { fullName: 'Sunil Verma' });
    const job = await postJob(t, customer);
    const q1 = await sendQuote(t, w1, job.id, {
      etaMinutes: 15,
      visitFee: 200,
    });
    const q2 = await sendQuote(t, w2, job.id, {
      etaMinutes: 30,
      visitFee: 300,
    });
    return { customer, w1, w2, job, q1, q2 };
  }

  const offersOf = async (customer: Customer, jobId: string) =>
    (
      await http
        .get(`${V1}/jobs/${jobId}/offers`, { token: customer.accessToken })
        .expect(200)
    ).body as {
      offerId: string;
      status: string;
      isFastest: boolean;
      worker: { id: string };
    }[];
  const countsSeenBy = async (
    customer: Customer,
    other: Worker,
    jobId: string,
  ) => ({
    jobView: (
      await http
        .get(`${V1}/jobs/${jobId}`, { token: customer.accessToken })
        .expect(200)
    ).body.offersCount,
    customerList: (
      await http
        .get(`${V1}/customers/me/jobs`, { token: customer.accessToken })
        .expect(200)
    ).body.items.find((j: { id: string }) => j.id === jobId).offersCount,
    leadCard: (
      await http
        .get(`${V1}/leads/${jobId}`, { token: other.accessToken })
        .expect(200)
    ).body.offersCount,
  });
  const rename = (worker: Worker, fullName = 'A Completely Different Name') =>
    http
      .patch(`${V1}/workers/me`, { fullName }, { token: worker.accessToken })
      .expect(200);
  const status = (worker: Worker) =>
    t.prisma.workerProfile
      .findUniqueOrThrow({ where: { userId: worker.userId } })
      .then((p) => p.verificationStatus);

  it('baseline: two verified workers, two quotes, counted and listed everywhere', async () => {
    const { customer, w2, job, q1, q2 } = await scene();
    const offers = await offersOf(customer, job.id);
    expect(offers.map((o) => o.offerId).sort()).toEqual([q1.id, q2.id].sort());
    expect(await countsSeenBy(customer, w2, job.id)).toEqual({
      jobView: 2,
      customerList: 2,
      leadCard: 2,
    });
  });

  it('a worker sent back for review disappears from the quote list and from every quote count', async () => {
    const { customer, w1, w2, job, q2 } = await scene();
    await rename(w1);
    expect(await status(w1)).toBe('PENDING');

    const offers = await offersOf(customer, job.id);
    expect(offers.map((o) => o.offerId)).toEqual([q2.id]);
    expect(offers[0]!.worker.id).toBe(w2.userId);
    // "Fastest" is judged among the quotes the customer can actually see.
    expect(offers[0]!.isFastest).toBe(true);
    // The three numbers a quote count appears in all agree with the list: the customer's job view, the
    // customer's activity list, and the card other workers see on the lead.
    expect(await countsSeenBy(customer, w2, job.id)).toEqual({
      jobView: 1,
      customerList: 1,
      leadCard: 1,
    });
    // Nothing leaks the hidden quote's worker, in any form.
    const everything = JSON.stringify(
      await http
        .get(`${V1}/jobs/${job.id}/offers`, { token: customer.accessToken })
        .then((r) => r.body),
    );
    expect(everything).not.toContain(w1.userId);
    expect(everything).not.toContain('A Completely Different Name');
  });

  it('a quote of a worker under review cannot be accepted: 409 OFFER_UNAVAILABLE, and nothing changes', async () => {
    const { customer, w1, job, q1, q2 } = await scene();
    await rename(w1);

    const res = await acceptQuote(t, customer, job.id, q1.id);
    expect([res.status, res.body.code]).toEqual([409, 'OFFER_UNAVAILABLE']);
    // The message does not say why (that a worker is under review is not the customer's business).
    expect(JSON.stringify(res.body)).not.toMatch(/review|verif|pending/i);

    const after = await t.prisma.job.findUniqueOrThrow({
      where: { id: job.id },
      include: { billItems: true },
    });
    expect(after).toMatchObject({
      status: 'OPEN',
      workerId: null,
      acceptedOfferId: null,
      arrivalCode: null,
    });
    expect(after.billItems).toEqual([]);
    const rows = await t.prisma.offer.findMany({
      where: { jobId: job.id },
      orderBy: { id: 'asc' },
    });
    expect(rows.map((o) => [o.id, o.status]).sort()).toEqual(
      [
        [q1.id, 'PENDING'],
        [q2.id, 'PENDING'],
      ].sort(),
    );
  });

  it('the same for a REJECTED worker (any status other than VERIFIED hides the quote)', async () => {
    const { customer, w1, job, q1 } = await scene();
    await t.prisma.workerProfile.update({
      where: { userId: w1.userId },
      data: {
        verificationStatus: 'REJECTED',
        rejectionReason: 'Photo unclear',
      },
    });
    expect(
      (await offersOf(customer, job.id)).map((o) => o.worker.id),
    ).not.toContain(w1.userId);
    expect((await acceptQuote(t, customer, job.id, q1.id)).body.code).toBe(
      'OFFER_UNAVAILABLE',
    );
  });

  it('it applies to every request the worker has quoted on, not just one', async () => {
    const { customer, w1, job } = await scene();
    const second = await postJob(t, customer, { title: 'A second request' });
    await sendQuote(t, w1, second.id);
    await rename(w1);
    expect(await offersOf(customer, job.id).then((o) => o.length)).toBe(1);
    expect(await offersOf(customer, second.id)).toEqual([]);
  });

  it('the quotes come back by themselves when the worker is verified again, and can then be accepted', async () => {
    const { customer, w1, w2, job, q1 } = await scene();
    await rename(w1);
    expect((await offersOf(customer, job.id)).length).toBe(1);

    // An admin approves again (both Aadhaar images must be on file).
    await t.prisma.workerDocument.createMany({
      data: [
        { workerId: w1.userId, type: 'AADHAAR_FRONT', storageKey: 'k1' },
        { workerId: w1.userId, type: 'AADHAAR_BACK', storageKey: 'k2' },
      ],
    });
    const admin = await loginAs(t, nextPhone());
    await t.prisma.user.update({
      where: { id: admin.userId },
      data: { isAdmin: true },
    });
    await http
      .post(
        `${V1}/admin/workers/${w1.userId}/verify`,
        {},
        { token: admin.accessToken },
      )
      .expect(200);

    const offers = await offersOf(customer, job.id);
    expect(offers.length).toBe(2);
    expect(offers.find((o) => o.offerId === q1.id)!.isFastest).toBe(true);
    expect(await countsSeenBy(customer, w2, job.id)).toEqual({
      jobView: 2,
      customerList: 2,
      leadCard: 2,
    });

    const accepted = await acceptQuote(t, customer, job.id, q1.id).expect(200);
    expect(accepted.body.status).toBe('ASSIGNED');
  });

  it('a worker who was already CHOSEN is not affected by a later re-review: their accepted quote stays visible and counted', async () => {
    const { customer, w1, w2, job, q1 } = await scene();
    await acceptQuote(t, customer, job.id, q1.id).expect(200);
    await rename(w1);
    expect(await status(w1)).toBe('PENDING');

    const offers = await offersOf(customer, job.id);
    expect(offers.map((o) => [o.offerId, o.status])).toEqual([
      [q1.id, 'ACCEPTED'],
    ]);
    expect((await countsSeenBy(customer, w2, job.id)).jobView).toBe(1);
    const view = await http
      .get(`${V1}/jobs/${job.id}`, { token: customer.accessToken })
      .expect(200);
    expect(view.body).toMatchObject({
      status: 'ASSIGNED',
      worker: { id: w1.userId },
    });
  });

  it('the worker still sees their own waiting quote in their activity (they are not told it vanished)', async () => {
    const { w1, q1 } = await scene();
    await rename(w1);
    const mine = await http
      .get(`${V1}/workers/me/jobs`, { token: w1.accessToken })
      .expect(200);
    expect(
      mine.body.pendingQuotes.map((q: { offerId: string }) => q.offerId),
    ).toContain(q1.id);
  });

  it('while still verified, nothing changes: accepting works as before', async () => {
    const { customer, job, q2 } = await scene();
    const accepted = await acceptQuote(t, customer, job.id, q2.id).expect(200);
    expect(accepted.body.status).toBe('ASSIGNED');
  });
});
