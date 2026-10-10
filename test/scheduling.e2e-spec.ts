import { seedReferenceData } from '../prisma/seed/reference-data.js';
import { istAt, istDayStart } from '../src/modules/scheduling/schedule-time.js';
import { api, createTestApp, type TestApp } from './helpers/app.js';
import { resetDatabase } from './helpers/db.js';
import {
  bookingWindow,
  makeCustomer,
  makeJob,
  makeWorker,
} from './helpers/factories.js';
import {
  customerIn,
  postJob,
  sendQuote,
  verifiedWorkerIn,
} from './helpers/marketplace.js';
import {
  HOUR,
  MINUTE,
  V1,
  acceptQuote,
  book,
  bookNow,
  feedOf,
  inMinutes,
  scheduleOf,
  scheduledJob,
  startWork,
} from './helpers/scheduling.js';
import { closeAllSockets, connect, record } from './helpers/socket.js';

type Inbox = ReturnType<typeof record>;

describe('scheduling and availability (e2e, real PostgreSQL and WebSockets)', () => {
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

  // ───────────────────────────── 1. busy workers keep getting work ─────────────────────────────

  describe('a worker with a job in progress', () => {
    /** Customer 1's immediate job is under way with the worker. Returns everything a test needs next. */
    async function busyWorker() {
      const first = await customerIn(t);
      const worker = await verifiedWorkerIn(t, { fullName: 'Busy Bee' });
      const { job } = await bookNow(t, first, worker);
      await startWork(t, job.id);
      return { first, worker, job };
    }

    it('is still told about new leads, and sees them on the radar', async () => {
      const { worker } = await busyWorker();
      const inbox = await listen(worker);

      const other = await customerIn(t);
      const job2 = await postJob(t, other, { title: 'Second job' });
      expect(job2.notifiedWorkers).toBe(1);

      const [lead] = await inbox.waitFor('lead.new');
      expect(lead.id).toBe(job2.id);

      const feed = await feedOf(t, worker);
      expect(feed.map((l) => l.id)).toEqual([job2.id]);
      // ...with the honest answer that they cannot reach it in 15-45 minutes.
      expect(feed[0]?.availability).toMatchObject({
        free: false,
        etaOptions: [],
        reason: 'OVERLAP',
      });
      expect(feed[0]?.leadState).toBe('NEW');
    });

    it('can open the lead, decline it, and then no longer sees it', async () => {
      const { worker } = await busyWorker();
      const other = await customerIn(t);
      const job2 = await postJob(t, other);

      await http
        .get(`${V1}/leads/${job2.id}`, { token: worker.accessToken })
        .expect(200);
      const declined = await http
        .post(
          `${V1}/leads/${job2.id}/decline`,
          {},
          { token: worker.accessToken },
        )
        .expect(200);
      expect(declined.body).toEqual({ jobId: job2.id, state: 'DECLINED' });
      expect(await feedOf(t, worker)).toEqual([]);
    });

    it('cannot promise a time they are already booked for, but can quote one they can reach', async () => {
      const { worker } = await busyWorker();
      const other = await customerIn(t);

      const clash = await postJob(t, other, { title: 'Needs me now' });
      const refused = await http
        .post(
          `${V1}/leads/${clash.id}/offers`,
          { visitFee: 250, etaMinutes: 15 },
          { token: worker.accessToken },
        )
        .expect(409);
      expect(refused.body.code).toBe('SCHEDULE_CONFLICT');
      expect(refused.body.details).toEqual(
        expect.arrayContaining([
          { field: 'reason', issue: 'OVERLAP' },
          { field: 'nextFreeAt', issue: expect.any(String) },
        ]),
      );
      expect(await t.prisma.offer.count({ where: { jobId: clash.id } })).toBe(
        0,
      );

      // Accepting the lead is refused for the same reason...
      await http
        .post(
          `${V1}/leads/${clash.id}/accept`,
          {},
          { token: worker.accessToken },
        )
        .expect(409);

      // ...while a job tomorrow is fine.
      const tomorrow = await scheduledJob(t, other, 24 * 60);
      await sendQuote(t, worker, tomorrow.id);
    });

    it('can be asked for a later time by a customer, but not for right now', async () => {
      const { worker } = await busyWorker();
      const inbox = await listen(worker);
      const other = await customerIn(t);
      const base = {
        categoryId: 'plumber',
        title: 'Book the plumber',
        addressId: other.addressId,
        workerId: worker.userId,
      };

      const now = await http
        .post(
          `${V1}/jobs/direct-booking`,
          { ...base, timing: 'IMMEDIATE' },
          { token: other.accessToken },
        )
        .expect(409);
      expect(now.body.code).toBe('WORKER_UNAVAILABLE');
      expect(
        await t.prisma.job.count({ where: { customerId: other.userId } }),
      ).toBe(0);

      const later = await http
        .post(
          `${V1}/jobs/direct-booking`,
          { ...base, timing: 'SCHEDULED', scheduledFor: inMinutes(24 * 60) },
          { token: other.accessToken },
        )
        .expect(201);
      const [request] = await inbox.waitFor('direct.request');
      expect(request).toMatchObject({
        id: later.body.id,
        isDirect: true,
        scheduledFor: expect.any(String),
      });
    });

    it('can take the next job as soon as the current one is done', async () => {
      const { worker, job } = await busyWorker();
      const other = await customerIn(t);
      const next = await postJob(t, other);
      const body = { visitFee: 250, etaMinutes: 15 };
      await http
        .post(`${V1}/leads/${next.id}/offers`, body, {
          token: worker.accessToken,
        })
        .expect(409);

      // Work finished: only payment is pending, so the worker is free again.
      await t.prisma.job.update({
        where: { id: job.id },
        data: { status: 'WORK_COMPLETED', workCompletedAt: new Date() },
      });
      await http
        .post(`${V1}/leads/${next.id}/offers`, body, {
          token: worker.accessToken,
        })
        .expect(201);
    });

    it('stays busy while a job overruns its planned time, and is offered the arrival times that work', async () => {
      const { worker, job } = await busyWorker();
      // The job should have ended half an hour ago but the worker is still there.
      await t.prisma.job.update({
        where: { id: job.id },
        data: {
          bookedStartAt: new Date(Date.now() - 120 * MINUTE),
          bookedEndAt: new Date(Date.now() - 30 * MINUTE),
        },
      });
      const other = await customerIn(t);
      const next = await postJob(t, other);

      const feed = await feedOf(t, worker);
      // Needs 30 minutes to get anywhere: the 15-minute arrival is out, 30 and 45 work.
      expect(feed[0]?.availability).toMatchObject({
        free: true,
        etaOptions: [30, 45],
      });
      await http
        .post(
          `${V1}/leads/${next.id}/offers`,
          { visitFee: 250, etaMinutes: 15 },
          { token: worker.accessToken },
        )
        .expect(409);
      await http
        .post(
          `${V1}/leads/${next.id}/offers`,
          { visitFee: 250, etaMinutes: 30 },
          { token: worker.accessToken },
        )
        .expect(201);
    });
  });

  // ───────────────────────────── 2. jobs for later ─────────────────────────────

  describe('booking for later today, tomorrow or another date', () => {
    it('stores the appointment time and shows it to the customer and the workers', async () => {
      const customer = await customerIn(t);
      const worker = await verifiedWorkerIn(t);
      const when = inMinutes(26 * 60);
      const job = await postJob(t, customer, {
        timing: 'SCHEDULED',
        scheduledFor: when,
        durationMin: 120,
      });
      expect(job).toMatchObject({
        status: 'OPEN',
        scheduledFor: when,
        durationMin: 120,
      });

      const view = await http
        .get(`${V1}/jobs/${job.id}`, { token: customer.accessToken })
        .expect(200);
      expect(view.body).toMatchObject({
        timing: 'SCHEDULED',
        scheduledFor: when,
        durationMin: 120,
        booking: null,
      });

      const feed = await feedOf(t, worker);
      expect(feed[0]).toMatchObject({ id: job.id, scheduledFor: when });
    });

    it('lets the customer pick later today, and workers filter for scheduled work', async () => {
      const customer = await customerIn(t);
      const worker = await verifiedWorkerIn(t);
      const soon = await scheduledJob(t, customer, 180); // three hours from now
      const asap = await postJob(t, customer);

      const scheduled = await feedOf(t, worker, '?filter=scheduled');
      expect(scheduled.map((l) => l.id)).toEqual([soon.id]);
      const immediate = await feedOf(t, worker, '?filter=immediate');
      expect(immediate.map((l) => l.id)).toEqual([asap.id]);
      expect((await feedOf(t, worker)).map((l) => l.id).sort()).toEqual(
        [soon.id, asap.id].sort(),
      );
    });

    it('turns "Tomorrow" into 10:00 IST tomorrow when no time is given', async () => {
      const customer = await customerIn(t);
      const job = await postJob(t, customer, { timing: 'TOMORROW' });
      const row = await t.prisma.job.findUniqueOrThrow({
        where: { id: job.id },
      });
      const tomorrow = new Date(istDayStart(new Date()).getTime() + 24 * HOUR);
      expect(row.scheduledFor).toEqual(istAt(tomorrow, 10));
    });

    it('turns "Afternoon" into 14:00 IST, or half an hour from now if that has passed', async () => {
      const customer = await customerIn(t);
      const before = Date.now();
      const job = await postJob(t, customer, { timing: 'AFTERNOON' });
      const row = await t.prisma.job.findUniqueOrThrow({
        where: { id: job.id },
      });
      const fourteen = istAt(istDayStart(new Date()), 14).getTime();
      const earliest = before + 30 * MINUTE;
      const got = row.scheduledFor!.getTime();
      expect(got >= earliest - 1000).toBe(true);
      expect(got === fourteen || Math.abs(got - earliest) < 10_000).toBe(true);
    });

    it('keeps an "as soon as possible" request without an appointment time', async () => {
      const customer = await customerIn(t);
      const job = await postJob(t, customer);
      const row = await t.prisma.job.findUniqueOrThrow({
        where: { id: job.id },
      });
      expect(row.scheduledFor).toBeNull();
      expect(row.durationMin).toBe(90);
    });

    describe('how long a visit lasts (decision D-14)', () => {
      afterEach(async () => {
        await t.prisma.serviceCategory.update({
          where: { id: 'plumber' },
          data: { defaultDurationMin: null },
        });
      });

      it('uses the service default when the customer does not say, and that length blocks the worker', async () => {
        await t.prisma.serviceCategory.update({
          where: { id: 'plumber' },
          data: { defaultDurationMin: 150 },
        });
        const customer = await customerIn(t);
        const worker = await verifiedWorkerIn(t);
        const { job } = await book(t, customer, worker, 24 * 60);
        const row = await t.prisma.job.findUniqueOrThrow({
          where: { id: job.id },
        });
        expect(row.durationMin).toBe(150);
        expect(row.bookedEndAt!.getTime() - row.bookedStartAt!.getTime()).toBe(
          150 * MINUTE,
        );
      });

      it("lets the customer's own length win over the service default", async () => {
        await t.prisma.serviceCategory.update({
          where: { id: 'plumber' },
          data: { defaultDurationMin: 150 },
        });
        const customer = await customerIn(t);
        const job = await scheduledJob(t, customer, 24 * 60, {
          durationMin: 45,
        });
        expect(job.durationMin).toBe(45);
      });

      it('falls back to the global 90 minutes for a service with no default', async () => {
        const customer = await customerIn(t);
        const job = await postJob(t, customer);
        expect(job.durationMin).toBe(90);
        const other = await postJob(t, customer, { categoryId: 'electrician' });
        expect(other.durationMin).toBe(90);
      });

      it('only accepts a service default between 15 and 480 minutes', async () => {
        for (const bad of [10, 500]) {
          await expect(
            t.prisma.serviceCategory.update({
              where: { id: 'plumber' },
              data: { defaultDurationMin: bad },
            }),
          ).rejects.toThrow(/service_categories_duration_range/);
        }
      });
    });

    it('keeps collecting quotes until the appointment, but never longer than 72 hours', async () => {
      const customer = await customerIn(t);
      const near = await scheduledJob(t, customer, 24 * 60);
      const far = await scheduledJob(t, customer, 6 * 24 * 60);
      const nearRow = await t.prisma.job.findUniqueOrThrow({
        where: { id: near.id },
      });
      const farRow = await t.prisma.job.findUniqueOrThrow({
        where: { id: far.id },
      });
      expect(nearRow.expiresAt).toEqual(nearRow.scheduledFor);
      const hours = (farRow.expiresAt!.getTime() - Date.now()) / HOUR;
      expect(hours).toBeGreaterThan(71.9);
      expect(hours).toBeLessThan(72.1);
    });

    it.each([
      [
        'a time with IMMEDIATE',
        { timing: 'IMMEDIATE', scheduledFor: inMinutes(120) },
        'scheduledFor',
      ],
      ['SCHEDULED without a time', { timing: 'SCHEDULED' }, 'scheduledFor'],
      [
        'a time in the past',
        { timing: 'SCHEDULED', scheduledFor: inMinutes(-60) },
        'scheduledFor',
      ],
      [
        'a time only 10 minutes ahead',
        { timing: 'SCHEDULED', scheduledFor: inMinutes(10) },
        'scheduledFor',
      ],
      [
        'a time 40 days ahead',
        { timing: 'SCHEDULED', scheduledFor: inMinutes(40 * 24 * 60) },
        'scheduledFor',
      ],
      [
        'a time without a zone',
        { timing: 'SCHEDULED', scheduledFor: '2030-01-01T10:00:00' },
        'scheduledFor',
      ],
      [
        'text instead of a time',
        { timing: 'SCHEDULED', scheduledFor: 'next tuesday' },
        'scheduledFor',
      ],
      [
        'TOMORROW with a time two days away',
        { timing: 'TOMORROW', scheduledFor: inMinutes(60 * 49) },
        'scheduledFor',
      ],
      [
        'AFTERNOON with a time tomorrow',
        { timing: 'AFTERNOON', scheduledFor: inMinutes(60 * 30) },
        'scheduledFor',
      ],
      [
        'a 5-minute duration',
        { timing: 'IMMEDIATE', durationMin: 5 },
        'durationMin',
      ],
      [
        'a 9-hour duration',
        { timing: 'IMMEDIATE', durationMin: 540 },
        'durationMin',
      ],
    ])(
      'rejects %s with a 422 naming the field',
      async (_label, overrides, field) => {
        const customer = await customerIn(t);
        const res = await http
          .post(
            `${V1}/jobs`,
            {
              categoryId: 'plumber',
              title: 'Leak',
              addressId: customer.addressId,
              ...overrides,
            },
            { token: customer.accessToken },
          )
          .expect(422);
        expect(res.body.code).toBe('VALIDATION_FAILED');
        expect(
          res.body.details.map((d: { field: string }) => d.field),
        ).toContain(field);
        expect(await t.prisma.job.count()).toBe(0);
      },
    );
  });

  // ───────────────────────────── 3. the four separate states ─────────────────────────────

  describe('lead accepted, quote sent, quote accepted and booking confirmed are separate states', () => {
    it('records each step on its own, in order, with its own event', async () => {
      const customer = await customerIn(t);
      const worker = await verifiedWorkerIn(t);
      const inbox = {
        worker: await listen(worker),
        customer: await listen(customer),
      };
      const key = (jobId: string) => ({
        jobId_workerId: { jobId, workerId: worker.userId },
      });

      // 1. The lead is delivered.
      const job = await scheduledJob(t, customer, 24 * 60);
      await inbox.worker.waitFor('lead.new');
      let lead = await t.prisma.workerLead.findUniqueOrThrow({
        where: key(job.id),
      });
      expect(lead.response).toBeNull();

      // 2. The worker accepts the lead. No quote exists yet and the job is untouched.
      const accepted = await http
        .post(`${V1}/leads/${job.id}/accept`, {}, { token: worker.accessToken })
        .expect(200);
      expect(accepted.body).toMatchObject({
        jobId: job.id,
        state: 'ACCEPTED',
        availability: {
          free: true,
          etaOptions: null,
          reason: null,
          nextFreeAt: null,
        },
      });
      lead = await t.prisma.workerLead.findUniqueOrThrow({
        where: key(job.id),
      });
      expect(lead.response).toBe('ACCEPTED');
      expect(await t.prisma.offer.count({ where: { jobId: job.id } })).toBe(0);
      expect((await feedOf(t, worker))[0]?.leadState).toBe('ACCEPTED');

      // 3. The worker submits a quote. The customer hears about it; nothing is booked.
      const offer = await sendQuote(t, worker, job.id);
      await inbox.customer.waitFor('offer.new');
      let offerRow = await t.prisma.offer.findUniqueOrThrow({
        where: { id: offer.id },
      });
      expect(offerRow).toMatchObject({ status: 'PENDING', acceptedAt: null });
      let jobRow = await t.prisma.job.findUniqueOrThrow({
        where: { id: job.id },
      });
      expect(jobRow).toMatchObject({
        status: 'OPEN',
        bookedStartAt: null,
        bookingConfirmedAt: null,
      });

      // 4 + 5. The customer accepts the quote, which confirms the booking.
      const result = await acceptQuote(t, customer, job.id, offer.id).expect(
        200,
      );
      offerRow = await t.prisma.offer.findUniqueOrThrow({
        where: { id: offer.id },
      });
      jobRow = await t.prisma.job.findUniqueOrThrow({ where: { id: job.id } });
      expect(offerRow.status).toBe('ACCEPTED');
      expect(offerRow.acceptedAt).toBeInstanceOf(Date);
      expect(jobRow.status).toBe('ASSIGNED');
      expect(jobRow.bookedStartAt).toEqual(jobRow.scheduledFor);
      expect(
        jobRow.bookedEndAt!.getTime() - jobRow.bookedStartAt!.getTime(),
      ).toBe(90 * MINUTE);
      expect(jobRow.bookingConfirmedAt).toBeInstanceOf(Date);
      expect(result.body.booking).toEqual({
        startAt: jobRow.bookedStartAt!.toISOString(),
        endAt: jobRow.bookedEndAt!.toISOString(),
        confirmedAt: jobRow.bookingConfirmedAt!.toISOString(),
      });

      // The steps happened in order.
      const stamps = [
        lead.deliveredAt,
        lead.respondedAt!,
        offerRow.createdAt,
        offerRow.acceptedAt!,
        jobRow.bookingConfirmedAt!,
      ];
      for (let i = 1; i < stamps.length; i += 1)
        expect(stamps[i]!.getTime()).toBeGreaterThanOrEqual(
          stamps[i - 1]!.getTime(),
        );

      // Each step has its own event: first the quote is accepted, then the booking is confirmed.
      await inbox.worker.waitFor('booking.confirmed');
      const events = inbox.worker.received.map((r) => r.event);
      expect(events.indexOf('offer.accepted')).toBeLessThan(
        events.indexOf('booking.confirmed'),
      );
      const [forCustomer] = await inbox.customer.waitFor('booking.confirmed');
      expect(forCustomer).toEqual({
        jobId: job.id,
        startAt: jobRow.bookedStartAt!.toISOString(),
        endAt: jobRow.bookedEndAt!.toISOString(),
        confirmedAt: jobRow.bookingConfirmedAt!.toISOString(),
      });

      // Both people can read the booking back.
      const asWorker = await http
        .get(`${V1}/jobs/${job.id}`, { token: worker.accessToken })
        .expect(200);
      expect(asWorker.body.booking).toEqual(result.body.booking);
    });

    it('counts sending a quote as accepting the lead', async () => {
      const customer = await customerIn(t);
      const worker = await verifiedWorkerIn(t);
      const job = await scheduledJob(t, customer, 24 * 60);
      await sendQuote(t, worker, job.id);
      const lead = await t.prisma.workerLead.findUniqueOrThrow({
        where: { jobId_workerId: { jobId: job.id, workerId: worker.userId } },
      });
      expect(lead.response).toBe('ACCEPTED');
    });

    it('lets a worker change their mind about a declined lead while it is open', async () => {
      const customer = await customerIn(t);
      const worker = await verifiedWorkerIn(t);
      const job = await scheduledJob(t, customer, 24 * 60);
      await http
        .post(
          `${V1}/leads/${job.id}/decline`,
          {},
          { token: worker.accessToken },
        )
        .expect(200);
      expect(await feedOf(t, worker)).toEqual([]);
      await http
        .post(`${V1}/leads/${job.id}/accept`, {}, { token: worker.accessToken })
        .expect(200);
      expect((await feedOf(t, worker)).map((l) => l.leadState)).toEqual([
        'ACCEPTED',
      ]);
    });

    it('is idempotent: accepting twice is the same as once', async () => {
      const customer = await customerIn(t);
      const worker = await verifiedWorkerIn(t);
      const job = await scheduledJob(t, customer, 24 * 60);
      for (let i = 0; i < 2; i += 1)
        await http
          .post(
            `${V1}/leads/${job.id}/accept`,
            {},
            { token: worker.accessToken },
          )
          .expect(200);
      expect(
        await t.prisma.workerLead.count({ where: { jobId: job.id } }),
      ).toBe(1);
    });

    it('makes a worker withdraw a live quote before declining the request', async () => {
      const customer = await customerIn(t);
      const worker = await verifiedWorkerIn(t);
      const job = await scheduledJob(t, customer, 24 * 60);
      const offer = await sendQuote(t, worker, job.id);
      const refused = await http
        .post(
          `${V1}/leads/${job.id}/decline`,
          {},
          { token: worker.accessToken },
        )
        .expect(409);
      expect(refused.body.code).toBe('OFFER_EXISTS');

      await http
        .delete(`${V1}/offers/${offer.id}`, { token: worker.accessToken })
        .expect(204);
      await http
        .post(
          `${V1}/leads/${job.id}/decline`,
          {},
          { token: worker.accessToken },
        )
        .expect(200);
    });

    it('does not tell a worker who declined that the request has closed', async () => {
      const customer = await customerIn(t);
      const decliner = await verifiedWorkerIn(t, { fullName: 'Decliner' });
      const other = await verifiedWorkerIn(t, { fullName: 'Other' });
      const inbox = {
        decliner: await listen(decliner),
        other: await listen(other),
      };
      const job = await scheduledJob(t, customer, 24 * 60);
      await inbox.decliner.waitFor('lead.new');
      await http
        .post(
          `${V1}/leads/${job.id}/decline`,
          {},
          { token: decliner.accessToken },
        )
        .expect(200);

      await http
        .post(
          `${V1}/jobs/${job.id}/cancel`,
          {},
          { token: customer.accessToken },
        )
        .expect(200);
      await inbox.other.waitFor('lead.closed');
      await inbox.decliner.expectNone('lead.closed');
    });

    it('sends direct requests through their own accept and decline, not the lead ones', async () => {
      const customer = await customerIn(t);
      const worker = await verifiedWorkerIn(t);
      const direct = await http
        .post(
          `${V1}/jobs/direct-booking`,
          {
            categoryId: 'plumber',
            title: 'Please come',
            timing: 'IMMEDIATE',
            addressId: customer.addressId,
            workerId: worker.userId,
          },
          { token: customer.accessToken },
        )
        .expect(201);
      for (const verb of ['accept', 'decline']) {
        const res = await http
          .post(
            `${V1}/leads/${direct.body.id}/${verb}`,
            {},
            { token: worker.accessToken },
          )
          .expect(409);
        expect(res.body.code).toBe('DIRECT_JOB');
      }
    });
  });

  // ───────────────────────────── 4. overlap and availability ─────────────────────────────

  describe('availability is checked before a booking is confirmed', () => {
    it('lets a worker hold one job in progress and several non-overlapping future bookings', async () => {
      const worker = await verifiedWorkerIn(t);
      const now = await customerIn(t);
      const { job: current } = await bookNow(t, now, worker);
      await startWork(t, current.id);

      const jobs: string[] = [];
      for (const hours of [24, 48, 72]) {
        const customer = await customerIn(t);
        const { job } = await book(t, customer, worker, hours * 60);
        jobs.push(job.id);
      }

      const schedule = await scheduleOf(t, worker);
      expect(schedule.inProgress?.jobId).toBe(current.id);
      expect(schedule.upcoming.map((b) => b.jobId)).toEqual(jobs);
      expect(schedule.upcoming.every((b) => b.status === 'ASSIGNED')).toBe(
        true,
      );
    });

    it('refuses a customer who picks a quote the worker can no longer honour, and keeps the quote', async () => {
      const worker = await verifiedWorkerIn(t);
      const rival = await verifiedWorkerIn(t, { fullName: 'Rival' });
      const c1 = await customerIn(t);
      const c2 = await customerIn(t);
      const j1 = await scheduledJob(t, c1, 24 * 60);
      const j2 = await scheduledJob(t, c2, 24 * 60 + 30); // overlaps j1
      const o1 = await sendQuote(t, worker, j1.id);
      const o2 = await sendQuote(t, worker, j2.id); // allowed: nothing is confirmed yet

      await acceptQuote(t, c1, j1.id, o1.id).expect(200);
      const refused = await acceptQuote(t, c2, j2.id, o2.id).expect(409);
      expect(refused.body.code).toBe('WORKER_UNAVAILABLE');
      expect(refused.body.details).toEqual(
        expect.arrayContaining([{ field: 'reason', issue: 'OVERLAP' }]),
      );

      // Nothing changed for the second customer...
      expect(
        await t.prisma.job.findUniqueOrThrow({ where: { id: j2.id } }),
      ).toMatchObject({
        status: 'OPEN',
        workerId: null,
        bookedStartAt: null,
      });
      expect(
        (await t.prisma.offer.findUniqueOrThrow({ where: { id: o2.id } }))
          .status,
      ).toBe('PENDING');

      // ...and Compare Offers says why, with the earliest time the worker is free again.
      const list = await http
        .get(`${V1}/jobs/${j2.id}/offers`, { token: c2.accessToken })
        .expect(200);
      const first = await t.prisma.job.findUniqueOrThrow({
        where: { id: j1.id },
      });
      expect(list.body[0]).toMatchObject({
        offerId: o2.id,
        available: false,
        nextFreeAt: new Date(
          first.bookedEndAt!.getTime() + 30 * MINUTE,
        ).toISOString(),
      });

      // The customer is free to choose someone else.
      const o3 = await sendQuote(t, rival, j2.id);
      const list2 = await http
        .get(`${V1}/jobs/${j2.id}/offers`, { token: c2.accessToken })
        .expect(200);
      expect(
        list2.body.find((o: { offerId: string }) => o.offerId === o3.id)
          .available,
      ).toBe(true);
      await acceptQuote(t, c2, j2.id, o3.id).expect(200);
    });

    it('needs a travel gap between bookings, even when they do not overlap', async () => {
      const worker = await verifiedWorkerIn(t);
      const customers = [
        await customerIn(t),
        await customerIn(t),
        await customerIn(t),
      ];
      const start = 24 * 60;
      await book(t, customers[0]!, worker, start); // ends 90 minutes later

      // 15 minutes after it ends: too close (no coordinates, so 30 minutes are assumed).
      const tooClose = await scheduledJob(t, customers[1]!, start + 105);
      const direct = await http
        .post(
          `${V1}/leads/${tooClose.id}/offers`,
          { visitFee: 250, etaMinutes: 15 },
          { token: worker.accessToken },
        )
        .expect(409);
      expect(direct.body.details).toEqual(
        expect.arrayContaining([{ field: 'reason', issue: 'TRAVEL_BUFFER' }]),
      );

      // 35 minutes after it ends: enough.
      await book(t, customers[2]!, worker, start + 125);
    });

    it('uses the real distance between the two places when the areas have coordinates', async () => {
      const { giveCoordinates } = await import('./helpers/marketplace.js');
      await giveCoordinates(t, 'Sector 22');
      await giveCoordinates(t, 'Phase 7', 'Mohali (SAS Nagar)');
      const worker = await verifiedWorkerIn(t, { radiusKm: 12 });
      const a = await customerIn(t, 'Sector 22');
      const b = await customerIn(t, 'Phase 7', 'Mohali (SAS Nagar)');
      const c = await customerIn(t, 'Phase 7', 'Mohali (SAS Nagar)');
      const start = 24 * 60;
      await book(t, a, worker, start);

      // About 19 minutes of driving: 10 minutes after the first job ends is too soon...
      const soon = await scheduledJob(t, b, start + 100);
      await http
        .post(
          `${V1}/leads/${soon.id}/offers`,
          { visitFee: 250, etaMinutes: 15 },
          { token: worker.accessToken },
        )
        .expect(409);
      // ...25 minutes is enough (it would not be without coordinates, which assume 30).
      await book(t, c, worker, start + 115);
    });

    it('checks an immediate job against bookings coming up soon', async () => {
      const worker = await verifiedWorkerIn(t);
      const planned = await customerIn(t);
      const urgent = await customerIn(t);
      const { job: later } = await book(t, planned, worker, 45); // starts in 45 minutes

      const clash = await postJob(t, urgent);
      await http
        .post(
          `${V1}/leads/${clash.id}/offers`,
          { visitFee: 250, etaMinutes: 15 },
          { token: worker.accessToken },
        )
        .expect(409);

      // Move that booking to the evening: now there is room for a quick job first.
      await t.prisma.job.update({
        where: { id: later.id },
        data: bookingWindow(6 * 60),
      });
      const offer = await sendQuote(t, worker, clash.id);
      await acceptQuote(t, urgent, clash.id, offer.id).expect(200);
      expect((await scheduleOf(t, worker)).upcoming).toHaveLength(2);
    });

    it('re-checks the worker when they change the arrival time of a quote', async () => {
      const worker = await verifiedWorkerIn(t);
      const customer = await customerIn(t);
      const planned = await customerIn(t);
      const job = await postJob(t, customer);
      const offer = await sendQuote(t, worker, job.id, { etaMinutes: 15 });

      // The worker takes another job starting in 25 minutes. Arriving in 30 now clashes with it.
      const { job: other } = await book(t, planned, worker, 150);
      await t.prisma.job.update({
        where: { id: other.id },
        data: bookingWindow(25),
      });
      await http
        .patch(
          `${V1}/offers/${offer.id}`,
          { etaMinutes: 30 },
          { token: worker.accessToken },
        )
        .expect(409);
      await http
        .patch(
          `${V1}/offers/${offer.id}`,
          { message: 'On my way' },
          { token: worker.accessToken },
        )
        .expect(200);
    });

    it('lets exactly one of two simultaneous accepts win when the bookings overlap', async () => {
      const worker = await verifiedWorkerIn(t);
      const c1 = await customerIn(t);
      const c2 = await customerIn(t);
      const j1 = await scheduledJob(t, c1, 24 * 60);
      const j2 = await scheduledJob(t, c2, 24 * 60 + 10);
      const o1 = await sendQuote(t, worker, j1.id);
      const o2 = await sendQuote(t, worker, j2.id);

      const results = await Promise.all([
        acceptQuote(t, c1, j1.id, o1.id),
        acceptQuote(t, c2, j2.id, o2.id),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(results.find((r) => r.status === 409)?.body.code).toBe(
        'WORKER_UNAVAILABLE',
      );
      expect(
        await t.prisma.job.count({
          where: { workerId: worker.userId, status: 'ASSIGNED' },
        }),
      ).toBe(1);
    });

    it('also protects the travel gap in a race, which only the per-worker lock can (the database sees no overlap)', async () => {
      const worker = await verifiedWorkerIn(t);
      const c1 = await customerIn(t);
      const c2 = await customerIn(t);
      // 90-minute jobs starting 105 minutes apart: they do not overlap, but 15 minutes is too tight.
      const j1 = await scheduledJob(t, c1, 24 * 60);
      const j2 = await scheduledJob(t, c2, 24 * 60 + 105);
      const o1 = await sendQuote(t, worker, j1.id);
      const o2 = await sendQuote(t, worker, j2.id);

      const results = await Promise.all([
        acceptQuote(t, c1, j1.id, o1.id),
        acceptQuote(t, c2, j2.id, o2.id),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(results.find((r) => r.status === 409)?.body.details).toEqual(
        expect.arrayContaining([{ field: 'reason', issue: 'TRAVEL_BUFFER' }]),
      );
    });

    it('gives exactly one winner among many simultaneous accepts, and the rest a clean 409', async () => {
      const worker = await verifiedWorkerIn(t);
      const contenders = [];
      for (let i = 0; i < 6; i += 1) {
        const customer = await customerIn(t);
        const job = await scheduledJob(t, customer, 24 * 60 + i * 5); // all overlap
        const offer = await sendQuote(t, worker, job.id);
        contenders.push({ customer, job, offer });
      }

      const results = await Promise.all(
        contenders.map((c) => acceptQuote(t, c.customer, c.job.id, c.offer.id)),
      );
      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      const losers = results.filter((r) => r.status !== 200);
      expect(losers).toHaveLength(5);
      for (const loser of losers) {
        expect(loser.status).toBe(409);
        expect(loser.body.code).toBe('WORKER_UNAVAILABLE');
      }
      expect(
        await t.prisma.job.count({ where: { workerId: worker.userId } }),
      ).toBe(1);
      expect(await t.prisma.job.count({ where: { status: 'OPEN' } })).toBe(5);
    });

    it('lets a worker who is asked directly refuse a clashing time (and decline instead)', async () => {
      const worker = await verifiedWorkerIn(t);
      const first = await customerIn(t);
      const second = await customerIn(t);
      await book(t, first, worker, 24 * 60);

      // A direct request is created while the worker is free...
      const direct = await http
        .post(
          `${V1}/jobs/direct-booking`,
          {
            categoryId: 'plumber',
            title: 'Same hour',
            timing: 'SCHEDULED',
            scheduledFor: inMinutes(48 * 60),
            addressId: second.addressId,
            workerId: worker.userId,
          },
          { token: second.accessToken },
        )
        .expect(201);
      // ...then the worker takes a clashing booking before answering.
      await t.prisma.job.update({
        where: {
          id: (
            await t.prisma.job.findFirstOrThrow({
              where: { workerId: worker.userId },
            })
          ).id,
        },
        data: bookingWindow(48 * 60 - 10),
      });
      const refused = await http
        .post(
          `${V1}/jobs/${direct.body.id}/direct/accept`,
          {},
          { token: worker.accessToken },
        )
        .expect(409);
      expect(refused.body.code).toBe('SCHEDULE_CONFLICT');
      expect(
        (
          await t.prisma.job.findUniqueOrThrow({
            where: { id: direct.body.id },
          })
        ).status,
      ).toBe('OPEN');
      await http
        .post(
          `${V1}/jobs/${direct.body.id}/direct/decline`,
          {},
          { token: worker.accessToken },
        )
        .expect(200);
    });

    it('confirms a direct booking with the booking window', async () => {
      const worker = await verifiedWorkerIn(t);
      const customer = await customerIn(t);
      const when = inMinutes(30 * 60);
      const direct = await http
        .post(
          `${V1}/jobs/direct-booking`,
          {
            categoryId: 'plumber',
            title: 'Tap',
            timing: 'SCHEDULED',
            scheduledFor: when,
            addressId: customer.addressId,
            workerId: worker.userId,
          },
          { token: customer.accessToken },
        )
        .expect(201);
      const inbox = await listen(customer);
      const accepted = await http
        .post(
          `${V1}/jobs/${direct.body.id}/direct/accept`,
          {},
          { token: worker.accessToken },
        )
        .expect(200);
      expect(accepted.body.booking).toMatchObject({ startAt: when });
      const [event] = await inbox.waitFor('booking.confirmed');
      expect(event).toMatchObject({ jobId: direct.body.id, startAt: when });
      expect(
        (await scheduleOf(t, worker)).upcoming.map((b) => b.jobId),
      ).toEqual([direct.body.id]);
    });

    it('frees the time slot when the customer cancels, and asks the worker for a fresh location', async () => {
      const worker = await verifiedWorkerIn(t);
      const c1 = await customerIn(t);
      const c2 = await customerIn(t);
      const { job } = await book(t, c1, worker, 24 * 60);
      const inbox = await listen(worker);

      const j2 = await scheduledJob(t, c2, 24 * 60 + 15);
      await http
        .post(
          `${V1}/leads/${j2.id}/offers`,
          { visitFee: 250, etaMinutes: 15 },
          { token: worker.accessToken },
        )
        .expect(409);

      await http
        .post(`${V1}/jobs/${job.id}/cancel`, {}, { token: c1.accessToken })
        .expect(200);
      const [refresh] = await inbox.waitFor('location.refresh');
      expect(refresh).toEqual({ reason: 'JOB_ENDED', jobId: job.id });
      expect((await scheduleOf(t, worker)).upcoming).toEqual([]);

      const offer = await sendQuote(t, worker, j2.id);
      await acceptQuote(t, c2, j2.id, offer.id).expect(200);
    });

    it('only shows a worker their own bookings, and works while their profile is under review', async () => {
      const worker = await verifiedWorkerIn(t);
      const other = await verifiedWorkerIn(t);
      const customer = await customerIn(t);
      await book(t, customer, worker, 24 * 60);
      expect((await scheduleOf(t, other)).upcoming).toEqual([]);

      await t.prisma.workerProfile.update({
        where: { userId: worker.userId },
        data: { verificationStatus: 'PENDING' },
      });
      expect((await scheduleOf(t, worker)).upcoming).toHaveLength(1);
    });
  });

  // ───────────────────────────── 5. the database refuses double bookings by itself ─────────────────────────────

  describe('the database backstop', () => {
    async function twoJobs() {
      const customer = await makeCustomer(t.prisma);
      const worker = await makeWorker(t.prisma);
      return { customer, worker };
    }
    const assigned = (
      workerId: string,
      offsetMin: number,
      durationMin = 90,
      status = 'ASSIGNED',
    ) => ({
      status: status as 'ASSIGNED',
      workerId,
      ...bookingWindow(offsetMin, durationMin),
    });

    it('rejects two overlapping bookings for one worker', async () => {
      const { customer, worker } = await twoJobs();
      await makeJob(t.prisma, customer.userId, assigned(worker.userId, 60));
      await expect(
        makeJob(t.prisma, customer.userId, assigned(worker.userId, 100)),
      ).rejects.toThrow(/jobs_worker_no_overlap/);
    });

    it('turns the database refusal into the same answer the application check gives', async () => {
      const { AvailabilityService } =
        await import('../src/modules/scheduling/availability.service.js');
      const availability = t.app.get(AvailabilityService);
      const { customer, worker } = await twoJobs();
      await makeJob(t.prisma, customer.userId, assigned(worker.userId, 60));
      const refusal = await makeJob(
        t.prisma,
        customer.userId,
        assigned(worker.userId, 100),
      ).catch((error: unknown) => error);

      expect(refusal).toBeInstanceOf(Error);
      expect(
        (availability.asConflict(refusal, 'customer') as { code: string }).code,
      ).toBe('WORKER_UNAVAILABLE');
      expect(
        (availability.asConflict(refusal, 'worker') as { code: string }).code,
      ).toBe('SCHEDULE_CONFLICT');
      // Other database errors are left alone.
      const other = await makeJob(t.prisma, customer.userId, {
        durationMin: 10,
      }).catch((error: unknown) => error);
      expect(availability.asConflict(other, 'customer')).toBe(other);
    });

    it('allows back-to-back bookings, other workers at the same time, and finished jobs', async () => {
      const { customer, worker } = await twoJobs();
      const colleague = await makeWorker(t.prisma);
      const first = bookingWindow(60, 90);
      await makeJob(t.prisma, customer.userId, {
        status: 'ASSIGNED',
        workerId: worker.userId,
        ...first,
      });
      // starts exactly when the first ends
      await makeJob(t.prisma, customer.userId, {
        status: 'ASSIGNED',
        workerId: worker.userId,
        bookedStartAt: first.bookedEndAt,
        bookedEndAt: new Date(first.bookedEndAt.getTime() + 60 * MINUTE),
        bookingConfirmedAt: new Date(),
      });
      // someone else at the same time
      await makeJob(t.prisma, customer.userId, {
        status: 'ASSIGNED',
        workerId: colleague.userId,
        ...first,
      });
      // jobs that are over no longer hold the slot
      await makeJob(t.prisma, customer.userId, {
        ...assigned(worker.userId, 70, 30, 'COMPLETED'),
      });
      await makeJob(t.prisma, customer.userId, {
        ...assigned(worker.userId, 70, 30, 'WORK_COMPLETED'),
      });
    });

    it('rejects a second job in progress for one worker, whatever the times', async () => {
      const { customer, worker } = await twoJobs();
      await makeJob(
        t.prisma,
        customer.userId,
        assigned(worker.userId, -30, 60, 'IN_PROGRESS'),
      );
      await expect(
        makeJob(
          t.prisma,
          customer.userId,
          assigned(worker.userId, 600, 60, 'ARRIVED'),
        ),
      ).rejects.toThrow(/jobs_one_in_progress_per_worker/);
      // one in progress plus one waiting is the normal case
      await makeJob(
        t.prisma,
        customer.userId,
        assigned(worker.userId, 600, 60, 'ASSIGNED'),
      );
    });

    it('keeps booking data coherent', async () => {
      const { customer, worker } = await twoJobs();
      await expect(
        makeJob(t.prisma, customer.userId, { durationMin: 10 }),
      ).rejects.toThrow(/jobs_duration_range/);
      await expect(
        makeJob(t.prisma, customer.userId, {
          bookedStartAt: new Date(),
          bookedEndAt: new Date(Date.now() - MINUTE),
        }),
      ).rejects.toThrow(/jobs_booking_window_valid/);
      await expect(
        makeJob(t.prisma, customer.userId, { bookedStartAt: new Date() }),
      ).rejects.toThrow(/jobs_booking_window_valid/);
      await expect(
        t.prisma.job.create({
          data: {
            customerId: customer.userId,
            categoryId: 'plumber',
            title: 'x',
            timing: 'IMMEDIATE',
            areaId: (await t.prisma.area.findFirstOrThrow()).id,
            addressLine: 'x',
            status: 'ASSIGNED',
            workerId: worker.userId,
          },
        }),
      ).rejects.toThrow(/jobs_assigned_has_booking/);
    });

    it('limits the future-work radius to the allowed distances, and an answer to come with its time', async () => {
      const worker = await makeWorker(t.prisma);
      await expect(
        t.prisma.workerProfile.update({
          where: { userId: worker.userId },
          data: { scheduledRadiusKm: 7 },
        }),
      ).rejects.toThrow(/worker_profiles_scheduled_radius_allowed/);
      for (const km of [3, 6, 12, 25, 50])
        await t.prisma.workerProfile.update({
          where: { userId: worker.userId },
          data: { scheduledRadiusKm: km },
        });

      const customer = await makeCustomer(t.prisma);
      const job = await makeJob(t.prisma, customer.userId);
      await expect(
        t.prisma.workerLead.create({
          data: {
            jobId: job.id,
            workerId: worker.userId,
            response: 'ACCEPTED',
          },
        }),
      ).rejects.toThrow(/worker_leads_response_pair/);
    });
  });

  // ───────────────────────────── 6. where the worker is, and how far they will go ─────────────────────────────

  describe('location and travel radius', () => {
    const MOHALI = 'Mohali (SAS Nagar)';
    async function mapped() {
      const { giveCoordinates } = await import('./helpers/marketplace.js');
      await giveCoordinates(t, 'Sector 22'); // worker's base area
      await giveCoordinates(t, 'Phase 7', MOHALI); // about 6 km away
    }
    const setScheduledRadius = (
      who: { accessToken: string },
      km: number | null,
    ) =>
      http.patch(
        `${V1}/workers/me`,
        { scheduledRadiusKm: km },
        { token: who.accessToken },
      );

    it('lets a worker who will travel farther see and quote future jobs beyond their normal radius', async () => {
      await mapped();
      const willing = await verifiedWorkerIn(t, {
        radiusKm: 3,
        fullName: 'Willing',
      });
      const homebody = await verifiedWorkerIn(t, {
        radiusKm: 3,
        fullName: 'Homebody',
      });
      await setScheduledRadius(willing, 12).expect(200);
      const inbox = {
        willing: await listen(willing),
        homebody: await listen(homebody),
      };
      const customer = await customerIn(t, 'Phase 7', MOHALI);

      const future = await scheduledJob(t, customer, 24 * 60);
      const [lead] = await inbox.willing.waitFor('lead.new');
      expect(lead).toMatchObject({
        id: future.id,
        scheduledFor: expect.any(String),
      });
      await settle();
      expect(inbox.homebody.matching('lead.new')).toEqual([]);

      const [card] = await feedOf(t, willing);
      expect(card).toMatchObject({ id: future.id, extendedReach: true });
      expect(await feedOf(t, homebody)).toEqual([]);

      await sendQuote(t, willing, future.id);
      await http
        .post(
          `${V1}/leads/${future.id}/offers`,
          { visitFee: 250, etaMinutes: 15 },
          { token: homebody.accessToken },
        )
        .expect(404);
    });

    it('does not widen the radius for work that is needed now', async () => {
      await mapped();
      const willing = await verifiedWorkerIn(t, { radiusKm: 3 });
      await setScheduledRadius(willing, 50).expect(200);
      const customer = await customerIn(t, 'Phase 7', MOHALI);
      const urgent = await postJob(t, customer);
      expect(urgent.notifiedWorkers).toBe(0);
      const soon = await scheduledJob(t, customer, 60); // inside the 2-hour near-term window
      expect(
        (await t.prisma.job.findUniqueOrThrow({ where: { id: soon.id } }))
          .scheduledFor,
      ).toBeTruthy();
      expect(await feedOf(t, willing)).toEqual([]);
    });

    it('judges near-term work by where the worker is now and future work by their base area', async () => {
      await mapped();
      const worker = await verifiedWorkerIn(t, { radiusKm: 3 }); // home: Sector 22
      // The worker is currently at Phase 7 (live GPS).
      await http
        .put(
          `${V1}/workers/me/location`,
          { lat: 30.711, lng: 76.72 },
          { token: worker.accessToken },
        )
        .expect(200);
      const customer = await customerIn(t, 'Phase 7', MOHALI);

      const now = await postJob(t, customer);
      const soon = await scheduledJob(t, customer, 60);
      const tomorrow = await scheduledJob(t, customer, 24 * 60);
      const ids = (await feedOf(t, worker)).map((l) => l.id);
      expect(ids).toContain(now.id); // right where they are
      expect(ids).toContain(soon.id); // starts within two hours: they are still around
      expect(ids).not.toContain(tomorrow.id); // tomorrow they will be at home, 6 km away
    });

    it('validates the future-work radius', async () => {
      const worker = await verifiedWorkerIn(t, { radiusKm: 6 });
      await setScheduledRadius(worker, 7).expect(422);
      const tooSmall = await setScheduledRadius(worker, 3).expect(422);
      expect(tooSmall.body.details).toEqual([
        {
          field: 'scheduledRadiusKm',
          issue: 'must not be smaller than radiusKm',
        },
      ]);
      const ok = await setScheduledRadius(worker, 25).expect(200);
      expect(ok.body.scheduledRadiusKm).toBe(25);
      const cleared = await setScheduledRadius(worker, null).expect(200);
      expect(cleared.body.scheduledRadiusKm).toBeNull();
      // Raising the live radius above the future one is allowed: the larger of the two applies.
      await setScheduledRadius(worker, 12).expect(200);
      await http
        .patch(
          `${V1}/workers/me`,
          { radiusKm: 12 },
          { token: worker.accessToken },
        )
        .expect(200);
    });

    it('finds leads that now reach a worker after their location changes, once', async () => {
      await mapped();
      const worker = await verifiedWorkerIn(t, { radiusKm: 3 });
      const inbox = await listen(worker);
      const customer = await customerIn(t, 'Phase 7', MOHALI);
      const job = await postJob(t, customer);
      expect(job.notifiedWorkers).toBe(0); // 6 km from home, nothing yet
      await settle();
      expect(inbox.matching('lead.new')).toEqual([]);

      // The worker finishes elsewhere and reports where they are now.
      await http
        .put(
          `${V1}/workers/me/location`,
          { lat: 30.7112, lng: 76.7201 },
          { token: worker.accessToken },
        )
        .expect(200);
      const [lead] = await inbox.waitFor('lead.new');
      expect(lead).toMatchObject({
        id: job.id,
        reason: 'LOCATION',
        distanceKm: expect.any(Number),
      });
      expect(JSON.stringify(lead)).not.toContain('House #1402');

      // Looking again, however often, never repeats it.
      const { LeadCatchUpService } =
        await import('../src/modules/offers/lead-catch-up.service.js');
      const catchUp = t.app.get(LeadCatchUpService);
      const base = {
        workerId: worker.userId,
        lat: 30.7112,
        lng: 76.7201,
        previous: null,
      };
      expect(await catchUp.onFix(base, Date.now() + 10 * MINUTE)).toBe(0);
      expect(
        await catchUp.onFix(
          { ...base, lat: 30.7, lng: 76.7 },
          Date.now() + 20 * MINUTE,
        ),
      ).toBe(0);
      await settle();
      expect(inbox.matching('lead.new')).toHaveLength(1);
      expect(
        await t.prisma.workerLead.count({ where: { jobId: job.id } }),
      ).toBe(1);
    });

    it('does not push a declined lead again when the worker moves', async () => {
      await mapped();
      const worker = await verifiedWorkerIn(t, { radiusKm: 3 });
      const customer = await customerIn(t, 'Phase 7', MOHALI);
      const job = await postJob(t, customer);
      await http
        .post(
          `${V1}/leads/${job.id}/decline`,
          {},
          { token: worker.accessToken },
        )
        .expect(404); // not reachable yet

      // After moving close, the lead arrives; the worker declines it; moving again does not bring it back.
      const inbox = await listen(worker);
      await http
        .put(
          `${V1}/workers/me/location`,
          { lat: 30.7112, lng: 76.7201 },
          { token: worker.accessToken },
        )
        .expect(200);
      await inbox.waitFor('lead.new');
      await http
        .post(
          `${V1}/leads/${job.id}/decline`,
          {},
          { token: worker.accessToken },
        )
        .expect(200);

      const { LeadCatchUpService } =
        await import('../src/modules/offers/lead-catch-up.service.js');
      const catchUp = t.app.get(LeadCatchUpService);
      const sent = await catchUp.onFix(
        { workerId: worker.userId, lat: 30.7113, lng: 76.7202, previous: null },
        Date.now() + 10 * MINUTE,
      );
      expect(sent).toBe(0);
      expect(inbox.matching('lead.new')).toHaveLength(1);
    });
  });

  // ───────────────────────────── 7. no duplicate leads ─────────────────────────────

  describe('duplicate leads', () => {
    it('sends each covering worker one lead.new, and records that it was sent', async () => {
      const customer = await customerIn(t);
      const a = await verifiedWorkerIn(t);
      const b = await verifiedWorkerIn(t);
      const inbox = { a: await listen(a), b: await listen(b) };
      const job = await postJob(t, customer);

      await inbox.a.waitFor('lead.new');
      await inbox.b.waitFor('lead.new');
      await settle();
      expect(inbox.a.matching('lead.new')).toHaveLength(1);
      expect(inbox.b.matching('lead.new')).toHaveLength(1);
      expect(
        await t.prisma.workerLead.count({ where: { jobId: job.id } }),
      ).toBe(2);
    });

    it('claims a lead for a worker only the first time', async () => {
      const { LeadDeliveryService } =
        await import('../src/modules/scheduling/lead-delivery.service.js');
      const deliveries = t.app.get(LeadDeliveryService);
      const customer = await customerIn(t);
      const a = await verifiedWorkerIn(t);
      const b = await verifiedWorkerIn(t);
      const job = await postJob(t, customer);
      await t.prisma.workerLead.deleteMany({ where: { jobId: job.id } });

      expect((await deliveries.claim(job.id, [a.userId])).sort()).toEqual([
        a.userId,
      ]);
      expect(
        (await deliveries.claim(job.id, [a.userId, b.userId])).sort(),
      ).toEqual([b.userId]);
      expect(await deliveries.claim(job.id, [a.userId, b.userId])).toEqual([]);
      expect(await deliveries.claim(job.id, [])).toEqual([]);
      expect(await deliveries.claimJobs(a.userId, [job.id])).toEqual([]);
    });

    it('does not repeat a direct request that was already sent', async () => {
      const customer = await customerIn(t);
      const worker = await verifiedWorkerIn(t);
      const inbox = await listen(worker);
      const direct = await http
        .post(
          `${V1}/jobs/direct-booking`,
          {
            categoryId: 'plumber',
            title: 'Please come',
            timing: 'IMMEDIATE',
            addressId: customer.addressId,
            workerId: worker.userId,
          },
          { token: customer.accessToken },
        )
        .expect(201);
      await inbox.waitFor('direct.request');

      const { JobEventsService } =
        await import('../src/modules/jobs/job-events.service.js');
      const { jobInclude } =
        await import('../src/modules/jobs/job-view.service.js');
      const row = await t.prisma.job.findUniqueOrThrow({
        where: { id: direct.body.id },
        include: jobInclude,
      });
      await t.app.get(JobEventsService).directRequested(row, worker.userId);
      await settle();
      expect(inbox.matching('direct.request')).toHaveLength(1);
    });
  });

  // ───────────────────────────── 8. who may do what ─────────────────────────────

  describe('access', () => {
    it('keeps the lead and schedule routes to the right people', async () => {
      const customer = await customerIn(t);
      const worker = await verifiedWorkerIn(t);
      const wrongTrade = await verifiedWorkerIn(t, { trades: ['electrician'] });
      const unverified = await verifiedWorkerIn(t, { verified: false });
      const job = await scheduledJob(t, customer, 24 * 60);

      for (const route of [
        `/leads/${job.id}/accept`,
        `/leads/${job.id}/decline`,
      ]) {
        await http.post(`${V1}${route}`, {}).expect(401);
        await http
          .post(`${V1}${route}`, {}, { token: customer.accessToken })
          .expect(403);
        const notVerified = await http
          .post(`${V1}${route}`, {}, { token: unverified.accessToken })
          .expect(403);
        expect(notVerified.body.code).toBe('NOT_VERIFIED');
        await http
          .post(`${V1}${route}`, {}, { token: wrongTrade.accessToken })
          .expect(404);
      }
      await http.get(`${V1}/workers/me/schedule`).expect(401);
      await http
        .get(`${V1}/workers/me/schedule`, { token: customer.accessToken })
        .expect(403);
      expect(
        await t.prisma.workerLead.count({ where: { response: { not: null } } }),
      ).toBe(0);
      expect(worker).toBeTruthy();
    });

    it('never puts an address or phone in lead pushes for scheduled work', async () => {
      const customer = await customerIn(t);
      const worker = await verifiedWorkerIn(t);
      const inbox = await listen(worker);
      await scheduledJob(t, customer, 24 * 60);
      await inbox.waitFor('lead.new');
      const text = JSON.stringify(inbox.received);
      for (const secret of [
        'House #1402',
        'Near Subhash Park',
        'addressLine',
        customer.phone,
        'arrivalCode',
      ])
        expect(text).not.toContain(secret);
    });
  });
});
