import { JobExpiryService } from '../src/modules/jobs/job-expiry.service.js';
import { seedReferenceData } from '../prisma/seed/reference-data.js';
import { api, createTestApp, type TestApp } from './helpers/app.js';
import { resetDatabase } from './helpers/db.js';
import {
  customerIn,
  giveCoordinates,
  postJob,
  verifiedWorkerIn,
  type Customer,
  type Worker,
} from './helpers/marketplace.js';

const V1 = '/api/v1';
const JOBS = `${V1}/jobs`;
const LEADS = `${V1}/leads`;

describe('direct booking "Book Pro": the worker must accept (decision D-3), e2e', () => {
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

  const book = (
    customer: Customer,
    workerId: string | undefined,
    overrides: Record<string, unknown> = {},
  ) =>
    http.post(
      `${JOBS}/direct-booking`,
      {
        categoryId: 'plumber',
        title: 'Geyser not working',
        timing: 'IMMEDIATE',
        addressId: customer.addressId,
        ...(workerId !== undefined ? { workerId } : {}),
        ...overrides,
      },
      { token: customer.accessToken },
    );
  const bookOk = async (customer: Customer, worker: Worker) =>
    (await book(customer, worker.userId).expect(201)).body as {
      id: string;
      jobNumber: number;
      status: string;
      awaitingWorker: boolean;
      expiresAt: string;
      notifiedWorkers?: number;
    };
  /** The customer's inbox row for a type. Pushes are sent after the request answers, so wait (briefly) for it. */
  const inboxRow = async (
    userId: string,
    type: 'DIRECT_DECLINED' | 'DIRECT_EXPIRED',
  ) => {
    const deadline = Date.now() + 5000;
    for (;;) {
      const [row] = await t.prisma.inAppNotification.findMany({
        where: { userId, type },
      });
      if (row || Date.now() > deadline) return row;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };
  /** Without a registered phone nothing is pushed (the inbox row is still written). */
  const giveDevice = (userId: string) =>
    t.prisma.deviceToken.create({
      data: {
        userId,
        token: `fcm-${userId.slice(0, 8)}-`.padEnd(40, 'x'),
        platform: 'ANDROID',
      },
    });
  const accept = (worker: Worker, jobId: string) =>
    http.post(
      `${JOBS}/${jobId}/direct/accept`,
      {},
      { token: worker.accessToken },
    );
  const decline = (worker: Worker, jobId: string) =>
    http.post(
      `${JOBS}/${jobId}/direct/decline`,
      {},
      { token: worker.accessToken },
    );

  describe('creating a request', () => {
    it('creates an open job addressed to one worker that lapses in minutes, and notifies nobody else', async () => {
      const customer = await customerIn(t);
      const target = await verifiedWorkerIn(t);
      await verifiedWorkerIn(t); // another plumber: must not be told

      const job = await bookOk(customer, target);

      expect(job).toMatchObject({
        status: 'OPEN',
        awaitingWorker: true,
        jobNumber: 10000,
      });
      expect(job).not.toHaveProperty('notifiedWorkers');
      const minutes = (new Date(job.expiresAt).getTime() - Date.now()) / 60_000;
      expect(minutes).toBeGreaterThan(9);
      expect(minutes).toBeLessThan(10.1);
      expect(
        (await t.prisma.job.findUniqueOrThrow({ where: { id: job.id } }))
          .targetWorkerId,
      ).toBe(target.userId);
    });

    it('is visible to the customer as a job still waiting for a worker', async () => {
      const customer = await customerIn(t);
      const target = await verifiedWorkerIn(t);
      const job = await bookOk(customer, target);

      const view = await http
        .get(`${JOBS}/${job.id}`, { token: customer.accessToken })
        .expect(200);
      expect(view.body).toMatchObject({ status: 'OPEN', isDirect: true });
      expect(view.body).not.toHaveProperty('worker');
      const list = await http
        .get(`${V1}/customers/me/jobs`, { token: customer.accessToken })
        .expect(200);
      expect(list.body.items[0]).toMatchObject({
        id: job.id,
        isDirect: true,
        worker: null,
      });
    });

    it.each([
      [
        'a worker who is not verified',
        async () => (await verifiedWorkerIn(t, { verified: false })).userId,
      ],
      [
        'a worker who does not offer that trade',
        async () =>
          (await verifiedWorkerIn(t, { trades: ['electrician'] })).userId,
      ],
      [
        'a worker in another city (no coordinates: same-city rule)',
        async () =>
          (
            await verifiedWorkerIn(t, {
              area: 'Phase 7',
              city: 'Mohali (SAS Nagar)',
            })
          ).userId,
      ],
      [
        'an id that is not a worker',
        async () => '018f0000-0000-7000-8000-000000000000',
      ],
    ])('refuses %s with a 422 on workerId', async (_label, makeId) => {
      const customer = await customerIn(t);
      const workerId = await makeId();
      const res = await book(customer, workerId).expect(422);
      expect(res.body.details[0].field).toBe('workerId');
      expect(await t.prisma.job.count()).toBe(0);
    });

    it('refuses a worker whose radius does not reach the customer (with coordinates)', async () => {
      await giveCoordinates(t, 'Sector 22');
      await giveCoordinates(t, 'Phase 7', 'Mohali (SAS Nagar)');
      const customer = await customerIn(t, 'Sector 22');
      const narrow = await verifiedWorkerIn(t, {
        area: 'Phase 7',
        city: 'Mohali (SAS Nagar)',
        radiusKm: 3,
      });
      const wide = await verifiedWorkerIn(t, {
        area: 'Phase 7',
        city: 'Mohali (SAS Nagar)',
        radiusKm: 12,
      });
      expect(
        (await book(customer, narrow.userId).expect(422)).body.details[0].issue,
      ).toContain('does not serve');
      await book(customer, wide.userId).expect(201);
    });

    it('refuses booking yourself', async () => {
      const dual = await customerIn(t);
      await http
        .put(
          `${V1}/workers/me`,
          {
            fullName: 'Dual',
            trades: ['plumber'],
            experienceYears: 3,
            languages: ['hi'],
            baseAreaId: dual.areaId,
            radiusKm: 6,
            termsAccepted: true,
          },
          { token: dual.accessToken },
        )
        .expect(200);
      await t.prisma.workerProfile.update({
        where: { userId: dual.userId },
        data: { verificationStatus: 'VERIFIED' },
      });
      const res = await book(dual, dual.userId).expect(422);
      expect(res.body.details[0].issue).toContain('yourself');
    });

    it('validates the job fields like a normal request, and needs workerId to be a uuid', async () => {
      const customer = await customerIn(t);
      const worker = await verifiedWorkerIn(t);
      await book(customer, undefined).expect(422);
      await book(customer, 'not-a-uuid').expect(422);
      await book(customer, worker.userId, { title: '  ' }).expect(422);
      await book(customer, worker.userId, { status: 'ASSIGNED' }).expect(422);
    });

    it('allows at most 3 pending requests at a time', async () => {
      const customer = await customerIn(t);
      const worker = await verifiedWorkerIn(t);
      for (let i = 0; i < 3; i += 1)
        await book(customer, worker.userId).expect(201);
      const res = await book(customer, worker.userId).expect(409);
      expect(res.body.code).toBe('DIRECT_LIMIT');
      await postJob(t, customer); // an ordinary broadcast request is still fine
    });

    it('needs a customer profile', async () => {
      const worker = await verifiedWorkerIn(t);
      const other = await verifiedWorkerIn(t);
      const res = await http
        .post(
          `${JOBS}/direct-booking`,
          { workerId: other.userId },
          { token: worker.accessToken },
        )
        .expect(403);
      expect(res.body.code).toBe('CUSTOMER_PROFILE_REQUIRED');
    });
  });

  describe('who can see a direct request', () => {
    it('only the requested worker: other workers get nothing from the feed, the detail, a quote or the job view', async () => {
      const customer = await customerIn(t);
      const target = await verifiedWorkerIn(t);
      const other = await verifiedWorkerIn(t);
      const job = await bookOk(customer, target);

      expect(
        (await http.get(LEADS, { token: other.accessToken }).expect(200)).body
          .items,
      ).toEqual([]);
      await http
        .get(`${LEADS}/${job.id}`, { token: other.accessToken })
        .expect(404);
      await http
        .post(
          `${LEADS}/${job.id}/offers`,
          { visitFee: 100, etaMinutes: 15 },
          { token: other.accessToken },
        )
        .expect(404);
      await http
        .get(`${JOBS}/${job.id}`, { token: other.accessToken })
        .expect(404);
    });

    it('the requested worker sees it flagged as direct, without the address', async () => {
      const customer = await customerIn(t);
      const target = await verifiedWorkerIn(t);
      const job = await bookOk(customer, target);

      const feed = await http
        .get(LEADS, { token: target.accessToken })
        .expect(200);
      expect(feed.body.items).toHaveLength(1);
      expect(feed.body.items[0]).toMatchObject({
        id: job.id,
        isDirect: true,
        title: 'Geyser not working',
      });

      const view = await http
        .get(`${JOBS}/${job.id}`, { token: target.accessToken })
        .expect(200);
      expect(view.body).toMatchObject({
        viewer: 'worker',
        isDirect: true,
        status: 'OPEN',
      });
      expect(view.body).not.toHaveProperty('addressLine');
      expect(view.body.customer.phone).toBeNull();
    });

    it('the requested worker cannot answer it with an ordinary quote', async () => {
      const customer = await customerIn(t);
      const target = await verifiedWorkerIn(t);
      const job = await bookOk(customer, target);
      const res = await http
        .post(
          `${LEADS}/${job.id}/offers`,
          { visitFee: 100, etaMinutes: 15 },
          { token: target.accessToken },
        )
        .expect(409);
      expect(res.body.code).toBe('DIRECT_JOB');
    });

    it('the customer cannot accept a "quote" on it either (there are none to accept)', async () => {
      const customer = await customerIn(t);
      const target = await verifiedWorkerIn(t);
      const job = await bookOk(customer, target);
      const quotes = await http
        .get(`${JOBS}/${job.id}/offers`, { token: customer.accessToken })
        .expect(200);
      expect(quotes.body).toEqual([]);
    });
  });

  describe('POST /jobs/:id/direct/accept', () => {
    it('assigns the worker at their own visiting fee and records the fee on the bill', async () => {
      const customer = await customerIn(t);
      const target = await verifiedWorkerIn(t, {
        visitingFee: 320,
        fullName: 'Gurpreet Singh',
      });
      const job = await bookOk(customer, target);

      const res = await accept(target, job.id).expect(200);
      expect(res.body).toMatchObject({
        viewer: 'worker',
        status: 'ASSIGNED',
        addressLine: 'House #1402, Near Subhash Park',
      });

      const row = await t.prisma.job.findUniqueOrThrow({
        where: { id: job.id },
        include: { offers: true, billItems: true },
      });
      expect(row).toMatchObject({
        status: 'ASSIGNED',
        workerId: target.userId,
        targetWorkerId: target.userId,
      });
      expect(row.arrivalCode).toMatch(/^\d{4}$/);
      expect(row.assignedAt).not.toBeNull();
      expect(row.offers).toHaveLength(1);
      expect(row.offers[0]).toMatchObject({
        workerId: target.userId,
        visitFee: 320,
        status: 'ACCEPTED',
        etaMinutes: 30,
      });
      expect(row.acceptedOfferId).toBe(row.offers[0]!.id);
      expect(row.billItems).toHaveLength(1);
      expect(row.billItems[0]).toMatchObject({
        kind: 'VISIT_FEE',
        amount: 320,
      });

      const forCustomer = await http
        .get(`${JOBS}/${job.id}`, { token: customer.accessToken })
        .expect(200);
      expect(forCustomer.body.worker).toMatchObject({
        id: target.userId,
        name: 'Gurpreet Singh',
        phone: target.phone,
      });
      expect(forCustomer.body.arrivalCode).toBe(row.arrivalCode);
    });

    it('falls back to the category visit fee when the worker has not set one', async () => {
      const customer = await customerIn(t);
      const target = await verifiedWorkerIn(t, { trades: ['ac_repair'] });
      const job = (
        await book(customer, target.userId, { categoryId: 'ac_repair' }).expect(
          201,
        )
      ).body;
      await accept(target, job.id).expect(200);
      const bill = await t.prisma.billItem.findFirstOrThrow({
        where: { jobId: job.id },
      });
      expect(bill.amount).toBe(299);
    });

    it('estimates arrival from the distance when coordinates are known (never below 5 minutes)', async () => {
      await giveCoordinates(t, 'Sector 22');
      await giveCoordinates(t, 'Phase 7', 'Mohali (SAS Nagar)');
      const customer = await customerIn(t, 'Sector 22');
      const near = await verifiedWorkerIn(t, { area: 'Sector 22' });
      const far = await verifiedWorkerIn(t, {
        area: 'Phase 7',
        city: 'Mohali (SAS Nagar)',
        radiusKm: 12,
      });
      const nearJob = await bookOk(customer, near);
      const farJob = await bookOk(customer, far);
      await accept(near, nearJob.id).expect(200);
      await accept(far, farJob.id).expect(200);

      const eta = async (jobId: string) =>
        (await t.prisma.offer.findFirstOrThrow({ where: { jobId } }))
          .etaMinutes;
      expect(await eta(nearJob.id)).toBe(5); // 0 km: floor of 5 minutes
      expect(await eta(farJob.id)).toBeGreaterThan(15); // about 6.4 km at 20 km/h
    });

    it('only the requested worker can accept; everybody else gets the same 404', async () => {
      const customer = await customerIn(t);
      const target = await verifiedWorkerIn(t);
      const other = await verifiedWorkerIn(t);
      const job = await bookOk(customer, target);

      await accept(other, job.id).expect(404);
      await http
        .post(
          `${JOBS}/${job.id}/direct/accept`,
          {},
          { token: customer.accessToken },
        )
        .expect(403);
      await accept(target, '018f0000-0000-7000-8000-000000000000').expect(404);
      await http
        .post(
          `${JOBS}/not-a-uuid/direct/accept`,
          {},
          { token: target.accessToken },
        )
        .expect(400);
      expect(
        (await t.prisma.job.findUniqueOrThrow({ where: { id: job.id } }))
          .status,
      ).toBe('OPEN');
    });

    it('is refused after the request lapsed, was cancelled, was declined, or was already accepted', async () => {
      const customer = await customerIn(t);
      const target = await verifiedWorkerIn(t);

      const lapsed = await bookOk(customer, target);
      await t.prisma.job.update({
        where: { id: lapsed.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      expect((await accept(target, lapsed.id).expect(409)).body.code).toBe(
        'JOB_NOT_OPEN',
      );
      expect(
        (await t.prisma.job.findUniqueOrThrow({ where: { id: lapsed.id } }))
          .status,
      ).toBe('OPEN');

      const cancelled = await bookOk(customer, target);
      await http
        .post(
          `${JOBS}/${cancelled.id}/cancel`,
          {},
          { token: customer.accessToken },
        )
        .expect(200);
      expect((await accept(target, cancelled.id).expect(409)).body.code).toBe(
        'INVALID_TRANSITION',
      );

      const declined = await bookOk(customer, target);
      await decline(target, declined.id).expect(200);
      expect((await accept(target, declined.id).expect(409)).body.code).toBe(
        'INVALID_TRANSITION',
      );

      const taken = await bookOk(customer, target);
      await accept(target, taken.id).expect(200);
      expect((await accept(target, taken.id).expect(409)).body.code).toBe(
        'INVALID_TRANSITION',
      );
      expect(await t.prisma.offer.count({ where: { jobId: taken.id } })).toBe(
        1,
      );
    });

    it('needs a verified worker', async () => {
      const customer = await customerIn(t);
      const target = await verifiedWorkerIn(t);
      const job = await bookOk(customer, target);
      await t.prisma.workerProfile.update({
        where: { userId: target.userId },
        data: { verificationStatus: 'REJECTED' },
      });
      expect((await accept(target, job.id).expect(403)).body.code).toBe(
        'NOT_VERIFIED',
      );
    });
  });

  describe('POST /jobs/:id/direct/decline', () => {
    it('cancels the request as declined by the worker, and the customer sees it under Cancelled', async () => {
      const customer = await customerIn(t);
      const target = await verifiedWorkerIn(t);
      const job = await bookOk(customer, target);

      const res = await decline(target, job.id).expect(200);
      expect(res.body).toMatchObject({
        status: 'CANCELLED',
        cancelledBy: 'WORKER',
        cancelReason: 'DECLINED',
      });

      const row = await t.prisma.job.findUniqueOrThrow({
        where: { id: job.id },
      });
      expect([
        row.status,
        row.workerId,
        row.cancelledBy,
        row.cancelReason,
      ]).toEqual(['CANCELLED', null, 'WORKER', 'DECLINED']);
      const tab = await http
        .get(`${V1}/customers/me/jobs?tab=cancelled`, {
          token: customer.accessToken,
        })
        .expect(200);
      expect(tab.body.items.map((i: { id: string }) => i.id)).toEqual([job.id]);
    });

    it('tells the customer by push and inbox that the worker said no', async () => {
      const customer = await customerIn(t);
      const target = await verifiedWorkerIn(t);
      const job = await bookOk(customer, target);
      await giveDevice(customer.userId);

      await decline(target, job.id).expect(200);

      const row = await inboxRow(customer.userId, 'DIRECT_DECLINED');
      expect(row).toMatchObject({
        title: 'The worker cannot take your request',
        data: { jobId: job.id },
      });
      expect(row!.body).toContain('Geyser not working');
      expect(
        t.messaging.sent.filter(
          (m) => m.data.type === 'DIRECT_DECLINED' && m.data.jobId === job.id,
        ),
      ).toHaveLength(1);
    });

    it('a worker who backs out AFTER accepting a direct booking tells the customer once, not twice', async () => {
      const customer = await customerIn(t);
      const target = await verifiedWorkerIn(t);
      const job = await bookOk(customer, target);
      await giveDevice(customer.userId);
      await accept(target, job.id).expect(200);

      await http
        .post(
          `${JOBS}/${job.id}/cancel`,
          { reasonCode: 'VEHICLE_PROBLEM' },
          { token: target.accessToken },
        )
        .expect(200);

      await new Promise((resolve) => setTimeout(resolve, 600)); // pushes are sent after the response
      const rows = await t.prisma.inAppNotification.findMany({
        where: { userId: customer.userId },
        select: { type: true },
      });
      const types = rows.map((r) => r.type);
      expect(types.filter((x) => x === 'JOB_CANCELLED_BY_WORKER')).toHaveLength(
        1,
      );
      expect(types).not.toContain('DIRECT_DECLINED');
      expect(
        t.messaging.sent.filter(
          (m) => m.data.type === 'DIRECT_DECLINED' && m.data.jobId === job.id,
        ),
      ).toHaveLength(0);
    });

    it('only the requested worker can decline, and only once', async () => {
      const customer = await customerIn(t);
      const target = await verifiedWorkerIn(t);
      const other = await verifiedWorkerIn(t);
      const job = await bookOk(customer, target);
      await decline(other, job.id).expect(404);
      await decline(target, job.id).expect(200);
      expect((await decline(target, job.id).expect(409)).body.code).toBe(
        'INVALID_TRANSITION',
      );
    });

    it('the customer can send a fresh request to someone else afterwards', async () => {
      const customer = await customerIn(t);
      const first = await verifiedWorkerIn(t);
      const second = await verifiedWorkerIn(t);
      const job = await bookOk(customer, first);
      await decline(first, job.id).expect(200);
      const again = await bookOk(customer, second);
      await accept(second, again.id).expect(200);
    });
  });

  describe('timing and races', () => {
    it('the expiry sweeper cancels an unanswered request as SYSTEM / EXPIRED', async () => {
      const customer = await customerIn(t);
      const target = await verifiedWorkerIn(t);
      const job = await bookOk(customer, target);
      await t.prisma.job.update({
        where: { id: job.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });

      expect(await t.app.get(JobExpiryService).expireOverdue()).toBe(1);
      const row = await t.prisma.job.findUniqueOrThrow({
        where: { id: job.id },
      });
      expect([row.status, row.cancelledBy, row.cancelReason]).toEqual([
        'CANCELLED',
        'SYSTEM',
        'EXPIRED',
      ]);
      const note = await inboxRow(customer.userId, 'DIRECT_EXPIRED');
      expect(note).toMatchObject({
        title: 'The worker did not answer',
        data: { jobId: job.id },
      });
    });

    it('accept and decline at the same moment: exactly one wins and the records agree', async () => {
      for (let round = 0; round < 4; round += 1) {
        const customer = await customerIn(t);
        const target = await verifiedWorkerIn(t);
        const job = await bookOk(customer, target);

        const [a, d] = await Promise.all([
          accept(target, job.id),
          decline(target, job.id),
        ]);
        expect([a.status, d.status].sort()).toEqual([200, 409]);

        const row = await t.prisma.job.findUniqueOrThrow({
          where: { id: job.id },
          include: { offers: true },
        });
        if (a.status === 200) {
          expect(row.status).toBe('ASSIGNED');
          expect(row.offers).toHaveLength(1);
        } else {
          expect(row.status).toBe('CANCELLED');
          expect(row.offers).toHaveLength(0);
        }
      }
    });

    it('accept racing the customer cancelling: never an assigned job with a cancelled customer request left half-done', async () => {
      for (let round = 0; round < 4; round += 1) {
        const customer = await customerIn(t);
        const target = await verifiedWorkerIn(t);
        const job = await bookOk(customer, target);

        const [a, c] = await Promise.all([
          accept(target, job.id),
          http.post(
            `${JOBS}/${job.id}/cancel`,
            {},
            { token: customer.accessToken },
          ),
        ]);

        expect(c.status).toBe(200); // a customer cancel is allowed from OPEN and from ASSIGNED
        const row = await t.prisma.job.findUniqueOrThrow({
          where: { id: job.id },
          include: { offers: true },
        });
        expect(row.status).toBe('CANCELLED');
        if (a.status === 200) {
          expect(row.workerId).toBe(target.userId);
          expect(row.offers.map((o) => o.status)).toEqual(['ACCEPTED']);
        } else {
          expect(a.status).toBe(409);
          expect(row.workerId).toBeNull();
          expect(row.offers).toHaveLength(0);
        }
      }
    });
  });
});
