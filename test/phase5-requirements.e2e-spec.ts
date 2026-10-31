// The Phase 5 requirements carried over from the scheduling work (docs/07-roadmap.md "Phase 5 must").
// This file began as 22 `todo` entries. Each is now a real test that exercises the behaviour through the
// real HTTP API, the real PostgreSQL constraints and real WebSockets. Deeper coverage of the same
// endpoints (photos, validation, races, SOS, tracking numbers) lives in fulfilment.e2e-spec.ts.

import { seedReferenceData } from '../prisma/seed/reference-data.js';
import { LeadCatchUpService } from '../src/modules/offers/lead-catch-up.service.js';
import { violatesConstraint } from '../src/common/utils/db-errors.js';
import { api, createTestApp, type TestApp } from './helpers/app.js';
import { resetDatabase } from './helpers/db.js';
import {
  bookingWindow,
  makeCustomer,
  makeJob,
  makeWorker,
} from './helpers/factories.js';
import {
  V1,
  VISIT_FEE,
  approveBill,
  arriveAt,
  assigned,
  bothProfiles,
  completeWork,
  addProofPhoto,
  withProofPhotos,
  customerIn,
  finished,
  onSite,
  payFor,
  putItems,
  scheduledOnSite,
  statusOf,
  underWay,
  verifiedWorkerIn,
} from './helpers/fulfilment.js';
import { postJob, sendQuote } from './helpers/marketplace.js';
import {
  MINUTE,
  acceptQuote,
  book,
  inMinutes,
  scheduleOf,
  scheduledJob,
} from './helpers/scheduling.js';
import { closeAllSockets, connect, record } from './helpers/socket.js';

type Inbox = ReturnType<typeof record>;

