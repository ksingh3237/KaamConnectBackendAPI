// Arrival-code recovery (approved 2026-10-11): a customer can have a NEW code issued when the worker is
// locked out or the code was misread. Limits: 3 resets per assignment, 60 seconds apart. Everything goes
// through the real HTTP API, real PostgreSQL and real WebSockets.

import { seedReferenceData } from '../prisma/seed/reference-data.js';
import { api, createTestApp, type TestApp } from './helpers/app.js';
import { resetDatabase } from './helpers/db.js';
import {
  V1,
  arriveAt,
  assigned,
  customerIn,
  onSite,
  verifiedWorkerIn,
} from './helpers/fulfilment.js';
import { postJob } from './helpers/marketplace.js';
import { customerPayload } from './helpers/personas.js';
import { closeAllSockets, connect, record } from './helpers/socket.js';

describe('Arrival-code reset (e2e)', () => {
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

  const wrongCodeFor = (code: string) => (code === '0000' ? '1111' : '0000');
  const reset = (jobId: string, who: { accessToken: string }) =>
    http.post(
      `${V1}/jobs/${jobId}/arrival-code/reset`,
      {},
      { token: who.accessToken },
    );
  const row = (jobId: string) =>
    t.prisma.job.findUniqueOrThrow({ where: { id: jobId } });
  const events = (jobId: string) =>
    t.prisma.jobSecurityEvent.findMany({
      where: { jobId },
      orderBy: { createdAt: 'asc' },
    });
  /** Pretend the cooldown has passed, instead of sleeping for a minute. */
  const skipCooldown = (jobId: string) =>
    t.prisma.job.update({
      where: { id: jobId },
      data: { arrivalCodeResetAt: new Date(Date.now() - 61_000) },
    });
  const lockOut = async (
    worker: { accessToken: string },
    jobId: string,
    code: string,
  ) => {
    for (let i = 0; i < 5; i++)
      await arriveAt(t, worker as never, jobId, wrongCodeFor(code));
  };

  describe('recovery from a lock', () => {
    it('a locked worker is stuck until the customer issues a new code; then the old code is dead and the new one works', async () => {
      const customer = await customerIn(t);
      const worker = await verifiedWorkerIn(t);
      const { job, code } = await assigned(t, customer, worker);
      const inbox = record(await connect(t, worker.accessToken));

      await lockOut(worker, job.id, code);
      // Locked: even the right code is refused...
      await arriveAt(t, worker, job.id, code).expect(429);
      // ...and both sides can see why (never the code itself for the worker).
      const workerView = await http
        .get(`${V1}/jobs/${job.id}`, { token: worker.accessToken })
        .expect(200);
      expect(workerView.body.arrivalLocked).toBe(true);
      expect(JSON.stringify(workerView.body)).not.toContain('arrivalCode');
      const customerView = await http
        .get(`${V1}/jobs/${job.id}`, { token: customer.accessToken })
        .expect(200);
      expect(customerView.body).toMatchObject({
        arrivalLocked: true,
        arrivalResetsLeft: 3,
        arrivalCode: code,
      });

      const res = await reset(job.id, customer).expect(200);
      expect(res.body.arrivalCode).toMatch(/^\d{4}$/);
      expect(res.body.arrivalCode).not.toBe(code);
      expect(res.body).toMatchObject({
        arrivalLocked: false,
        arrivalResetsLeft: 2,
        status: 'ASSIGNED',
      });
      const after = await row(job.id);
      expect(after.arrivalAttempts).toBe(0);
      expect(after.arrivalCodeResets).toBe(1);
      expect(after.arrivalCode).toBe(res.body.arrivalCode);

      // The worker is told to ask for it; the push carries no code.
      const pushed = await inbox.waitFor('job.arrival_code_reset');
      expect(pushed).toEqual([{ jobId: job.id }]);
      expect(JSON.stringify(inbox.received)).not.toContain(
        res.body.arrivalCode,
      );

      // The old code is simply wrong again (a normal 422 with tries left), not locked.
      const old = await arriveAt(t, worker, job.id, code).expect(422);
      expect(old.body.code).toBe('ARRIVAL_CODE_INVALID');
      const ok = await arriveAt(t, worker, job.id, res.body.arrivalCode).expect(
        200,
      );
      expect(ok.body.status).toBe('ARRIVED');
    });

    it('is audited without ever storing a code: the lock (worker), the reset (customer) and the address', async () => {
      const customer = await customerIn(t);
      const worker = await verifiedWorkerIn(t);
      const { job, code } = await assigned(t, customer, worker);
      await lockOut(worker, job.id, code);
      const res = await reset(job.id, customer).expect(200);

      const log = await events(job.id);
      expect(log.map((e) => e.type)).toEqual([
        'ARRIVAL_LOCKED',
        'ARRIVAL_CODE_RESET',
      ]);
      expect(log[0]?.actorId).toBe(worker.userId);
      expect(log[1]?.actorId).toBe(customer.userId);
      expect(
        log.every((e) => typeof e.ip === 'string' && e.ip.length > 0),
      ).toBe(true);
      // Only these columns exist, none of them can hold a code.
      expect(Object.keys(log[0]!).sort()).toEqual(
        ['actorId', 'createdAt', 'detail', 'id', 'ip', 'jobId', 'type'].sort(),
      );
      const dump = JSON.stringify(log);
      expect(dump).not.toContain(`"${code}"`);
      expect(dump).not.toContain(`"${res.body.arrivalCode}"`);
    });

    it('works before any lock too (a customer who misread the code), and counts towards the same cap', async () => {
      const customer = await customerIn(t);
      const worker = await verifiedWorkerIn(t);
      const { job } = await assigned(t, customer, worker);
      const res = await reset(job.id, customer).expect(200);
      expect(res.body).toMatchObject({
        arrivalLocked: false,
        arrivalResetsLeft: 2,
      });
      expect((await row(job.id)).arrivalCodeResets).toBe(1);
    });
  });

  describe('authorization', () => {
    it('only the owning customer; everyone else gets the same 404 as an unknown job', async () => {
      const customer = await customerIn(t);
      const stranger = await customerIn(t);
      const worker = await verifiedWorkerIn(t);
      const { job, code } = await assigned(t, customer, worker);

      await http
        .post(`${V1}/jobs/${job.id}/arrival-code/reset`, {})
        .expect(401);
      // The assigned worker has no customer profile: refused outright, and cannot reset their own lock.
      await reset(job.id, worker).expect(403);
      await reset(job.id, stranger).expect(404);
      await reset('0197a0c0-0000-7000-8000-000000000000', customer).expect(404);
      await http
        .post(
          `${V1}/jobs/not-a-uuid/arrival-code/reset`,
          {},
          { token: customer.accessToken },
        )
        .expect(400);

      const unchanged = await row(job.id);
      expect(unchanged.arrivalCode).toBe(code);
      expect(unchanged.arrivalCodeResets).toBe(0);
      expect(await events(job.id)).toEqual([]);
    });

    it('a person who is both customer and worker cannot reset the code of a job they are working as the worker', async () => {
      const customer = await customerIn(t);
      const worker = await verifiedWorkerIn(t);
      const { job } = await assigned(t, customer, worker);
      // Give the worker a customer profile as well: ownership is by customer_id, not by "has a profile".
      await http
        .put(`${V1}/customers/me`, customerPayload(customer.areaId), {
          token: worker.accessToken,
        })
        .expect(200);
      await reset(job.id, worker).expect(404);
      expect((await row(job.id)).arrivalCodeResets).toBe(0);
    });
  });

  describe('only while the worker is on the way', () => {
    it('refuses (409) an unassigned job, a job already on site and a cancelled job, and changes nothing', async () => {
      const customer = await customerIn(t);
      const worker = await verifiedWorkerIn(t);

      const open = await postJob(t, customer);
      await reset(open.id, customer).expect(409);

      const live = await onSite(t, customer, worker);
      const before = await row(live.job.id);
      await reset(live.job.id, customer).expect(409);
      const after = await row(live.job.id);
      expect(after.arrivalCode).toBe(before.arrivalCode);
      expect(after.arrivalCodeResets).toBe(0);

      const other = await customerIn(t);
      const worker2 = await verifiedWorkerIn(t);
      const doomed = await assigned(t, other, worker2);
      await http
        .post(
          `${V1}/jobs/${doomed.job.id}/cancel`,
          {},
          { token: other.accessToken },
        )
        .expect(200);
      await reset(doomed.job.id, other).expect(409);
    });
  });

  describe('rate limiting', () => {
    it('60-second cooldown: a second reset straight away is refused with how long to wait', async () => {
      const customer = await customerIn(t);
      const worker = await verifiedWorkerIn(t);
      const { job } = await assigned(t, customer, worker);
      await reset(job.id, customer).expect(200);
      const second = await reset(job.id, customer).expect(429);
      expect(second.body.code).toBe('RESET_COOLDOWN');
      expect(second.body.details[0]).toMatchObject({
        field: 'retryAfterSec',
      });
      expect(Number(second.body.details[0].issue)).toBeGreaterThan(0);
      expect(Number(second.body.details[0].issue)).toBeLessThanOrEqual(60);
      expect((await row(job.id)).arrivalCodeResets).toBe(1);
    });

    it('at most 3 resets per assignment, however long the customer waits; after that only cancel or back-out remain', async () => {
      const customer = await customerIn(t);
      const worker = await verifiedWorkerIn(t);
      const { job } = await assigned(t, customer, worker);
      for (let i = 1; i <= 3; i++) {
        await skipCooldown(job.id);
        const ok = await reset(job.id, customer).expect(200);
        expect(ok.body.arrivalResetsLeft).toBe(3 - i);
      }
      await skipCooldown(job.id);
      const refused = await reset(job.id, customer).expect(429);
      expect(refused.body.code).toBe('RESET_LIMIT');
      expect((await row(job.id)).arrivalCodeResets).toBe(3);

      // Locked out at the cap: the worker is stuck on this assignment, but can still back out,
      // and the customer can still cancel.
      const current = (await row(job.id)).arrivalCode!;
      await lockOut(worker, job.id, current);
      await arriveAt(t, worker, job.id, current).expect(429);
      await http
        .post(`${V1}/jobs/${job.id}/cancel`, {}, { token: worker.accessToken })
        .expect(200);
    });

    it('five simultaneous taps issue exactly one new code and write exactly one audit row', async () => {
      const customer = await customerIn(t);
      const worker = await verifiedWorkerIn(t);
      const { job } = await assigned(t, customer, worker);
      const results = await Promise.all(
        Array.from({ length: 5 }, () => reset(job.id, customer)),
      );
      expect(results.map((r) => r.status).sort()).toEqual([
        200, 429, 429, 429, 429,
      ]);
      expect((await row(job.id)).arrivalCodeResets).toBe(1);
      const log = await events(job.id);
      expect(log.filter((e) => e.type === 'ARRIVAL_CODE_RESET')).toHaveLength(
        1,
      );
    });

    it('refused attempts are audited, but hammering the route cannot flood the table', async () => {
      const customer = await customerIn(t);
      const worker = await verifiedWorkerIn(t);
      const { job } = await assigned(t, customer, worker);
      await reset(job.id, customer).expect(200);
      for (let i = 0; i < 6; i++) await reset(job.id, customer).expect(429);
      const refused = (await events(job.id)).filter(
        (e) => e.type === 'ARRIVAL_RESET_REFUSED',
      );
      expect(refused).toHaveLength(1);
      expect(refused[0]).toMatchObject({
        detail: 'COOLDOWN',
        actorId: customer.userId,
      });
    });

    it("a reset racing a worker's guess never leaves the job in a mixed state", async () => {
      const customer = await customerIn(t);
      const worker = await verifiedWorkerIn(t);
      const { job, code } = await assigned(t, customer, worker);
      const guesses = Array.from({ length: 8 }, () =>
        arriveAt(t, worker, job.id, wrongCodeFor(code)),
      );
      const [res] = await Promise.all([reset(job.id, customer), ...guesses]);
      expect(res.status).toBe(200);
      const after = await row(job.id);
      expect(after.arrivalCodeResets).toBe(1);
      expect(after.arrivalAttempts).toBeLessThanOrEqual(5);
      expect(after.status).toBe('ASSIGNED');
    });
  });

  describe('a new assignment starts clean', () => {
    it('backing out clears the reset counter and cooldown, so the next worker is not penalised', async () => {
      const customer = await customerIn(t);
      const worker = await verifiedWorkerIn(t);
      const { job } = await assigned(t, customer, worker);
      await reset(job.id, customer).expect(200);
      await http
        .post(`${V1}/jobs/${job.id}/cancel`, {}, { token: worker.accessToken })
        .expect(200);
      const reopened = await row(job.id);
      expect(reopened.status).toBe('OPEN');
      expect(reopened).toMatchObject({
        arrivalCode: null,
        arrivalAttempts: 0,
        arrivalCodeResets: 0,
        arrivalCodeResetAt: null,
      });
      // The trail of what happened stays.
      expect((await events(job.id)).map((e) => e.type)).toContain(
        'ARRIVAL_CODE_RESET',
      );
    });
  });

  describe('lock audit under parallel guesses', () => {
    it('ten simultaneous wrong guesses lock the job once and write exactly one ARRIVAL_LOCKED event', async () => {
      const customer = await customerIn(t);
      const worker = await verifiedWorkerIn(t);
      const { job, code } = await assigned(t, customer, worker);

      const results = await Promise.all(
        Array.from({ length: 10 }, () =>
          arriveAt(t, worker, job.id, wrongCodeFor(code)),
        ),
      );
      // Only the guesses that were counted can be told "wrong"; the rest meet the lock.
      expect(results.every((r) => r.status === 422 || r.status === 429)).toBe(
        true,
      );
      expect(results.some((r) => r.status === 429)).toBe(true);
      expect((await row(job.id)).arrivalAttempts).toBe(5);

      const log = await events(job.id);
      const locks = log.filter((e) => e.type === 'ARRIVAL_LOCKED');
      expect(locks).toHaveLength(1);
      expect(locks[0]?.actorId).toBe(worker.userId);
      expect(log.filter((e) => e.type !== 'ARRIVAL_LOCKED')).toEqual([]);
    });
  });

  describe('direct-booking jobs', () => {
    it('a direct booking that the worker accepted can be locked, reset and arrived at like any other', async () => {
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

      const view = await http
        .get(`${V1}/jobs/${jobId}`, { token: customer.accessToken })
        .expect(200);
      expect(view.body).toMatchObject({ status: 'ASSIGNED', isDirect: true });
      const code = view.body.arrivalCode as string;
      expect(code).toMatch(/^\d{4}$/);

      await lockOut(worker, jobId, code);
      await arriveAt(t, worker, jobId, code).expect(429);

      const res = await reset(jobId, customer).expect(200);
      expect(res.body.arrivalCode).not.toBe(code);
      expect(res.body).toMatchObject({
        arrivalLocked: false,
        arrivalResetsLeft: 2,
      });
      await arriveAt(t, worker, jobId, code).expect(422);
      const ok = await arriveAt(t, worker, jobId, res.body.arrivalCode).expect(
        200,
      );
      expect(ok.body.status).toBe('ARRIVED');

      expect((await events(jobId)).map((e) => e.type)).toEqual([
        'ARRIVAL_LOCKED',
        'ARRIVAL_CODE_RESET',
      ]);
    });
  });

  describe('who hears about a reset', () => {
    it('only the assigned worker gets job.arrival_code_reset: not the customer, a stranger, or an unrelated worker', async () => {
      const customer = await customerIn(t);
      const worker = await verifiedWorkerIn(t);
      const stranger = await customerIn(t);
      const otherWorker = await verifiedWorkerIn(t);
      const { job } = await assigned(t, customer, worker);

      const workerInbox = record(await connect(t, worker.accessToken));
      const customerInbox = record(await connect(t, customer.accessToken));
      const strangerInbox = record(await connect(t, stranger.accessToken));
      const otherWorkerInbox = record(
        await connect(t, otherWorker.accessToken),
      );

      const res = await reset(job.id, customer).expect(200);
      const newCode = res.body.arrivalCode as string;

      expect(await workerInbox.waitFor('job.arrival_code_reset')).toEqual([
        { jobId: job.id },
      ]);
      // Give a mis-routed push time to arrive, then check nobody else got one.
      await new Promise((resolve) => setTimeout(resolve, 400));
      for (const inbox of [customerInbox, strangerInbox, otherWorkerInbox]) {
        expect(inbox.matching('job.arrival_code_reset')).toEqual([]);
      }
      // And the new code is in nobody's pushes at all.
      for (const inbox of [
        workerInbox,
        customerInbox,
        strangerInbox,
        otherWorkerInbox,
      ]) {
        expect(JSON.stringify(inbox.received)).not.toContain(newCode);
      }
    });
  });

  describe('RESET_FAILED and the per-address backstop', () => {
    it('the per-address backstop (20 an hour) refuses the 21st call with the generic 429, per address, and changes nothing', async () => {
      const customer = await customerIn(t);
      const worker = await verifiedWorkerIn(t);
      const { job } = await assigned(t, customer, worker);
      const ip = '10.200.0.1';
      const call = (address: string) =>
        http.post(
          `${V1}/jobs/${job.id}/arrival-code/reset`,
          {},
          { token: customer.accessToken, ip: address },
        );

      expect((await call(ip)).status).toBe(200);
      // Calls 2..20 reach the service and are refused by the cooldown.
      for (let i = 2; i <= 20; i++) {
        const res = await call(ip);
        expect([i, res.status, res.body.code]).toEqual([
          i,
          429,
          'RESET_COOLDOWN',
        ]);
      }
      // The 21st never reaches the service: the throttler answers.
      const throttled = await call(ip);
      expect(throttled.status).toBe(429);
      expect(throttled.body.code).toBe('TOO_MANY_REQUESTS');
      // The limit is per address: another address still reaches the service.
      const elsewhere = await call('10.200.0.2');
      expect([elsewhere.status, elsewhere.body.code]).toEqual([
        429,
        'RESET_COOLDOWN',
      ]);

      expect((await row(job.id)).arrivalCodeResets).toBe(1);
    });
  });
});
