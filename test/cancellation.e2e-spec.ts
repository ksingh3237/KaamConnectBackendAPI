// Cancelling a job after a worker was given it (docs/13-cancellation.md): reasons, every stage, what is owed, who is
// told, the worker's history and the repeat back-out flag. Real database, recording fake in place of Firebase.

import { seedReferenceData } from '../prisma/seed/reference-data.js';
import { AccountDeletionService } from '../src/modules/account/account-deletion.service.js';
import { api, createTestApp, type TestApp } from './helpers/app.js';
import { loginAs, type LoggedIn } from './helpers/auth.js';
import { resetDatabase } from './helpers/db.js';
import { nextPhone } from './helpers/factories.js';
import {
  V1,
  VISIT_FEE,
  arriveAt,
  assigned,
  onSite,
  underWay,
  finished,
} from './helpers/fulfilment.js';
import {
  customerIn,
  postJob,
  verifiedWorkerIn,
  type Customer,
  type Worker,
} from './helpers/marketplace.js';
import { book } from './helpers/scheduling.js';

describe('cancelling an assigned job (e2e)', () => {
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

  const cancel = (
    who: LoggedIn,
    jobId: string,
    body: Record<string, unknown> = {},
  ) =>
    http.post(`${V1}/jobs/${jobId}/cancel`, body, { token: who.accessToken });
  const rowsOf = (jobId: string) =>
    t.prisma.jobCancellation.findMany({
      where: { jobId },
      orderBy: { createdAt: 'asc' },
    });
  const jobOf = (jobId: string) =>
    t.prisma.job.findUniqueOrThrow({ where: { id: jobId } });
  const inboxOf = (userId: string, type: string) =>
    t.prisma.inAppNotification.findMany({
      where: { userId, type: type as never },
    });
  /** Pushes are sent after the request has answered, so wait (briefly) for them to land. */
  const eventually = async <T>(
    read: () => Promise<T[]>,
    count = 1,
  ): Promise<T[]> => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const found = await read();
      if (found.length >= count) return found;
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    throw new Error('the notification never arrived');
  };
  const quietFor = () => new Promise((resolve) => setTimeout(resolve, 300));
  const giveDevice = (userId: string) =>
    t.prisma.deviceToken.create({
      data: {
        userId,
        token: `fcm-${userId.slice(0, 8)}-`.padEnd(40, 'x'),
        platform: 'ANDROID',
      },
    });

  describe('the worker cancels while on the way (ASSIGNED)', () => {
    it('a worker-side reason re-opens the request for new quotes, records it, and tells the customer by push and inbox', async () => {
      const customer = await customerIn(t);
      const worker = await verifiedWorkerIn(t);
      const { job } = await assigned(t, customer, worker);
      await giveDevice(customer.userId);

      const res = await cancel(worker, job.id, {
        reasonCode: 'VEHICLE_PROBLEM',
        reason: 'puncture on the flyover',
      }).expect(200);

      expect(res.body.status).toBe('OPEN');
      expect(res.body.addressLine).toBeUndefined();
      expect((await jobOf(job.id)).workerId).toBeNull();
      expect(await rowsOf(job.id)).toMatchObject([
        {
          actorId: worker.userId,
          actorRole: 'WORKER',
          workerId: worker.userId,
          stage: 'ASSIGNED',
          reasonCode: 'VEHICLE_PROBLEM',
          note: 'puncture on the flyover',
          reopened: true,
          countsAgainstWorker: true,
          visitFeeDue: null,
        },
      ]);

      const [note] = await eventually(() =>
        inboxOf(customer.userId, 'JOB_CANCELLED_BY_WORKER'),
      );
      expect(note!.title).toBe('Your worker cannot make it');
      expect(note!.body).toContain('open again');
      expect(note!.body).toContain('Reason: puncture on the flyover.');
      expect(note!.data).toMatchObject({ jobId: job.id, reopened: true });
      await eventually(async () =>
        t.messaging.sent.filter(
          (m) => m.data.type === 'JOB_CANCELLED_BY_WORKER',
        ),
      );
    });

    it('a customer-side reason (customer not answering) closes the request instead of re-broadcasting it, and does not count against the worker', async () => {
      const customer = await customerIn(t);
      const worker = await verifiedWorkerIn(t);
      const { job } = await assigned(t, customer, worker);

      const res = await cancel(worker, job.id, {
        reasonCode: 'CUSTOMER_UNREACHABLE',
      }).expect(200);

      expect(res.body.status).toBe('CANCELLED');
      expect(res.body.cancellation).toMatchObject({
        by: 'WORKER',
        stage: 'ASSIGNED',
        reasonCode: 'CUSTOMER_UNREACHABLE',
        reason: 'Customer is not answering',
        visitFeeDue: null,
      });
      expect(await jobOf(job.id)).toMatchObject({
        status: 'CANCELLED',
        cancelledBy: 'WORKER',
        cancelReason: 'Customer is not answering',
      });
      expect(await rowsOf(job.id)).toMatchObject([
        { reopened: false, countsAgainstWorker: false },
      ]);

      const [note] = await eventually(() =>
        inboxOf(customer.userId, 'JOB_CANCELLED_BY_WORKER'),
      );
      expect(note!.title).toBe('Your worker cancelled the job');
      expect(note!.data).toMatchObject({ reopened: false });
      // The worker still sees it, in their cancelled tab.
      const mine = await http
        .get(`${V1}/workers/me/jobs?tab=cancelled`, {
          token: worker.accessToken,
        })
        .expect(200);
      expect(mine.body.items.map((i: { id: string }) => i.id)).toEqual([
        job.id,
      ]);
    });

    it('an app that sends no reason code still works: the old behaviour, recorded as UNSPECIFIED', async () => {
      const customer = await customerIn(t);
      const worker = await verifiedWorkerIn(t);
      const { job } = await assigned(t, customer, worker);

      const res = await cancel(worker, job.id, {
        reason: 'Vehicle broke down',
      }).expect(200);

      expect(res.body.status).toBe('OPEN');
      expect(await rowsOf(job.id)).toMatchObject([
        {
          reasonCode: 'UNSPECIFIED',
          note: 'Vehicle broke down',
          reopened: true,
          countsAgainstWorker: true,
        },
      ]);
    });

    it('a direct booking is cancelled, never re-opened, whatever the reason', async () => {
      const customer = await customerIn(t);
      const worker = await verifiedWorkerIn(t);
      const booked = await http
        .post(
          `${V1}/jobs/direct-booking`,
          {
            categoryId: 'plumber',
            title: 'Geyser not working',
            timing: 'IMMEDIATE',
            addressId: customer.addressId,
            workerId: worker.userId,
          },
          { token: customer.accessToken },
        )
        .expect(201);
      const jobId = booked.body.id as string;
      await http
        .post(
          `${V1}/jobs/${jobId}/direct/accept`,
          {},
          { token: worker.accessToken },
        )
        .expect(200);

      const res = await cancel(worker, jobId, {
        reasonCode: 'VEHICLE_PROBLEM',
      }).expect(200);

      expect(res.body.status).toBe('CANCELLED');
      expect(await rowsOf(jobId)).toMatchObject([{ reopened: false }]);
      const [note] = await eventually(() =>
        inboxOf(customer.userId, 'JOB_CANCELLED_BY_WORKER'),
      );
      expect(note!.data).toMatchObject({ reopened: false });
    });
  });

  describe('either side cancels after the worker arrived (ARRIVED)', () => {
    it('the worker declines the work for a reason that is not theirs: closed, and the visit fee is owed to them', async () => {
      const customer = await customerIn(t);
      const worker = await verifiedWorkerIn(t);
      const { job } = await onSite(t, customer, worker);

      const res = await cancel(worker, job.id, {
        reasonCode: 'PRICE_DISAGREEMENT',
      }).expect(200);

      expect(res.body.status).toBe('CANCELLED');
      expect(res.body.cancellation).toMatchObject({
        by: 'WORKER',
        stage: 'ARRIVED',
        visitFeeDue: VISIT_FEE,
      });
      expect(await rowsOf(job.id)).toMatchObject([
        {
          stage: 'ARRIVED',
          reopened: false,
          countsAgainstWorker: false,
          visitFeeDue: VISIT_FEE,
        },
      ]);
      // The customer sees the same facts.
      const seen = await http
        .get(`${V1}/jobs/${job.id}`, { token: customer.accessToken })
        .expect(200);
      expect(seen.body.cancellation).toMatchObject({
        by: 'WORKER',
        visitFeeDue: VISIT_FEE,
      });
      const [note] = await eventually(() =>
        inboxOf(customer.userId, 'JOB_CANCELLED_BY_WORKER'),
      );
      expect(note!.body).toContain(`₹${VISIT_FEE}`);
    });

    it('the worker walks away for their own reason: no visit fee is owed, and it counts against them', async () => {
      const customer = await customerIn(t);
      const worker = await verifiedWorkerIn(t);
      const { job } = await onSite(t, customer, worker);

      const res = await cancel(worker, job.id, {
        reasonCode: 'CANT_DO_WORK',
      }).expect(200);

      expect(res.body.cancellation).toMatchObject({ visitFeeDue: null });
      expect(await rowsOf(job.id)).toMatchObject([
        { countsAgainstWorker: true, visitFeeDue: null },
      ]);
    });

    it('the customer declines the cost: closed, the visit fee is owed to the worker, and the worker is told', async () => {
      const customer = await customerIn(t);
      const worker = await verifiedWorkerIn(t);
      const { job } = await onSite(t, customer, worker);
      await giveDevice(worker.userId);

      const res = await cancel(customer, job.id, {
        reasonCode: 'PRICE_TOO_HIGH',
      }).expect(200);

      expect(res.body.status).toBe('CANCELLED');
      expect(res.body.cancellation).toMatchObject({
        by: 'CUSTOMER',
        stage: 'ARRIVED',
        reason: 'The price is too high',
        visitFeeDue: VISIT_FEE,
      });
      const [note] = await eventually(() =>
        inboxOf(worker.userId, 'JOB_CANCELLED_BY_CUSTOMER'),
      );
      expect(note!.title).toBe('The customer cancelled the job');
      expect(note!.body).toContain('The price is too high');
      expect(note!.body).toContain(`₹${VISIT_FEE}`);
      await eventually(async () =>
        t.messaging.sent.filter(
          (m) => m.data.type === 'JOB_CANCELLED_BY_CUSTOMER',
        ),
      );
    });

    it('frees the worker straight away: they can arrive at another job (one on site at a time)', async () => {
      const customer = await customerIn(t);
      const worker = await verifiedWorkerIn(t);
      // A later appointment today (a second "as soon as possible" job would overlap the first and be refused).
      const later = await book(t, await customerIn(t), worker, 300);
      const first = await onSite(t, customer, worker);
      const laterCode = later.accepted.arrivalCode as string;

      // While the first is on site the worker cannot arrive anywhere else...
      await arriveAt(t, worker, later.job.id, laterCode)
        .expect(409)
        .expect((r) => expect(r.body.code).toBe('WORKER_BUSY'));

      await cancel(worker, first.job.id, { reasonCode: 'CANT_DO_WORK' }).expect(
        200,
      );

      // ...and once it is cancelled, they can.
      await arriveAt(t, worker, later.job.id, laterCode).expect(200);
    });
  });

  describe('the customer cancels before the worker arrived', () => {
    it('while the worker is on the way: the worker is told, no fee is owed', async () => {
      const customer = await customerIn(t);
      const worker = await verifiedWorkerIn(t);
      const { job } = await assigned(t, customer, worker);

      await cancel(customer, job.id, { reasonCode: 'FOUND_ANOTHER' }).expect(
        200,
      );

      expect(await rowsOf(job.id)).toMatchObject([
        {
          actorRole: 'CUSTOMER',
          stage: 'ASSIGNED',
          workerId: worker.userId,
          countsAgainstWorker: false,
          visitFeeDue: null,
        },
      ]);
      const [note] = await eventually(() =>
        inboxOf(worker.userId, 'JOB_CANCELLED_BY_CUSTOMER'),
      );
      expect(note!.body).toContain('Found another worker');
      expect(note!.body).not.toContain('visit fee');
    });

    it('before anyone was chosen: recorded, and nobody is pushed (workers only see the lead disappear)', async () => {
      const customer = await customerIn(t);
      await verifiedWorkerIn(t); // a worker the lead was shown to
      const job = await postJob(t, customer);

      await cancel(customer, job.id, {
        reasonCode: 'POSTED_BY_MISTAKE',
      }).expect(200);

      expect(await rowsOf(job.id)).toMatchObject([
        { stage: 'OPEN', workerId: null },
      ]);
      await quietFor();
      expect(
        await t.prisma.inAppNotification.count({
          where: { type: 'JOB_CANCELLED_BY_CUSTOMER' },
        }),
      ).toBe(0);
    });
  });

  describe('what cannot be cancelled', () => {
    it('nobody can cancel once the cost is approved or the work is done', async () => {
      const customer = await customerIn(t);
      const worker = await verifiedWorkerIn(t);
      const started = await underWay(t, customer, worker);

      for (const who of [customer, worker])
        await cancel(who, started.job.id, { reasonCode: 'OTHER', reason: 'x' })
          .expect(409)
          .expect((r) => expect(r.body.code).toBe('INVALID_TRANSITION'));
      expect((await jobOf(started.job.id)).status).toBe('IN_PROGRESS');

      const done = await finished(t, customer, await verifiedWorkerIn(t));
      await cancel(customer, done.job.id).expect(409);
      expect((await jobOf(done.job.id)).status).toBe('WORK_COMPLETED');
      expect(await rowsOf(started.job.id)).toHaveLength(0);
      expect(await rowsOf(done.job.id)).toHaveLength(0);
    });

    it('a second cancel after the first is refused, and only one record is written', async () => {
      const customer = await customerIn(t);
      const worker = await verifiedWorkerIn(t);
      const { job } = await assigned(t, customer, worker);

      await cancel(customer, job.id, { reasonCode: 'CHANGED_MIND' }).expect(
        200,
      );
      await cancel(customer, job.id, { reasonCode: 'CHANGED_MIND' }).expect(
        409,
      );
      // The worker's late back-out cannot overwrite the customer's cancellation either.
      await cancel(worker, job.id, { reasonCode: 'VEHICLE_PROBLEM' }).expect(
        409,
      );

      expect(await rowsOf(job.id)).toHaveLength(1);
      expect((await jobOf(job.id)).cancelledBy).toBe('CUSTOMER');
    });

    it('a stranger cannot cancel a job, and nothing is written', async () => {
      const customer = await customerIn(t);
      const worker = await verifiedWorkerIn(t);
      const stranger = await customerIn(t);
      const { job } = await assigned(t, customer, worker);

      await cancel(stranger, job.id, { reasonCode: 'CHANGED_MIND' }).expect(
        404,
      );
      // Another worker with no customer profile gets the documented 403 (see JobsService.cancel), not a way in.
      await cancel(await verifiedWorkerIn(t), job.id, {
        reasonCode: 'VEHICLE_PROBLEM',
      })
        .expect(403)
        .expect((r) => expect(r.body.code).toBe('CUSTOMER_PROFILE_REQUIRED'));
      expect((await jobOf(job.id)).status).toBe('ASSIGNED');
      expect(await rowsOf(job.id)).toHaveLength(0);
    });
  });

  describe('the reason is checked', () => {
    let customer: Customer;
    let worker: Worker;
    let jobId: string;
    beforeEach(async () => {
      customer = await customerIn(t);
      worker = await verifiedWorkerIn(t);
      jobId = (await assigned(t, customer, worker)).job.id;
    });
    const untouched = async () => {
      expect((await jobOf(jobId)).status).toBe('ASSIGNED');
      expect(await rowsOf(jobId)).toHaveLength(0);
    };

    it('refuses a code nobody has, and one that belongs to the other side', async () => {
      const unknown = await cancel(worker, jobId, {
        reasonCode: 'NOPE',
      }).expect(422);
      expect(unknown.body.code).toBe('VALIDATION_FAILED');
      const wrongSide = await cancel(customer, jobId, {
        reasonCode: 'VEHICLE_PROBLEM',
      }).expect(422);
      expect(wrongSide.body.details).toEqual([
        { field: 'reasonCode', issue: 'not a reason a customer can give' },
      ]);
      await cancel(worker, jobId, { reasonCode: 'CHANGED_MIND' }).expect(422);
      await untouched();
    });

    it("needs the person's own words with OTHER, and keeps them", async () => {
      const bare = await cancel(worker, jobId, { reasonCode: 'OTHER' }).expect(
        422,
      );
      expect(bare.body.details).toEqual([
        { field: 'reason', issue: 'tell us what happened' },
      ]);
      await untouched();

      await cancel(customer, jobId, {
        reasonCode: 'OTHER',
        reason: '  moving house  ',
      }).expect(200);
      expect(await jobOf(jobId)).toMatchObject({
        cancelReason: 'moving house',
      });
      expect(await rowsOf(jobId)).toMatchObject([{ note: 'moving house' }]);
    });

    it('refuses an over-long note', async () => {
      await cancel(worker, jobId, {
        reasonCode: 'OTHER',
        reason: 'x'.repeat(301),
      }).expect(422);
      await untouched();
    });
  });

  describe("the worker's history and the repeat back-out warning", () => {
    /** One back-out of a fresh broadcast job by `worker`. */
    const backOut = async (worker: Worker, reasonCode: string) => {
      const { job } = await assigned(t, await customerIn(t), worker);
      await cancel(worker, job.id, { reasonCode }).expect(200);
      return job.id;
    };
    const history = (worker: Worker) =>
      http.get(`${V1}/workers/me/cancellations`, { token: worker.accessToken });

    it('is empty for a worker who never cancelled', async () => {
      const worker = await verifiedWorkerIn(t);
      const res = await history(worker).expect(200);
      expect(res.body).toEqual({
        summary: { windowDays: 30, warnAt: 3, recent: 0, warn: false },
        items: [],
      });
    });

    it('lists a re-opened back-out (which leaves their job list) and warns from the third of their own', async () => {
      const worker = await verifiedWorkerIn(t);
      const first = await backOut(worker, 'VEHICLE_PROBLEM');
      await backOut(worker, 'TOO_FAR');

      let res = await history(worker).expect(200);
      expect(res.body.summary).toMatchObject({ recent: 2, warn: false });

      // A customer-side reason is recorded but is not their doing: it does not move the count.
      await backOut(worker, 'CUSTOMER_UNREACHABLE');
      res = await history(worker).expect(200);
      expect(res.body.summary).toMatchObject({ recent: 2, warn: false });
      expect(res.body.items).toHaveLength(3);

      await backOut(worker, 'DOUBLE_BOOKED');
      res = await history(worker).expect(200);
      expect(res.body.summary).toMatchObject({ recent: 3, warn: true });
      expect(
        res.body.items.map((i: { reasonCode: string }) => i.reasonCode),
      ).toEqual([
        'DOUBLE_BOOKED',
        'CUSTOMER_UNREACHABLE',
        'TOO_FAR',
        'VEHICLE_PROBLEM',
      ]);
      expect(res.body.items[3]).toMatchObject({
        jobId: first,
        stage: 'ASSIGNED',
        reason: 'Vehicle problem',
        reopened: true,
        countsAgainstWorker: true,
      });
      // The re-opened job is no longer theirs: it is not in their job list, only here.
      const jobs = await http
        .get(`${V1}/workers/me/jobs?tab=cancelled`, {
          token: worker.accessToken,
        })
        .expect(200);
      expect(jobs.body.items.map((i: { id: string }) => i.id)).not.toContain(
        first,
      );
    });

    it('only counts the last 30 days', async () => {
      const worker = await verifiedWorkerIn(t);
      const old = await backOut(worker, 'VEHICLE_PROBLEM');
      await backOut(worker, 'VEHICLE_PROBLEM');
      await backOut(worker, 'VEHICLE_PROBLEM');
      await t.prisma.jobCancellation.updateMany({
        where: { jobId: old },
        data: { createdAt: new Date(Date.now() - 31 * 86_400_000) },
      });
      const res = await history(worker).expect(200);
      expect(res.body.summary).toMatchObject({ recent: 2, warn: false });
    });

    it("shows one worker nobody else's cancellations, and needs a worker profile", async () => {
      const worker = await verifiedWorkerIn(t);
      const other = await verifiedWorkerIn(t);
      await backOut(worker, 'VEHICLE_PROBLEM');
      expect((await history(other).expect(200)).body.items).toEqual([]);
      await http.get(`${V1}/workers/me/cancellations`).expect(401);
      await http
        .get(`${V1}/workers/me/cancellations`, {
          token: (await customerIn(t)).accessToken,
        })
        .expect(403);
    });

    describe('the admin flag list', () => {
      const FLAGS = `${V1}/admin/workers/cancellation-flags`;
      let admin: LoggedIn;
      beforeEach(async () => {
        admin = await loginAs(t, nextPhone());
        await t.prisma.user.update({
          where: { id: admin.userId },
          data: { isAdmin: true },
        });
      });

      it('lists workers at or over the threshold, most back-outs first, and nobody else', async () => {
        const often = await verifiedWorkerIn(t, { fullName: 'Often Cancels' });
        const sometimes = await verifiedWorkerIn(t, { fullName: 'Sometimes' });
        for (let i = 0; i < 4; i += 1) await backOut(often, 'VEHICLE_PROBLEM');
        for (let i = 0; i < 2; i += 1)
          await backOut(sometimes, 'VEHICLE_PROBLEM');

        const res = await http
          .get(FLAGS, { token: admin.accessToken })
          .expect(200);
        expect(res.body).toMatchObject([
          { workerId: often.userId, fullName: 'Often Cancels', backOuts: 4 },
        ]);

        const lower = await http
          .get(`${FLAGS}?min=2`, { token: admin.accessToken })
          .expect(200);
        expect(lower.body.map((w: { workerId: string }) => w.workerId)).toEqual(
          [often.userId, sometimes.userId],
        );
      });

      it('is for admins only', async () => {
        await http.get(FLAGS).expect(401);
        await http
          .get(FLAGS, { token: (await verifiedWorkerIn(t)).accessToken })
          .expect(404);
      });
    });
  });

  describe('account deletion', () => {
    it('keeps the reason code but removes the words the person typed', async () => {
      const customer = await customerIn(t);
      const worker = await verifiedWorkerIn(t);
      const { job } = await assigned(t, customer, worker);
      await cancel(customer, job.id, {
        reasonCode: 'OTHER',
        reason: 'my neighbour Mr Sharma recommended someone',
      }).expect(200);

      await t.app
        .get(AccountDeletionService)
        .reapplyFromLedger(customer.userId);

      expect(await rowsOf(job.id)).toMatchObject([
        { reasonCode: 'OTHER', note: null },
      ]);
    });
  });

  describe('database rules', () => {
    const base = async () => {
      const customer = await customerIn(t);
      const worker = await verifiedWorkerIn(t);
      const { job } = await assigned(t, customer, worker);
      return { jobId: job.id, worker, customer };
    };
    const insert = (data: Record<string, unknown>) =>
      t.prisma.jobCancellation.create({ data: data as never });

    it('refuses a row the system wrote, a stage that cannot be cancelled, and incoherent flags', async () => {
      const { jobId, worker } = await base();
      const ok = {
        jobId,
        actorId: worker.userId,
        actorRole: 'WORKER',
        stage: 'ASSIGNED',
        reasonCode: 'TOO_FAR',
      };
      await expect(insert({ ...ok, actorRole: 'SYSTEM' })).rejects.toThrow(
        /job_cancellations_actor_role_person/,
      );
      await expect(insert({ ...ok, stage: 'IN_PROGRESS' })).rejects.toThrow(
        /job_cancellations_stage_cancellable/,
      );
      await expect(insert({ ...ok, visitFeeDue: -1 })).rejects.toThrow(
        /job_cancellations_visit_fee_nonneg/,
      );
      await expect(
        insert({ ...ok, actorRole: 'CUSTOMER', countsAgainstWorker: true }),
      ).rejects.toThrow(/job_cancellations_counts_are_workers/);
      await expect(
        insert({ ...ok, stage: 'ARRIVED', reopened: true }),
      ).rejects.toThrow(/job_cancellations_reopen_is_worker_assigned/);
      await expect(
        insert({ ...ok, jobId: '00000000-0000-7000-8000-000000000000' }),
      ).rejects.toThrow(/job_cancellations_job_id_fkey/);
      expect(await rowsOf(jobId)).toHaveLength(0);
      await insert(ok);
      expect(await rowsOf(jobId)).toHaveLength(1);
    });
  });
});
