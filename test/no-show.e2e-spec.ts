// A worker who never arrives (docs/15-no-show.md): the late warning, the automatic release after the grace period, what
// the release does to the job, the worker's record and the admin excuse. Real database, recording fake in place of Firebase.

import { seedReferenceData } from '../prisma/seed/reference-data.js';
import { NoShowService } from '../src/modules/jobs/no-show.service.js';
import { WorkerBackOutService } from '../src/modules/jobs/worker-backout.service.js';
import { api, createTestApp, type TestApp } from './helpers/app.js';
import { loginAs, type LoggedIn } from './helpers/auth.js';
import { resetDatabase } from './helpers/db.js';
import { nextPhone } from './helpers/factories.js';
import { V1, arriveAt, assigned, onSite } from './helpers/fulfilment.js';
import {
  customerIn,
  verifiedWorkerIn,
  type Customer,
  type Worker,
} from './helpers/marketplace.js';

const MIN = 60_000;
const GRACE_MIN = 30; // NO_SHOW_GRACE_MIN default

describe('worker no-show (e2e)', () => {
  let t: TestApp;
  let http: ReturnType<typeof api>;
  let sweeper: NoShowService;

  beforeAll(async () => {
    t = await createTestApp();
    http = api(t.app);
    sweeper = t.app.get(NoShowService);
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await resetDatabase(t.prisma);
    await seedReferenceData(t.prisma);
    t.messaging.reset();
  });

  /** Pretends the worker promised to arrive `minutesAgo` minutes ago (negative = in the future). */
  const promisedArrival = (jobId: string, minutesAgo: number) =>
    t.prisma.job.update({
      where: { id: jobId },
      data: { bookedStartAt: new Date(Date.now() - minutesAgo * MIN) },
    });
  const jobOf = (jobId: string) =>
    t.prisma.job.findUniqueOrThrow({ where: { id: jobId } });
  const rowsOf = (jobId: string) =>
    t.prisma.jobCancellation.findMany({
      where: { jobId },
      orderBy: { createdAt: 'asc' },
    });
  /** Pushes and inbox rows are written after the work, so wait (briefly) for them. */
  const inboxOf = async (userId: string, type: string, count = 1) => {
    const deadline = Date.now() + 5000;
    for (;;) {
      const rows = await t.prisma.inAppNotification.findMany({
        where: { userId, type: type as never },
      });
      if (rows.length >= count || Date.now() > deadline) return rows;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };
  const countOf = (userId: string, type: string) =>
    t.prisma.inAppNotification.count({
      where: { userId, type: type as never },
    });
  const quiet = () => new Promise((resolve) => setTimeout(resolve, 300));

  /** A broadcast job assigned to `worker` whose promised arrival was `minutesAgo` minutes ago. */
  const lateJob = async (
    customer: Customer,
    worker: Worker,
    minutesAgo: number,
  ) => {
    const made = await assigned(t, customer, worker);
    await promisedArrival(made.job.id, minutesAgo);
    return made;
  };

  describe('the late warning', () => {
    it('goes to both people once the promised arrival has passed, once only, and releases nothing inside the grace period', async () => {
      const customer = await customerIn(t);
      const worker = await verifiedWorkerIn(t);
      const { job } = await lateJob(customer, worker, 5);

      expect(await sweeper.sweep()).toEqual({ warned: 1, released: 0 });
      expect((await jobOf(job.id)).status).toBe('ASSIGNED');

      const [forCustomer] = await inboxOf(customer.userId, 'JOB_WORKER_LATE');
      expect(forCustomer).toMatchObject({
        title: 'Your worker is running late',
        data: { jobId: job.id },
      });
      const [forWorker] = await inboxOf(worker.userId, 'JOB_YOU_ARE_LATE');
      expect(forWorker!.title).toBe('You are late for a job');
      expect(forWorker!.body).toContain('counts as a cancellation');
      expect(
        t.messaging.sent.filter((m) => m.data.type === 'JOB_WORKER_LATE'),
      ).toHaveLength(0); // no registered phone: inbox only, nothing pushed

      expect(await sweeper.sweep()).toEqual({ warned: 0, released: 0 });
      await quiet();
      expect(await countOf(customer.userId, 'JOB_WORKER_LATE')).toBe(1);
      expect(await countOf(worker.userId, 'JOB_YOU_ARE_LATE')).toBe(1);
    });

    it('does nothing before the promised arrival', async () => {
      const customer = await customerIn(t);
      const worker = await verifiedWorkerIn(t);
      const { job } = await lateJob(customer, worker, -10);
      expect(await sweeper.sweep()).toEqual({ warned: 0, released: 0 });
      expect((await jobOf(job.id)).status).toBe('ASSIGNED');
    });

    it('shows both people when the job will be released (promised arrival + grace)', async () => {
      const customer = await customerIn(t);
      const worker = await verifiedWorkerIn(t);
      const { job } = await assigned(t, customer, worker);
      const start = (await jobOf(job.id)).bookedStartAt!;
      for (const who of [customer, worker]) {
        const view = (
          await http.get(`${V1}/jobs/${job.id}`, { token: who.accessToken })
        ).body;
        expect(new Date(view.noShowReleaseAt).getTime()).toBe(
          start.getTime() + GRACE_MIN * MIN,
        );
      }
    });
  });

  describe('the release after the grace period', () => {
    it('re-opens a broadcast job for new quotes, frees the worker, records a system no-show that counts, and tells both', async () => {
      const customer = await customerIn(t);
      const worker = await verifiedWorkerIn(t);
      const { job } = await lateJob(customer, worker, GRACE_MIN + 1);

      expect(await sweeper.sweep()).toEqual({ warned: 0, released: 1 });

      expect(await jobOf(job.id)).toMatchObject({
        status: 'OPEN',
        workerId: null,
        acceptedOfferId: null,
        assignedAt: null,
        arrivalCode: null,
        bookedStartAt: null,
        bookedEndAt: null,
        lateNotifiedAt: null,
      });
      expect(await rowsOf(job.id)).toMatchObject([
        {
          actorRole: 'SYSTEM',
          actorId: null,
          workerId: worker.userId,
          stage: 'ASSIGNED',
          reasonCode: 'NO_SHOW',
          reopened: true,
          countsAgainstWorker: true,
          visitFeeDue: null,
        },
      ]);
      const offers = await t.prisma.offer.findMany({
        where: { jobId: job.id },
      });
      expect(offers.map((o) => o.status)).toEqual(['WITHDRAWN']);

      const [toCustomer] = await inboxOf(
        customer.userId,
        'JOB_CANCELLED_BY_WORKER',
      );
      expect(toCustomer!.title).toBe('Your worker did not arrive');
      expect(toCustomer!.data).toMatchObject({ jobId: job.id, reopened: true });
      const [toWorker] = await inboxOf(worker.userId, 'JOB_NO_SHOW_RELEASED');
      expect(toWorker!.title).toBe('The job was released');
      expect(toWorker!.data).toMatchObject({ jobId: job.id, reopened: true });
      // the released job no longer holds the worker's calendar
      expect(
        await t.prisma.job.count({
          where: { workerId: worker.userId, status: 'ASSIGNED' },
        }),
      ).toBe(0);
    });

    it('releases exactly at the end of the grace period, not a moment before', async () => {
      const customer = await customerIn(t);
      const worker = await verifiedWorkerIn(t);
      const { job } = await assigned(t, customer, worker);
      const start = new Date(Date.now() - 2 * 60 * MIN);
      await t.prisma.job.update({
        where: { id: job.id },
        data: { bookedStartAt: start },
      });
      const end = start.getTime() + GRACE_MIN * MIN;

      // the release itself re-checks the cutoff, so a direct call cannot release early either
      expect(
        await t.app
          .get(WorkerBackOutService)
          .releaseNoShow(job.id, new Date(end - 1)),
      ).toBe(false);
      expect((await sweeper.sweep(new Date(end - 1))).released).toBe(0);
      expect((await jobOf(job.id)).status).toBe('ASSIGNED');
      expect((await sweeper.sweep(new Date(end))).released).toBe(1);
      expect((await jobOf(job.id)).status).toBe('OPEN');
    });

    it('closes a direct booking instead (it was meant for this worker), as a system cancellation', async () => {
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
      const id = booked.body.id as string;
      await http
        .post(
          `${V1}/jobs/${id}/direct/accept`,
          {},
          { token: worker.accessToken },
        )
        .expect(200);
      await promisedArrival(id, GRACE_MIN + 1);

      expect(await sweeper.sweep()).toEqual({ warned: 0, released: 1 });

      expect(await jobOf(id)).toMatchObject({
        status: 'CANCELLED',
        cancelledBy: 'SYSTEM',
        cancelReason: 'The worker did not arrive in time',
      });
      expect(await rowsOf(id)).toMatchObject([
        { actorRole: 'SYSTEM', reopened: false, countsAgainstWorker: true },
      ]);
      const view = (
        await http.get(`${V1}/jobs/${id}`, { token: customer.accessToken })
      ).body;
      expect(view.cancellation).toMatchObject({
        by: 'SYSTEM',
        reasonCode: 'NO_SHOW',
        reason: 'The worker did not arrive in time',
      });
      const [note] = await inboxOf(customer.userId, 'JOB_CANCELLED_BY_WORKER');
      expect(note!.data).toMatchObject({ reopened: false });
      const [forWorker] = await inboxOf(worker.userId, 'JOB_NO_SHOW_RELEASED');
      expect(forWorker!.data).toMatchObject({ jobId: id, reopened: false });
    });

    it('leaves a worker who has arrived alone, however old the promised time is', async () => {
      const customer = await customerIn(t);
      const worker = await verifiedWorkerIn(t);
      const { job } = await onSite(t, customer, worker);
      await promisedArrival(job.id, 5 * 60);
      expect(await sweeper.sweep()).toEqual({ warned: 0, released: 0 });
      expect((await jobOf(job.id)).status).toBe('ARRIVED');
      expect(await rowsOf(job.id)).toEqual([]);
    });

    it('does not record a no-show when the customer cancelled first', async () => {
      const customer = await customerIn(t);
      const worker = await verifiedWorkerIn(t);
      const { job } = await lateJob(customer, worker, GRACE_MIN + 1);
      await http
        .post(
          `${V1}/jobs/${job.id}/cancel`,
          { reasonCode: 'WORKER_LATE' },
          { token: customer.accessToken },
        )
        .expect(200);
      expect(await sweeper.sweep()).toEqual({ warned: 0, released: 0 });
      expect(await rowsOf(job.id)).toMatchObject([{ actorRole: 'CUSTOMER' }]);
    });

    it('two sweeps at once release a job once; a worker arriving at the same moment is never both arrived and released', async () => {
      const twice = await customerIn(t);
      const w1 = await verifiedWorkerIn(t);
      const a = await lateJob(twice, w1, GRACE_MIN + 1);
      const runs = await Promise.all([sweeper.sweep(), sweeper.sweep()]);
      expect(runs.reduce((n, r) => n + r.released, 0)).toBe(1);
      expect(await rowsOf(a.job.id)).toHaveLength(1);

      for (let round = 0; round < 4; round += 1) {
        const customer = await customerIn(t);
        const worker = await verifiedWorkerIn(t);
        const { job, code } = await lateJob(customer, worker, GRACE_MIN + 1);
        const [, arrival] = await Promise.all([
          sweeper.sweep(),
          arriveAt(t, worker, job.id, code),
        ]);
        const row = await jobOf(job.id);
        const rows = await rowsOf(job.id);
        if (row.status === 'ARRIVED') {
          expect(rows).toEqual([]);
          expect(arrival.status).toBe(200);
        } else {
          expect(row.status).toBe('OPEN');
          expect(rows).toHaveLength(1);
          expect(arrival.status).toBeGreaterThanOrEqual(400);
        }
      }
    });
  });

  describe("the worker's record and the admin", () => {
    const FLAGS = `${V1}/admin/workers/cancellation-flags`;
    let admin: LoggedIn;
    beforeEach(async () => {
      admin = await loginAs(t, nextPhone());
      await t.prisma.user.update({
        where: { id: admin.userId },
        data: { isAdmin: true },
      });
    });

    const threeNoShows = async (worker: Worker) => {
      const ids: string[] = [];
      for (let i = 0; i < 3; i += 1) {
        const customer = await customerIn(t);
        const { job } = await lateJob(customer, worker, GRACE_MIN + 1);
        await sweeper.sweep();
        ids.push(job.id);
      }
      return ids;
    };
    const summary = async (worker: Worker) =>
      (
        await http
          .get(`${V1}/workers/me/cancellations`, { token: worker.accessToken })
          .expect(200)
      ).body;

    it('counts toward the 3-in-30-days warning, lists as automatic in the worker history, and shows in the admin flag list', async () => {
      const worker = await verifiedWorkerIn(t, { fullName: 'Often Late' });
      await threeNoShows(worker);

      const body = await summary(worker);
      expect(body.summary).toMatchObject({ recent: 3, warn: true });
      expect(body.items).toHaveLength(3);
      expect(body.items[0]).toMatchObject({
        reasonCode: 'NO_SHOW',
        reason: 'The worker did not arrive in time',
        bySystem: true,
        countsAgainstWorker: true,
      });
      const flags = (
        await http.get(FLAGS, { token: admin.accessToken }).expect(200)
      ).body;
      expect(flags).toMatchObject([
        { workerId: worker.userId, fullName: 'Often Late', backOuts: 3 },
      ]);
    });

    it('an admin can excuse one: the record stays, the count drops, the flag goes', async () => {
      const worker = await verifiedWorkerIn(t);
      const [first] = await threeNoShows(worker);
      const row = (await rowsOf(first!))[0]!;
      const excuse = (id: string, token = admin.accessToken) =>
        http.post(`${V1}/admin/cancellations/${id}/excuse`, {}, { token });

      const done = await excuse(row.id).expect(200);
      expect(done.body).toMatchObject({ id: row.id, excused: true });
      expect(await rowsOf(first!)).toMatchObject([
        { countsAgainstWorker: false, reasonCode: 'NO_SHOW' },
      ]);
      expect((await summary(worker)).summary).toMatchObject({
        recent: 2,
        warn: false,
      });
      expect(
        (await http.get(FLAGS, { token: admin.accessToken }).expect(200)).body,
      ).toEqual([]);
      await excuse(row.id).expect(200); // saying it again is harmless
    });

    it('refuses to excuse what never counted, an unknown id, and anyone who is not an admin', async () => {
      const customer = await customerIn(t);
      const worker = await verifiedWorkerIn(t);
      const { job } = await assigned(t, customer, worker);
      await http
        .post(
          `${V1}/jobs/${job.id}/cancel`,
          { reasonCode: 'CHANGED_MIND' },
          { token: customer.accessToken },
        )
        .expect(200);
      const row = (await rowsOf(job.id))[0]!;
      const post = (id: string, token: string) =>
        http.post(`${V1}/admin/cancellations/${id}/excuse`, {}, { token });

      expect(
        (await post(row.id, admin.accessToken).expect(409)).body.code,
      ).toBe('NOT_COUNTED');
      await post(
        '0198a8f0-0000-7000-8000-000000000000',
        admin.accessToken,
      ).expect(404);
      await post(row.id, worker.accessToken).expect(404); // admin routes are hidden from everyone else
      await http
        .post(`${V1}/admin/cancellations/${row.id}/excuse`, {})
        .expect(401);
    });
  });
});