describe('Phase 5 requirements carried over from scheduling (e2e, real PostgreSQL and WebSockets)', () => {
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
  const wrongCodeFor = (code: string) => (code === '0000' ? '1111' : '0000');

  // ───────────────────────── endpoints that did not exist before ─────────────────────────

  describe('the endpoints', () => {
    it("POST /jobs/:id/arrival: the assigned worker enters the customer's 4-digit code (5 wrong tries lock it) -> ARRIVED", async () => {
      const customer = await customerIn(t);
      const worker = await verifiedWorkerIn(t);
      const { job, code } = await assigned(t, customer, worker);
      const events = await listen(customer);

      // The worker is never shown the code.
      const asWorker = await http
        .get(`${V1}/jobs/${job.id}`, { token: worker.accessToken })
        .expect(200);
      expect(JSON.stringify(asWorker.body)).not.toContain('arrivalCode');
      expect(JSON.stringify(asWorker.body)).not.toContain(code + '"');

      // Four wrong tries are refused, each saying how many are left...
      for (const left of [4, 3, 2, 1]) {
        const res = await arriveAt(
          t,
          worker,
          job.id,
          wrongCodeFor(code),
        ).expect(422);
        expect(res.body.code).toBe('ARRIVAL_CODE_INVALID');
        expect(res.body.details[0].issue).toContain(
          `${left} ${left === 1 ? 'try' : 'tries'} left`,
        );
        expect(await statusOf(t, job.id)).toBe('ASSIGNED');
      }
      // ...and the fifth try may still be the right one.
      const arrived = await arriveAt(t, worker, job.id, code).expect(200);
      expect(arrived.body).toMatchObject({
        status: 'ARRIVED',
        viewer: 'worker',
      });
      expect(arrived.body.arrivedAt).toEqual(expect.any(String));

      const [status] = await events.waitFor('job.status');
      expect(status).toMatchObject({ jobId: job.id, status: 'ARRIVED' });
      expect(
        (await t.prisma.job.findUniqueOrThrow({ where: { id: job.id } }))
          .arrivalAttempts,
      ).toBe(5);
    });

    it('five wrong codes lock the job: even the right code is then refused, and parallel guesses cannot beat the limit', async () => {
      const customer = await customerIn(t);
      const worker = await verifiedWorkerIn(t);
      const { job, code } = await assigned(t, customer, worker);

      for (let i = 1; i <= 4; i += 1)
        await arriveAt(t, worker, job.id, wrongCodeFor(code)).expect(422);
      const fifth = await arriveAt(
        t,
        worker,
        job.id,
        wrongCodeFor(code),
      ).expect(429);
      expect(fifth.body.code).toBe('CODE_LOCKED');
      const afterwards = await arriveAt(t, worker, job.id, code).expect(429);
      expect(afterwards.body.code).toBe('CODE_LOCKED');
      expect(await statusOf(t, job.id)).toBe('ASSIGNED');

      // A burst of parallel guesses on a fresh job still cannot exceed five tries in total.
      const other = await customerIn(t);
      const worker2 = await verifiedWorkerIn(t);
      const second = await assigned(t, other, worker2);
      const burst = await Promise.all(
        Array.from({ length: 10 }, () =>
          arriveAt(t, worker2, second.job.id, wrongCodeFor(second.code)),
        ),
      );
      expect(burst.some((r) => r.status === 200)).toBe(false);
      expect(burst.every((r) => r.status === 422 || r.status === 429)).toBe(
        true,
      );
      expect(burst.filter((r) => r.status === 422).length).toBeLessThanOrEqual(
        4,
      );
      expect(
        (await t.prisma.job.findUniqueOrThrow({ where: { id: second.job.id } }))
          .arrivalAttempts,
      ).toBe(5);
    });

    it('PUT /jobs/:id/bill-items, GET /jobs/:id/bill, POST /jobs/:id/bill/approve -> IN_PROGRESS', async () => {
      const customer = await customerIn(t);
      const worker = await verifiedWorkerIn(t);
      const { job } = await onSite(t, customer, worker);
      const events = await listen(customer);

      // Right after arriving the bill is just the visit fee the quote promised.
      const start = await http
        .get(`${V1}/jobs/${job.id}/bill`, { token: customer.accessToken })
        .expect(200);
      expect(start.body).toMatchObject({
        total: VISIT_FEE,
        platformFee: 0,
        approved: false,
        payTo: { name: 'Test Worker' },
      });
      expect(start.body.items.map((i: { kind: string }) => i.kind)).toEqual([
        'VISIT_FEE',
      ]);

      // The worker proposes parts and labour; setting items again REPLACES the previous list.
      await putItems(t, worker, job.id, [
        { kind: 'PARTS', description: 'Brass tap', amount: 400 },
        { kind: 'LABOUR', description: 'Fitting', amount: 150 },
      ]).expect(200);
      const replaced = await putItems(t, worker, job.id, [
        { kind: 'PARTS', description: 'PVC elbow', amount: 300 },
      ]).expect(200);
      expect(replaced.body.total).toBe(VISIT_FEE + 300);
      expect(replaced.body.items).toHaveLength(2);
      const [update] = (await events.waitFor('bill.updated', 2)).slice(-1);
      expect(update).toEqual({ jobId: job.id, total: VISIT_FEE + 300 });

      // The customer must approve the total they actually saw.
      const stale = await approveBill(t, customer, job.id, VISIT_FEE).expect(
        409,
      );
      expect(stale.body.code).toBe('BILL_CHANGED');
      expect(await statusOf(t, job.id)).toBe('ARRIVED');

      const approved = await approveBill(
        t,
        customer,
        job.id,
        VISIT_FEE + 300,
      ).expect(200);
      expect(approved.body).toMatchObject({
        approved: true,
        status: 'IN_PROGRESS',
        total: 550,
      });
      expect(await statusOf(t, job.id)).toBe('IN_PROGRESS');

      // From now on the bill is frozen.
      const late = await putItems(t, worker, job.id, []).expect(409);
      expect(late.body.code).toBe('INVALID_TRANSITION');
      await approveBill(t, customer, job.id, 550).expect(409);
      expect(
        (
          await http
            .get(`${V1}/jobs/${job.id}/bill`, { token: worker.accessToken })
            .expect(200)
        ).body.total,
      ).toBe(550);
    });

    it('POST /jobs/:id/complete-work -> WORK_COMPLETED', async () => {
      const customer = await customerIn(t);
      const worker = await verifiedWorkerIn(t);
      const made = await onSite(t, customer, worker);

      // Not before the customer has approved the cost.
      await http
        .post(
          `${V1}/jobs/${made.job.id}/complete-work`,
          {},
          { token: worker.accessToken },
        )
        .expect(409);
      await putItems(t, worker, made.job.id, []).expect(200);
      await approveBill(t, customer, made.job.id, VISIT_FEE).expect(200);

      // Proof of work is compulsory: no photos, or only a "before" one, is refused.
      const none = await completeWork(t, worker, made.job.id).expect(409);
      expect(none.body.code).toBe('WORK_PHOTOS_REQUIRED');
      await addProofPhoto(t, worker, made.job.id, 'BEFORE');
      const half = await completeWork(t, worker, made.job.id).expect(409);
      expect(half.body.code).toBe('WORK_PHOTOS_REQUIRED');
      expect(await statusOf(t, made.job.id)).toBe('IN_PROGRESS');
      await withProofPhotos(t, worker, made.job.id);

      const events = await listen(customer);
      const done = await completeWork(t, worker, made.job.id).expect(200);
      expect(done.body.status).toBe('WORK_COMPLETED');
      const row = await t.prisma.job.findUniqueOrThrow({
        where: { id: made.job.id },
      });
      expect(row.workCompletedAt).toBeInstanceOf(Date);
      expect((await events.waitFor('job.status'))[0]).toMatchObject({
        status: 'WORK_COMPLETED',
      });
      await completeWork(t, worker, made.job.id).expect(409); // not twice
    });

    it('POST /jobs/:id/payment (UPI / cash, total computed on the server, idempotent) -> COMPLETED, and GET /jobs/:id/receipt', async () => {
      const customer = await customerIn(t);
      const worker = await verifiedWorkerIn(t);
      const made = await underWay(t, customer, worker, 300);

      // Not before the work is done, and the amount cannot be sent by the app.
      await payFor(t, customer, made.job.id).expect(409);
      await withProofPhotos(t, worker, made.job.id);
      await completeWork(t, worker, made.job.id).expect(200);
      await http
        .post(
          `${V1}/jobs/${made.job.id}/payment`,
          { method: 'UPI', amount: 1 },
          { token: customer.accessToken },
        )
        .expect(422);
      await http
        .post(
          `${V1}/jobs/${made.job.id}/payment`,
          { method: 'BITCOIN' },
          { token: customer.accessToken },
        )
        .expect(422);
      await http
        .get(`${V1}/jobs/${made.job.id}/receipt`, {
          token: customer.accessToken,
        })
        .expect(409);

      const paid = await payFor(t, customer, made.job.id, 'UPI').expect(200);
      expect(paid.body).toMatchObject({
        status: 'COMPLETED',
        method: 'UPI',
        amount: made.total,
        platformFee: 0,
      });
      expect(await statusOf(t, made.job.id)).toBe('COMPLETED');

      // A second tap (even choosing cash) returns the first payment unchanged.
      const again = await payFor(t, customer, made.job.id, 'CASH').expect(200);
      expect(again.body).toEqual(paid.body);
      expect(
        await t.prisma.payment.count({ where: { jobId: made.job.id } }),
      ).toBe(1);

      // Ten simultaneous taps on another job still record exactly one payment.
      const other = await customerIn(t);
      const second = await finished(t, other, worker, 100);
      const taps = await Promise.all(
        Array.from({ length: 10 }, () =>
          payFor(t, other, second.job.id, 'CASH'),
        ),
      );
      expect(taps.every((r) => r.status === 200)).toBe(true);
      expect(
        await t.prisma.payment.count({ where: { jobId: second.job.id } }),
      ).toBe(1);

      // The receipt, for both people.
      for (const who of [customer, worker]) {
        const receipt = await http
          .get(`${V1}/jobs/${made.job.id}/receipt`, { token: who.accessToken })
          .expect(200);
        expect(receipt.body).toMatchObject({
          receiptNo: expect.stringMatching(/^KC-\d+$/),
          platformFee: 0,
          total: made.total,
          method: 'UPI',
          customer: { name: 'Sunita Sharma' },
          worker: { name: 'Test Worker' },
        });
        expect(
          receipt.body.items.reduce(
            (s: number, i: { amount: number }) => s + i.amount,
            0,
          ),
        ).toBe(made.total);
        expect(JSON.stringify(receipt.body)).not.toContain('House #1402');
      }
    });

    it('GET /jobs/:id/tracking shows the assigned worker and the arrival code to the customer only', async () => {
      const customer = await customerIn(t);
      const worker = await verifiedWorkerIn(t);
      const { job, code } = await assigned(t, customer, worker);

      const forCustomer = await http
        .get(`${V1}/jobs/${job.id}/tracking`, { token: customer.accessToken })
        .expect(200);
      expect(forCustomer.body).toMatchObject({
        status: 'ASSIGNED',
        arrivalCode: code,
        worker: {
          name: 'Test Worker',
          trade: 'Plumber',
          verified: true,
          phone: worker.phone,
        },
        // No fix has been reported and no place has coordinates, so nothing is claimed.
        location: null,
        distanceKm: null,
        etaMinutes: null,
        distanceBasis: null,
      });
      const forWorker = await http
        .get(`${V1}/jobs/${job.id}/tracking`, { token: worker.accessToken })
        .expect(200);
      expect(forWorker.body.customer).toEqual({ name: 'Sunita Sharma' });
      expect(JSON.stringify(forWorker.body)).not.toContain('arrivalCode');

      const stranger = await customerIn(t);
      await http
        .get(`${V1}/jobs/${job.id}/tracking`, { token: stranger.accessToken })
        .expect(404);
    });

    it('POST /jobs/:id/sos stores the alert, tells the safety desk, and is limited to the two people on the job', async () => {
      const customer = await customerIn(t);
      const worker = await verifiedWorkerIn(t);
      const { job } = await assigned(t, customer, worker);

      const res = await http
        .post(
          `${V1}/jobs/${job.id}/sos`,
          { lat: 30.73, lng: 76.78 },
          { token: customer.accessToken },
        )
        .expect(201);
      expect(res.body).toMatchObject({
        alertId: expect.any(String),
        repeated: false,
      });
      const alert = await t.prisma.sosAlert.findUniqueOrThrow({
        where: { id: res.body.alertId },
      });
      expect(alert).toMatchObject({
        userId: customer.userId,
        jobId: job.id,
        status: 'OPEN',
        lat: 30.73,
        lng: 76.78,
      });

      expect(t.safety.sent).toHaveLength(1);
      expect(t.safety.sent[0]).toMatchObject({
        alertId: res.body.alertId,
        raisedBy: { role: 'CUSTOMER', phone: customer.phone },
        otherParty: { role: 'WORKER', phone: worker.phone },
        location: { source: 'REPORTED', lat: 30.73, lng: 76.78 },
        address: { line: 'House #1402, Near Subhash Park', area: 'Sector 22' },
      });

      const stranger = await customerIn(t);
      await http
        .post(`${V1}/jobs/${job.id}/sos`, {}, { token: stranger.accessToken })
        .expect(404);
    });

    it("GET /workers/me/jobs lists the worker's own jobs by tab, with counts and unanswered quotes", async () => {
      const customer = await customerIn(t);
      const worker = await verifiedWorkerIn(t);
      const { job: current } = await assigned(t, customer, worker);
      // A request for tomorrow, so the quote does not clash with the job the worker is already doing.
      const open = await scheduledJob(t, await customerIn(t), 24 * 60, {
        title: 'Waiting for an answer',
      });
      const quote = await sendQuote(t, worker, open.id);

      const res = await http
        .get(`${V1}/workers/me/jobs`, { token: worker.accessToken })
        .expect(200);
      expect(res.body.items.map((i: { id: string }) => i.id)).toEqual([
        current.id,
      ]);
      expect(res.body.meta.counts).toEqual({
        ongoing: 1,
        completed: 0,
        cancelled: 0,
      });
      expect(res.body.pendingQuotes).toEqual([
        expect.objectContaining({
          offerId: quote.id,
          jobId: open.id,
          visitFee: VISIT_FEE,
        }),
      ]);

      const done = await http
        .get(`${V1}/workers/me/jobs?tab=completed`, {
          token: worker.accessToken,
        })
        .expect(200);
      expect(done.body.items).toEqual([]);
      expect(done.body.pendingQuotes).toBeUndefined();

      // Nobody else sees them.
      const other = await verifiedWorkerIn(t);
      const mine = await http
        .get(`${V1}/workers/me/jobs`, { token: other.accessToken })
        .expect(200);
      expect(mine.body.items).toEqual([]);
      expect(mine.body.meta.counts).toEqual({
        ongoing: 0,
        completed: 0,
        cancelled: 0,
      });
    });
  });

  // ───────────────────────── ownership, not verification (decision D-8) ─────────────────────────

  describe('job ownership, not verification, decides who may act on an assigned job (decision D-8)', () => {
    it.each(['PENDING', 'REJECTED'] as const)(
      'a worker whose profile is back in %s review can still arrive, bill and complete a job already assigned to them',
      async (state) => {
        const customer = await customerIn(t);
        const worker = await verifiedWorkerIn(t);
        const { job, code } = await assigned(t, customer, worker);
        await t.prisma.workerProfile.update({
          where: { userId: worker.userId },
          data: { verificationStatus: state },
        });

        await arriveAt(t, worker, job.id, code).expect(200);
        await putItems(t, worker, job.id, [
          { kind: 'LABOUR', description: 'Fix', amount: 100 },
        ]).expect(200);
        await approveBill(t, customer, job.id, VISIT_FEE + 100).expect(200);
        await withProofPhotos(t, worker, job.id);
        await completeWork(t, worker, job.id).expect(200);
        await payFor(t, customer, job.id).expect(200);
        expect(await statusOf(t, job.id)).toBe('COMPLETED');
        await http
          .get(`${V1}/jobs/${job.id}/receipt`, { token: worker.accessToken })
          .expect(200);
      },
    );

    it('a REJECTED or PENDING worker can still read and finish their own job; they just stop receiving new leads', async () => {
      const customer = await customerIn(t);
      const worker = await verifiedWorkerIn(t);
      const { job } = await assigned(t, customer, worker);
      await t.prisma.workerProfile.update({
        where: { userId: worker.userId },
        data: { verificationStatus: 'REJECTED' },
      });

      await http
        .get(`${V1}/jobs/${job.id}`, { token: worker.accessToken })
        .expect(200);
      await http
        .get(`${V1}/workers/me/jobs`, { token: worker.accessToken })
        .expect(200);
      await http
        .get(`${V1}/workers/me/schedule`, { token: worker.accessToken })
        .expect(200);

      // New work is another matter: no leads, no pushes, no quotes.
      await http.get(`${V1}/leads`, { token: worker.accessToken }).expect(403);
      const inbox = await listen(worker);
      const other = await customerIn(t);
      const fresh = await postJob(t, other, { title: 'A new request' });
      expect(fresh.notifiedWorkers).toBe(0);
      await settle();
      expect(inbox.matching('lead.new')).toEqual([]);
    });

    it('a worker who is not assigned to the job gets 404 on every one of these routes, verified or not', async () => {
      const customer = await customerIn(t);
      const worker = await verifiedWorkerIn(t);
      const stranger = await verifiedWorkerIn(t, { fullName: 'Stranger' });
      const { job, code } = await assigned(t, customer, worker);
      await t.prisma.job.update({
        where: { id: job.id },
        data: { status: 'ARRIVED', arrivedAt: new Date() },
      });

      const routes: [string, () => Promise<{ status: number }>][] = [
        ['arrival', () => arriveAt(t, stranger, job.id, code)],
        ['bill-items', () => putItems(t, stranger, job.id, [])],
        [
          'work-photos',
          () =>
            http.post(
              `${V1}/jobs/${job.id}/work-photos`,
              { kind: 'BEFORE', key: 'x' },
              { token: stranger.accessToken },
            ),
        ],
        ['complete-work', () => completeWork(t, stranger, job.id)],
        [
          'bill',
          () =>
            http.get(`${V1}/jobs/${job.id}/bill`, {
              token: stranger.accessToken,
            }),
        ],
        [
          'tracking',
          () =>
            http.get(`${V1}/jobs/${job.id}/tracking`, {
              token: stranger.accessToken,
            }),
        ],
        [
          'receipt',
          () =>
            http.get(`${V1}/jobs/${job.id}/receipt`, {
              token: stranger.accessToken,
            }),
        ],
        [
          'sos',
          () =>
            http.post(
              `${V1}/jobs/${job.id}/sos`,
              {},
              { token: stranger.accessToken },
            ),
        ],
        [
          'the job itself',
          () =>
            http.get(`${V1}/jobs/${job.id}`, { token: stranger.accessToken }),
        ],
      ];
      for (const [name, call] of routes) {
        const res = await call();
        expect(res.status, `${name} as a stranger`).toBe(404);
      }

      // Also an unverified stranger, and the job's own customer acting through a worker profile.
      const unverified = await verifiedWorkerIn(t, { verified: false });
      expect((await arriveAt(t, unverified, job.id, code)).status).toBe(404);
      const both = await bothProfiles(t);
      const own = await postJob(t, both as never, { title: 'My own request' });
      const helper = await verifiedWorkerIn(t);
      const offer = await sendQuote(t, helper, own.id);
      await acceptQuote(t, both as never, own.id, offer.id).expect(200);
      // The person is a worker too, but not THIS job's worker.
      expect((await completeWork(t, both as never, own.id)).status).toBe(404);
      expect((await putItems(t, both as never, own.id, [])).status).toBe(404);
      expect(await statusOf(t, job.id)).toBe('ARRIVED'); // none of it changed anything
    });

    it('the customer of the job (and nobody else) approves the bill and records the payment', async () => {
      const customer = await customerIn(t);
      const worker = await verifiedWorkerIn(t);
      const { job } = await onSite(t, customer, worker);
      const otherCustomer = await customerIn(t);
      const both = await bothProfiles(t);

      // The assigned worker (no customer profile) cannot; a stranger customer sees nothing; a person with
      // BOTH profiles is not this job's customer either.
      expect(
        (await approveBill(t, worker as never, job.id, VISIT_FEE)).status,
      ).toBe(403);
      expect(
        (await approveBill(t, otherCustomer, job.id, VISIT_FEE)).status,
      ).toBe(404);
      expect(
        (await approveBill(t, both as never, job.id, VISIT_FEE)).status,
      ).toBe(404);
      expect(await statusOf(t, job.id)).toBe('ARRIVED');

      await approveBill(t, customer, job.id, VISIT_FEE).expect(200);
      await withProofPhotos(t, worker, job.id);
      await completeWork(t, worker, job.id).expect(200);
      expect((await payFor(t, worker as never, job.id)).status).toBe(403);
      expect((await payFor(t, otherCustomer, job.id)).status).toBe(404);
      expect((await payFor(t, both as never, job.id)).status).toBe(404);
      expect(await t.prisma.payment.count()).toBe(0);
      await payFor(t, customer, job.id).expect(200);
    });
  });

  // ───────────────────────── the worker is freed at the right moments ─────────────────────────

  describe('the worker is freed at the right moments (JobEventsService.workerFreed)', () => {
    it('work completed (WORK_COMPLETED) sends location.refresh to the worker and frees the calendar slot', async () => {
      const customer = await customerIn(t);
      const worker = await verifiedWorkerIn(t);
      const made = await underWay(t, customer, worker);
      const inbox = await listen(worker);

      // While the job is under way the worker cannot take an overlapping job...
      const urgent = await customerIn(t);
      const next = await postJob(t, urgent, { title: 'Needs a plumber now' });
      await http
        .post(
          `${V1}/leads/${next.id}/offers`,
          { visitFee: 250, etaMinutes: 15 },
          { token: worker.accessToken },
        )
        .expect(409);
      await settle();
      expect(inbox.matching('location.refresh')).toEqual([]);

      // ...as soon as the work is done, they can, and their app is asked for a fresh location.
      await withProofPhotos(t, worker, made.job.id);
      await completeWork(t, worker, made.job.id).expect(200);
      const [refresh] = await inbox.waitFor('location.refresh');
      expect(refresh).toEqual({ reason: 'JOB_ENDED', jobId: made.job.id });
      expect((await scheduleOf(t, worker)).inProgress).toBeNull();
      await http
        .post(
          `${V1}/leads/${next.id}/offers`,
          { visitFee: 250, etaMinutes: 15 },
          { token: worker.accessToken },
        )
        .expect(201);
    });

    it('a worker backing out of an assigned job sends location.refresh to that worker', async () => {
      const customer = await customerIn(t);
      const worker = await verifiedWorkerIn(t);
      const { job } = await assigned(t, customer, worker);
      const inbox = await listen(worker);

      await http
        .post(
          `${V1}/jobs/${job.id}/cancel`,
          { reason: 'Vehicle broke down' },
          { token: worker.accessToken },
        )
        .expect(200);
      const [refresh] = await inbox.waitFor('location.refresh');
      expect(refresh).toEqual({ reason: 'JOB_ENDED', jobId: job.id });
    });

    it('a customer cancelling an assigned job sends location.refresh', async () => {
      const customer = await customerIn(t);
      const worker = await verifiedWorkerIn(t);
      const { job } = await assigned(t, customer, worker);
      const inbox = await listen(worker);

      await http
        .post(
          `${V1}/jobs/${job.id}/cancel`,
          {},
          { token: customer.accessToken },
        )
        .expect(200);
      expect((await inbox.waitFor('location.refresh'))[0]).toEqual({
        reason: 'JOB_ENDED',
        jobId: job.id,
      });
    });

    it('location.refresh is sent once, at WORK_COMPLETED, and not again at payment (COMPLETED)', async () => {
      const customer = await customerIn(t);
      const worker = await verifiedWorkerIn(t);
      const inbox = await listen(worker);
      const made = await finished(t, customer, worker);
      await inbox.waitFor('location.refresh');

      await payFor(t, customer, made.job.id).expect(200);
      await inbox.waitFor('job.status', 1);
      await settle();
      expect(inbox.matching('location.refresh')).toHaveLength(1);
      expect(
        inbox
          .matching('job.status')
          .map((p) => (p as { status: string }).status),
      ).toContain('COMPLETED');
    });
  });

  // ───────────────────────── backing out clears the booking completely (Q-5) ─────────────────────────

  describe('a worker backing out clears the booking completely (Q-5)', () => {
    /** A request with five plumbers around it and one electrician; the winner is `a`. */
    async function crowd() {
      const customer = await customerIn(t);
      const a = await verifiedWorkerIn(t, { fullName: 'Alpha' });
      const b = await verifiedWorkerIn(t, { fullName: 'Bravo' });
      const c = await verifiedWorkerIn(t, { fullName: 'Charlie' });
      const d = await verifiedWorkerIn(t, { fullName: 'Delta' });
      const sparky = await verifiedWorkerIn(t, {
        fullName: 'Sparky',
        trades: ['electrician'],
      });
      const inbox = {
        customer: await listen(customer),
        a: await listen(a),
        b: await listen(b),
        c: await listen(c),
        d: await listen(d),
        sparky: await listen(sparky),
      };
      const job = await postJob(t, customer, { title: 'Burst pipe' });
      for (const w of [inbox.a, inbox.b, inbox.c, inbox.d])
        await w.waitFor('lead.new');
      await http
        .post(`${V1}/leads/${job.id}/decline`, {}, { token: d.accessToken })
        .expect(200);
      const qa = await sendQuote(t, a, job.id);
      const qb = await sendQuote(t, b, job.id);
      const accepted = await acceptQuote(t, customer, job.id, qa.id).expect(
        200,
      );
      return {
        customer,
        a,
        b,
        c,
        d,
        sparky,
        inbox,
        job,
        qa,
        qb,
        code: accepted.body.arrivalCode as string,
      };
    }

    it('a broadcast job goes back to OPEN with every trace of the assignment cleared, and the visit-fee line removed', async () => {
      const s = await crowd();
      const before = await t.prisma.job.findUniqueOrThrow({
        where: { id: s.job.id },
      });
      expect(before).toMatchObject({
        status: 'ASSIGNED',
        workerId: s.a.userId,
      });
      expect(before.bookedStartAt).toBeInstanceOf(Date);
      expect(
        await t.prisma.billItem.count({ where: { jobId: s.job.id } }),
      ).toBe(1);

      const res = await http
        .post(
          `${V1}/jobs/${s.job.id}/cancel`,
          { reason: 'Vehicle broke down' },
          { token: s.a.accessToken },
        )
        .expect(200);
      // The backed-out worker gets the request back without the address.
      expect(res.body.status).toBe('OPEN');
      expect(res.body.addressLine).toBeUndefined();

      const row = await t.prisma.job.findUniqueOrThrow({
        where: { id: s.job.id },
      });
      expect(row).toMatchObject({
        status: 'OPEN',
        workerId: null,
        acceptedOfferId: null,
        assignedAt: null,
        arrivalCode: null,
        arrivalAttempts: 0,
        bookedStartAt: null,
        bookedEndAt: null,
        bookingConfirmedAt: null,
        cancelledAt: null,
        cancelledBy: null,
      });
      expect(
        await t.prisma.billItem.count({ where: { jobId: s.job.id } }),
      ).toBe(0);
      // It can be answered again for a fresh window (a request for right now: two hours from the re-opening).
      expect(row.expiresAt!.getTime()).toBeGreaterThan(
        Date.now() + 119 * MINUTE,
      );
      expect(row.expiresAt!.getTime()).toBeGreaterThanOrEqual(
        before.expiresAt!.getTime(),
      );

      // The database constraints held at every step: no OPEN job carries a worker or a window.
      const incoherent = await t.prisma.$queryRaw<{ n: bigint }[]>`
        SELECT count(*) AS n FROM jobs
        WHERE status = 'OPEN' AND (worker_id IS NOT NULL OR booked_start_at IS NOT NULL OR booking_confirmed_at IS NOT NULL)`;
      expect(Number(incoherent[0]!.n)).toBe(0);
    });

    it("the backing-out worker's quote is no longer accepted, they cannot quote again, and their calendar slot is free", async () => {
      const s = await crowd();
      expect((await scheduleOf(t, s.a)).upcoming).toHaveLength(1);
      await http
        .post(`${V1}/jobs/${s.job.id}/cancel`, {}, { token: s.a.accessToken })
        .expect(200);

      const offer = await t.prisma.offer.findUniqueOrThrow({
        where: { id: s.qa.id },
      });
      expect(offer.status).toBe('WITHDRAWN');
      expect(offer.acceptedAt).toBeInstanceOf(Date); // kept: it is how "backed out" is recognised
      expect((await scheduleOf(t, s.a)).upcoming).toEqual([]);

      const again = await http
        .post(
          `${V1}/leads/${s.job.id}/offers`,
          { visitFee: 100, etaMinutes: 15 },
          { token: s.a.accessToken },
        )
        .expect(409);
      expect(again.body.code).toBe('BACKED_OUT');
      expect(
        (
          await http
            .post(
              `${V1}/leads/${s.job.id}/accept`,
              {},
              { token: s.a.accessToken },
            )
            .expect(409)
        ).body.code,
      ).toBe('BACKED_OUT');
      // ...and it does not come back onto their radar.
      const feed = await http
        .get(`${V1}/leads`, { token: s.a.accessToken })
        .expect(200);
      expect(feed.body.items.map((i: { id: string }) => i.id)).not.toContain(
        s.job.id,
      );
      // The slot really is free: an overlapping job can be booked.
      const other = await customerIn(t);
      await book(t, other, s.a, 30 * 60); // would clash only if the old booking still held the calendar
    });

    it("the other workers' rejected quotes are not silently revived; the customer is told so they can pick again", async () => {
      const s = await crowd();
      expect(
        (await t.prisma.offer.findUniqueOrThrow({ where: { id: s.qb.id } }))
          .status,
      ).toBe('REJECTED');
      await http
        .post(`${V1}/jobs/${s.job.id}/cancel`, {}, { token: s.a.accessToken })
        .expect(200);

      // Still rejected: the customer has no stale quote to tap by accident.
      expect(
        (await t.prisma.offer.findUniqueOrThrow({ where: { id: s.qb.id } }))
          .status,
      ).toBe('REJECTED');
      const list = await http
        .get(`${V1}/jobs/${s.job.id}/offers`, { token: s.customer.accessToken })
        .expect(200);
      expect(list.body).toEqual([]);

      // The customer is told, and the request is open again.
      const [reopened] = await s.inbox.customer.waitFor('job.reopened');
      expect(reopened).toEqual({
        jobId: s.job.id,
        reason: 'WORKER_BACKED_OUT',
      });
      expect(
        (await s.inbox.customer.waitFor('job.status', 2)).map(
          (p) => (p as { status: string }).status,
        ),
      ).toContain('OPEN');

      // Bravo may quote again (a fresh, deliberate answer), and the customer can choose.
      const fresh = await sendQuote(t, s.b, s.job.id, { visitFee: 220 });
      expect(
        (await t.prisma.offer.findUniqueOrThrow({ where: { id: fresh.id } }))
          .status,
      ).toBe('PENDING');
      const second = await acceptQuote(
        t,
        s.customer,
        s.job.id,
        fresh.id,
      ).expect(200);
      expect(second.body.status).toBe('ASSIGNED');
      expect(
        (await t.prisma.job.findUniqueOrThrow({ where: { id: s.job.id } }))
          .workerId,
      ).toBe(s.b.userId);
    });

    it('re-opening sends lead.new to covering workers AGAIN even though worker_leads rows already exist, and a worker who DECLINED stays out', async () => {
      const s = await crowd();
      const count = (w: Inbox) => w.matching('lead.new').length;
      expect([
        count(s.inbox.a),
        count(s.inbox.b),
        count(s.inbox.c),
        count(s.inbox.d),
      ]).toEqual([1, 1, 1, 1]);
      await s.inbox.c.waitFor('lead.closed'); // they were told it was taken

      await http
        .post(`${V1}/jobs/${s.job.id}/cancel`, {}, { token: s.a.accessToken })
        .expect(200);
      await s.inbox.b.waitFor('lead.new', 2);
      await s.inbox.c.waitFor('lead.new', 2);
      await settle();
      expect(count(s.inbox.b)).toBe(2); // quoted and lost: hears about it again
      expect(count(s.inbox.c)).toBe(2); // never answered: hears about it again
      expect(count(s.inbox.a)).toBe(1); // the one who backed out does not
      expect(count(s.inbox.d)).toBe(1); // the one who declined does not
      expect(count(s.inbox.sparky)).toBe(0); // wrong trade

      // Exactly once per re-open, however many times it happens...
      const second = await sendQuote(t, s.c, s.job.id);
      await acceptQuote(t, s.customer, s.job.id, second.id).expect(200);
      await http
        .post(`${V1}/jobs/${s.job.id}/cancel`, {}, { token: s.c.accessToken })
        .expect(200);
      await s.inbox.b.waitFor('lead.new', 3);
      await settle();
      expect(count(s.inbox.b)).toBe(3);
      expect(count(s.inbox.c)).toBe(2); // Charlie has now backed out too
      expect(count(s.inbox.d)).toBe(1);

      // ...and the guard still stops everything else from repeating a lead: a location catch-up finds nothing new.
      const catchUp = t.app.get(LeadCatchUpService);
      const sent = await catchUp.onFix(
        { workerId: s.b.userId, lat: 30.7, lng: 76.7, previous: null },
        Date.now() + 10 * MINUTE,
      );
      expect(sent).toBe(0);
      await settle();
      expect(count(s.inbox.b)).toBe(3);
    });

    it('a direct booking that is backed out of goes to CANCELLED instead, with its window left for history but no longer blocking anyone', async () => {
      const customer = await customerIn(t);
      const worker = await verifiedWorkerIn(t);
      const inbox = await listen(customer);
      const direct = await http
        .post(
          `${V1}/jobs/direct-booking`,
          {
            categoryId: 'plumber',
            title: 'Please come',
            timing: 'SCHEDULED',
            scheduledFor: inMinutes(24 * 60),
            addressId: customer.addressId,
            workerId: worker.userId,
          },
          { token: customer.accessToken },
        )
        .expect(201);
      await http
        .post(
          `${V1}/jobs/${direct.body.id}/direct/accept`,
          {},
          { token: worker.accessToken },
        )
        .expect(200);
      const booked = await t.prisma.job.findUniqueOrThrow({
        where: { id: direct.body.id },
      });

      const res = await http
        .post(
          `${V1}/jobs/${direct.body.id}/cancel`,
          {},
          { token: worker.accessToken },
        )
        .expect(200);
      expect(res.body.status).toBe('CANCELLED');
      expect(res.body.addressLine).toBeUndefined(); // no address once the job is over for them
      const row = await t.prisma.job.findUniqueOrThrow({
        where: { id: direct.body.id },
      });
      expect(row).toMatchObject({
        status: 'CANCELLED',
        cancelledBy: 'WORKER',
        cancelReason: 'BACKED_OUT',
        workerId: worker.userId,
      });
      expect(row.bookedStartAt).toEqual(booked.bookedStartAt); // kept for history

      expect((await inbox.waitFor('direct.declined'))[0]).toEqual({
        jobId: direct.body.id,
      });
      expect(
        (await inbox.waitFor('job.status', 1)).map(
          (p) => (p as { status: string }).status,
        ),
      ).toContain('CANCELLED');
      // The same time can now be booked again: the old window no longer blocks the calendar.
      expect((await scheduleOf(t, worker)).upcoming).toEqual([]);
      const other = await customerIn(t);
      await book(t, other, worker, 24 * 60);
    });

    it('the re-opened job gets a fresh expires_at, and the database constraints (jobs_assigned_has_booking, jobs_booking_window_valid) hold at every step', async () => {
      const customer = await customerIn(t);
      const worker = await verifiedWorkerIn(t);
      const { job } = await book(t, customer, worker, 5 * 60);
      const first = await t.prisma.job.findUniqueOrThrow({
        where: { id: job.id },
      });
      // A request for a fixed time stays open until that time, so the fresh deadline is the appointment.
      await http
        .post(`${V1}/jobs/${job.id}/cancel`, {}, { token: worker.accessToken })
        .expect(200);
      const reopened = await t.prisma.job.findUniqueOrThrow({
        where: { id: job.id },
      });
      expect(reopened.status).toBe('OPEN');
      expect(reopened.expiresAt!.getTime()).toBe(first.scheduledFor!.getTime());
      expect(reopened.expiresAt!.getTime()).toBeGreaterThan(Date.now());

      // The constraints themselves still reject the forbidden states for this very row.
      await expect(
        t.prisma.job.update({
          where: { id: job.id },
          data: { status: 'ASSIGNED', workerId: worker.userId },
        }),
      ).rejects.toThrow(/jobs_assigned_has_booking/);
      await expect(
        t.prisma.job.update({
          where: { id: job.id },
          data: { bookedStartAt: new Date() },
        }),
      ).rejects.toThrow(/jobs_booking_window_valid/);
    });

    it('cannot back out once the work has started, a stranger cannot back out for someone else, and the customer cannot cancel either', async () => {
      // (Backing out while ON SITE became possible with docs/13-cancellation.md; once the cost is approved it is not.)
      const customer = await customerIn(t);
      const worker = await verifiedWorkerIn(t);
      const { job } = await underWay(t, customer, worker);

      const late = await http
        .post(`${V1}/jobs/${job.id}/cancel`, {}, { token: worker.accessToken })
        .expect(409);
      expect(late.body.code).toBe('INVALID_TRANSITION');
      expect(await statusOf(t, job.id)).toBe('IN_PROGRESS');

      const pureWorker = await verifiedWorkerIn(t);
      await http
        .post(
          `${V1}/jobs/${job.id}/cancel`,
          {},
          { token: pureWorker.accessToken },
        )
        .expect(403); // behaviour kept from Phase 4
      const otherCustomer = await customerIn(t);
      await http
        .post(
          `${V1}/jobs/${job.id}/cancel`,
          {},
          { token: otherCustomer.accessToken },
        )
        .expect(404);
      await http
        .post(
          `${V1}/jobs/${job.id}/cancel`,
          {},
          { token: customer.accessToken },
        )
        .expect(409); // too late for them too
    });
  });

  // ───────────────────────── one job at a time on site ─────────────────────────

  describe('one job at a time on site', () => {
    it('arrival is refused with 409 when the same worker already has another job ARRIVED or IN_PROGRESS', async () => {
      const worker = await verifiedWorkerIn(t);
      const c1 = await customerIn(t);
      const c2 = await customerIn(t);
      await onSite(t, c1, worker);
      const second = await scheduledOnSite(t, c2, worker, 30 * 60);

      const refused = await arriveAt(
        t,
        worker,
        second.job.id,
        second.code,
      ).expect(409);
      expect(refused.body.code).toBe('WORKER_BUSY');
      expect(await statusOf(t, second.job.id)).toBe('ASSIGNED');
      // A refusal for being busy is not a wrong guess: it does not use up one of the five tries.
      expect(
        (await t.prisma.job.findUniqueOrThrow({ where: { id: second.job.id } }))
          .arrivalAttempts,
      ).toBe(0);
    });

    it('the jobs_one_in_progress_per_worker unique violation is mapped to that same 409, never a 500', async () => {
      const worker = await verifiedWorkerIn(t);
      const c1 = await customerIn(t);
      const c2 = await customerIn(t);
      const a = await scheduledOnSite(t, c1, worker, 24 * 60);
      const b = await scheduledOnSite(t, c2, worker, 48 * 60);

      // Two arrivals at the same instant: the friendly check may pass for both, so the database decides.
      const results = await Promise.all([
        arriveAt(t, worker, a.job.id, a.code),
        arriveAt(t, worker, b.job.id, b.code),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(results.find((r) => r.status === 409)?.body.code).toBe(
        'WORKER_BUSY',
      );
      expect(
        await t.prisma.job.count({
          where: { workerId: worker.userId, status: 'ARRIVED' },
        }),
      ).toBe(1);

      // And the real database error is recognised by the same detector the service uses.
      const customer = await makeCustomer(t.prisma);
      const other = await makeWorker(t.prisma);
      await makeJob(t.prisma, customer.userId, {
        status: 'IN_PROGRESS',
        workerId: other.userId,
        ...bookingWindow(0),
      });
      const refusal = await makeJob(t.prisma, customer.userId, {
        status: 'ARRIVED',
        workerId: other.userId,
        ...bookingWindow(600),
      }).catch((error: unknown) => error);
      expect(refusal).toBeInstanceOf(Error);
      expect(
        violatesConstraint(refusal, 'jobs_one_in_progress_per_worker'),
      ).toBe(true);
    });

    it('arriving at a job whose booking window has not started yet is allowed (early) but still respects the one-at-a-time rule', async () => {
      const worker = await verifiedWorkerIn(t);
      const c1 = await customerIn(t);
      const c2 = await customerIn(t);
      const early = await scheduledOnSite(t, c1, worker, 5 * 60); // an appointment five hours away
      const arrived = await arriveAt(
        t,
        worker,
        early.job.id,
        early.code,
      ).expect(200);
      expect(arrived.body.status).toBe('ARRIVED');

      const later = await scheduledOnSite(t, c2, worker, 30 * 60);
      expect(
        (await arriveAt(t, worker, later.job.id, later.code).expect(409)).body
          .code,
      ).toBe('WORKER_BUSY');
      expect(scheduledJob).toBeDefined();
    });
  });
});
