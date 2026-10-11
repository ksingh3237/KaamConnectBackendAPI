// Phase 6: reviews and tips, the activity extras, worker earnings and "commission saved".
// Everything goes through the real HTTP API and real PostgreSQL. Jobs that only need to EXIST in a state
// (for boundary and arithmetic tests) are inserted directly; the main journeys use the real endpoints.

import { seedReferenceData } from '../prisma/seed/reference-data.js';
import { api, createTestApp, type TestApp } from './helpers/app.js';
import { resetDatabase } from './helpers/db.js';
import { makeJob } from './helpers/factories.js';
import {
  V1,
  bothProfiles,
  customerIn,
  finished,
  payFor,
  verifiedWorkerIn,
} from './helpers/fulfilment.js';
import type { Customer, Worker } from './helpers/marketplace.js';

describe('Phase 6: reviews, activity, earnings and savings (e2e)', () => {
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

  // ───────────────────────────── helpers ─────────────────────────────

  /** The real journey: assigned, arrived, billed, approved, finished and paid. */
  async function paid(customer: Customer, worker: Worker, extra = 300) {
    const made = await finished(t, customer, worker, extra);
    await payFor(t, customer, made.job.id).expect(200);
    return made;
  }

  /** A job that merely exists in a state (no HTTP): for arithmetic and boundary tests. */
  async function inserted(
    customerId: string,
    workerId: string | null,
    options: {
      status?: 'COMPLETED' | 'WORK_COMPLETED' | 'CANCELLED' | 'OPEN';
      amount?: number | null; // null = no payment row
      completedAt?: Date;
    } = {},
  ) {
    const completedAt = options.completedAt ?? new Date();
    const status = options.status ?? 'COMPLETED';
    const job = await makeJob(t.prisma, customerId, {
      status,
      workerId,
      completedAt:
        status === 'COMPLETED' || options.completedAt ? completedAt : null,
      ...(status === 'CANCELLED'
        ? { cancelledAt: completedAt, cancelledBy: 'CUSTOMER' as const }
        : {}),
    });
    const amount = options.amount === undefined ? 500 : options.amount;
    if (amount !== null)
      await t.prisma.payment.create({
        data: { jobId: job.id, method: 'CASH', amount, markedAt: completedAt },
      });
    return job;
  }

  const review = (
    jobId: string,
    who: { accessToken: string },
    body: object = { rating: 5 },
  ) =>
    http.post(`${V1}/jobs/${jobId}/review`, body, { token: who.accessToken });
  const workerRow = (workerId: string) =>
    t.prisma.workerProfile.findUniqueOrThrow({ where: { userId: workerId } });

  // ───────────────────────────── reviews ─────────────────────────────

  describe('POST /jobs/:id/review', () => {
    it('rates a paid job: stored, the worker totals move, and every screen shows it', async () => {
      const customer = await customerIn(t);
      const worker = await verifiedWorkerIn(t, { fullName: 'Rajesh Kumar' });
      const { job } = await paid(customer, worker);

      // Before: the customer is invited to review.
      const before = await http
        .get(`${V1}/jobs/${job.id}`, { token: customer.accessToken })
        .expect(200);
      expect(before.body).toMatchObject({ canReview: true, review: null });

      const res = await review(job.id, customer, {
        rating: 4,
        tags: ['PUNCTUAL', 'POLITE'],
        tipAmount: 50,
      }).expect(201);
      expect(res.body).toMatchObject({
        jobId: job.id,
        rating: 4,
        tags: ['PUNCTUAL', 'POLITE'],
        tipAmount: 50,
        worker: { id: worker.userId, rating: 4, reviewsCount: 1 },
      });

      const profile = await workerRow(worker.userId);
      expect(profile).toMatchObject({ ratingSum: 4, reviewCount: 1 });

      // The job, as the customer and as the worker.
      const asCustomer = await http
        .get(`${V1}/jobs/${job.id}`, { token: customer.accessToken })
        .expect(200);
      expect(asCustomer.body).toMatchObject({
        canReview: false,
        review: { rating: 4, tags: ['PUNCTUAL', 'POLITE'], tipAmount: 50 },
      });
      const asWorker = await http
        .get(`${V1}/jobs/${job.id}`, { token: worker.accessToken })
        .expect(200);
      expect(asWorker.body.review).toMatchObject({ rating: 4, tipAmount: 50 });
      expect(asWorker.body.canReview).toBeUndefined();

      // Discovery and the worker's profile.
      const card = await http
        .get(`${V1}/workers/${worker.userId}`, { token: customer.accessToken })
        .expect(200);
      expect(card.body).toMatchObject({ rating: 4, reviewsCount: 1 });
      const list = await http
        .get(`${V1}/workers`, { token: customer.accessToken })
        .expect(200);
      expect(
        list.body.items.find((w: { id: string }) => w.id === worker.userId),
      ).toMatchObject({ rating: 4, reviewsCount: 1 });

      // Activity rows on both sides.
      const mine = await http
        .get(`${V1}/customers/me/jobs?tab=completed`, {
          token: customer.accessToken,
        })
        .expect(200);
      expect(mine.body.items[0]).toMatchObject({ rating: 4, reviewed: true });
      const theirs = await http
        .get(`${V1}/workers/me/jobs?tab=completed`, {
          token: worker.accessToken,
        })
        .expect(200);
      expect(theirs.body.items[0]).toMatchObject({ rating: 4 });
    });

    it('tags and tip are optional (no tags, no tip)', async () => {
      const customer = await customerIn(t);
      const worker = await verifiedWorkerIn(t);
      const { job } = await paid(customer, worker);
      const res = await review(job.id, customer, { rating: 5 }).expect(201);
      expect(res.body).toMatchObject({ rating: 5, tags: [], tipAmount: 0 });
    });

    it('a tip is only recorded: it changes neither the payment nor the worker earnings', async () => {
      const customer = await customerIn(t);
      const worker = await verifiedWorkerIn(t);
      const { job, total } = await paid(customer, worker);
      await review(job.id, customer, { rating: 5, tipAmount: 100 }).expect(201);
      const payment = await t.prisma.payment.findUniqueOrThrow({
        where: { jobId: job.id },
      });
      expect(payment.amount).toBe(total);
      const earned = await http
        .get(`${V1}/workers/me/earnings`, { token: worker.accessToken })
        .expect(200);
      expect(earned.body.amount).toBe(total);
    });

    it('rejects bad input with 422 and stores nothing', async () => {
      const customer = await customerIn(t);
      const worker = await verifiedWorkerIn(t);
      const { job } = await paid(customer, worker);
      const bad: [string, object][] = [
        ['rating missing', {}],
        ['rating 0', { rating: 0 }],
        ['rating 6', { rating: 6 }],
        ['rating 4.5', { rating: 4.5 }],
        ['rating as text', { rating: '5' }],
        ['unknown tag', { rating: 5, tags: ['NICE'] }],
        ['duplicate tag', { rating: 5, tags: ['POLITE', 'POLITE'] }],
        ['tags not a list', { rating: 5, tags: 'POLITE' }],
        ['negative tip', { rating: 5, tipAmount: -1 }],
        ['tip above 5000', { rating: 5, tipAmount: 5001 }],
        ['fractional tip', { rating: 5, tipAmount: 10.5 }],
        ['free-text comment (there is none)', { rating: 5, comment: 'great' }],
      ];
      for (const [label, body] of bad) {
        const res = await review(job.id, customer, body);
        expect([label, res.status]).toEqual([label, 422]);
        expect(res.body.code).toBe('VALIDATION_FAILED');
      }
      expect(await t.prisma.review.count()).toBe(0);
      expect(await workerRow(worker.userId)).toMatchObject({
        ratingSum: 0,
        reviewCount: 0,
      });
      // The edge values are fine.
      await review(job.id, customer, {
        rating: 1,
        tags: [
          'PUNCTUAL',
          'FAIR_PRICE',
          'CLEAN_WORK',
          'POLITE',
          'EXPERT_SKILL',
        ],
        tipAmount: 5000,
      }).expect(201);
    });

    it("only the job's own customer: everyone else gets the same 404 as an unknown job", async () => {
      const customer = await customerIn(t);
      const stranger = await customerIn(t);
      const worker = await verifiedWorkerIn(t);
      const { job } = await paid(customer, worker);

      await http.post(`${V1}/jobs/${job.id}/review`, { rating: 5 }).expect(401);
      await review(job.id, worker).expect(403); // a worker without a customer profile
      await review(job.id, stranger).expect(404);
      await review('0197a0c0-0000-7000-8000-000000000000', customer).expect(
        404,
      );
      await http
        .post(
          `${V1}/jobs/not-a-uuid/review`,
          { rating: 5 },
          { token: customer.accessToken },
        )
        .expect(400);
      expect(await t.prisma.review.count()).toBe(0);
    });

    it('the worker of the job cannot rate themselves, even holding a customer profile too', async () => {
      const customer = await customerIn(t);
      const dual = await bothProfiles(t);
      const { job } = await paid(customer, {
        ...dual,
        baseAreaId: 0,
      } as unknown as Worker);
      await review(job.id, dual).expect(404);
      expect(await t.prisma.review.count()).toBe(0);
    });

    it('only after the payment was recorded (COMPLETED); changes nothing before', async () => {
      const customer = await customerIn(t);
      const worker = await verifiedWorkerIn(t);
      for (const status of ['OPEN', 'WORK_COMPLETED', 'CANCELLED'] as const) {
        const job = await inserted(
          customer.userId,
          status === 'OPEN' ? null : worker.userId,
          {
            status,
            amount: null,
          },
        );
        const res = await review(job.id, customer).expect(409);
        expect(res.body.code).toBe('REVIEW_NOT_ALLOWED');
      }
      expect(await t.prisma.review.count()).toBe(0);
    });

    it('once per job: the second try is 409 and the totals do not move', async () => {
      const customer = await customerIn(t);
      const worker = await verifiedWorkerIn(t);
      const { job } = await paid(customer, worker);
      await review(job.id, customer, { rating: 5 }).expect(201);
      const again = await review(job.id, customer, { rating: 1 }).expect(409);
      expect(again.body.code).toBe('ALREADY_REVIEWED');
      expect(await workerRow(worker.userId)).toMatchObject({
        ratingSum: 5,
        reviewCount: 1,
      });
    });

    it('ten simultaneous taps on one job: exactly one review, totals counted once', async () => {
      const customer = await customerIn(t);
      const worker = await verifiedWorkerIn(t);
      const { job } = await paid(customer, worker);
      const results = await Promise.all(
        Array.from({ length: 10 }, () =>
          review(job.id, customer, { rating: 3 }),
        ),
      );
      expect(results.filter((r) => r.status === 201)).toHaveLength(1);
      expect(results.filter((r) => r.status === 409)).toHaveLength(9);
      expect(await t.prisma.review.count()).toBe(1);
      expect(await workerRow(worker.userId)).toMatchObject({
        ratingSum: 3,
        reviewCount: 1,
      });
    });

    it('twelve customers rating the same worker at the same moment lose no count', async () => {
      const worker = await verifiedWorkerIn(t);
      const raters: { customer: Customer; jobId: string; rating: number }[] =
        [];
      for (let i = 0; i < 12; i++) {
        const customer = await customerIn(t);
        const job = await inserted(customer.userId, worker.userId);
        raters.push({ customer, jobId: job.id, rating: (i % 5) + 1 });
      }
      const results = await Promise.all(
        raters.map((r) => review(r.jobId, r.customer, { rating: r.rating })),
      );
      expect(results.map((r) => r.status)).toEqual(Array(12).fill(201));

      const expectedSum = raters.reduce((s, r) => s + r.rating, 0);
      expect(await workerRow(worker.userId)).toMatchObject({
        ratingSum: expectedSum,
        reviewCount: 12,
      });
      // The running totals always agree with the rows they summarise.
      const [truth] = await t.prisma.$queryRaw<{ n: bigint; s: bigint }[]>`
        SELECT count(*) AS n, sum(rating) AS s FROM reviews WHERE worker_id = ${worker.userId}::uuid`;
      expect([Number(truth!.n), Number(truth!.s)]).toEqual([12, expectedSum]);
    });

    it('a better average ranks a worker higher when sorting by rating', async () => {
      const customer = await customerIn(t);
      const good = await verifiedWorkerIn(t, { fullName: 'Good Worker' });
      const fair = await verifiedWorkerIn(t, { fullName: 'Fair Worker' });
      await review(
        (await inserted(customer.userId, good.userId)).id,
        customer,
        { rating: 5 },
      ).expect(201);
      await review(
        (await inserted(customer.userId, fair.userId)).id,
        customer,
        { rating: 3 },
      ).expect(201);
      const res = await http
        .get(`${V1}/workers?sort=rating`, { token: customer.accessToken })
        .expect(200);
      const ids = res.body.items.map((w: { id: string }) => w.id);
      expect(ids.indexOf(good.userId)).toBeLessThan(ids.indexOf(fair.userId));
    });
  });

  describe('GET /workers/:id review summary', () => {
    it('shows totals, the star split and the latest ten, newest first, without naming the reviewers', async () => {
      const worker = await verifiedWorkerIn(t);
      const viewer = await customerIn(t);
      const ratings = [5, 5, 4, 3, 5, 1, 4, 5, 2, 5, 4, 5]; // 12 reviews, oldest first
      for (const rating of ratings) {
        const c = await customerIn(t);
        const job = await inserted(c.userId, worker.userId);
        await review(job.id, c, { rating, tags: ['PUNCTUAL'] }).expect(201);
      }
      const res = await http
        .get(`${V1}/workers/${worker.userId}`, { token: viewer.accessToken })
        .expect(200);
      const summary = res.body.reviews;
      expect(summary.reviewsCount).toBe(12);
      expect(summary.rating).toBe(
        Math.round((ratings.reduce((a, b) => a + b, 0) / 12) * 10) / 10,
      );
      expect(summary.distribution).toEqual({
        '1': 1,
        '2': 1,
        '3': 1,
        '4': 3,
        '5': 6,
      });
      expect(summary.latest).toHaveLength(10);
      expect(summary.latest[0].rating).toBe(5); // the newest
      expect(summary.latest[9].rating).toBe(4); // 10th newest = the 3rd review given
      expect(summary.latest[0]).toEqual({
        rating: expect.any(Number),
        tags: ['PUNCTUAL'],
        createdAt: expect.any(String),
      });
      // No reviewer identity anywhere in the summary.
      expect(Object.keys(summary.latest[0]).sort()).toEqual([
        'createdAt',
        'rating',
        'tags',
      ]);
    });

    it('a worker with no reviews has an empty, well-formed summary', async () => {
      const worker = await verifiedWorkerIn(t);
      const viewer = await customerIn(t);
      const res = await http
        .get(`${V1}/workers/${worker.userId}`, { token: viewer.accessToken })
        .expect(200);
      expect(res.body.reviews).toEqual({
        rating: null,
        reviewsCount: 0,
        distribution: { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 },
        latest: [],
      });
    });
  });

  // ───────────────────────────── activity ─────────────────────────────

  describe('activity tabs', () => {
    it('counts match the lists on both sides, and completed rows say whether and how they were rated', async () => {
      const customer = await customerIn(t);
      const worker = await verifiedWorkerIn(t);
      const rated = await inserted(customer.userId, worker.userId);
      const unrated = await inserted(customer.userId, worker.userId);
      await inserted(customer.userId, worker.userId, {
        status: 'CANCELLED',
        amount: null,
      });
      await inserted(customer.userId, null, { status: 'OPEN', amount: null });
      await review(rated.id, customer, { rating: 2 }).expect(201);

      for (const [who, path] of [
        [customer, 'customers/me/jobs'],
        [worker, 'workers/me/jobs'],
      ] as const) {
        const counts = (
          await http
            .get(`${V1}/${path}`, { token: who.accessToken })
            .expect(200)
        ).body.meta.counts;
        for (const tab of ['ongoing', 'completed', 'cancelled'] as const) {
          const list = await http
            .get(`${V1}/${path}?tab=${tab}`, { token: who.accessToken })
            .expect(200);
          expect([
            who === customer ? 'customer' : 'worker',
            tab,
            list.body.items.length,
          ]).toEqual([
            who === customer ? 'customer' : 'worker',
            tab,
            counts[tab],
          ]);
        }
      }

      const done = await http
        .get(`${V1}/customers/me/jobs?tab=completed`, {
          token: customer.accessToken,
        })
        .expect(200);
      const byId = new Map(
        done.body.items.map((i: { id: string }) => [i.id, i]),
      );
      expect(byId.get(rated.id)).toMatchObject({ rating: 2, reviewed: true });
      expect(byId.get(unrated.id)).toMatchObject({
        rating: null,
        reviewed: false,
      });

      // Not completed: the fields are absent from non-completed rows rather than misleading.
      const ongoing = await http
        .get(`${V1}/customers/me/jobs?tab=ongoing`, {
          token: customer.accessToken,
        })
        .expect(200);
      expect(ongoing.body.items[0].rating).toBeUndefined();
    });
  });

  // ───────────────────────────── earnings ─────────────────────────────

  /** Midnight (start of the day) in India, computed independently of the production helper. */
  function istMidnightOf(now: Date): Date {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kolkata',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(now); // e.g. 2026-10-11
    return new Date(`${parts}T00:00:00+05:30`);
  }

  describe('GET /workers/me/earnings', () => {
    it('adds up today (IST) for this worker only: paid jobs, no unpaid, cancelled, other workers or other days', async () => {
      const customer = await customerIn(t);
      const worker = await verifiedWorkerIn(t);
      const other = await verifiedWorkerIn(t);
      const start = istMidnightOf(new Date());

      await inserted(customer.userId, worker.userId, { amount: 1000 });
      await inserted(customer.userId, worker.userId, { amount: 450 });
      await inserted(customer.userId, worker.userId, {
        amount: 700,
        completedAt: new Date(start.getTime() - 1),
      }); // yesterday 23:59:59.999 IST
      await inserted(customer.userId, worker.userId, {
        status: 'WORK_COMPLETED',
        amount: 777,
        completedAt: new Date(),
        // a stray payment on a job that is not COMPLETED must never count
      }); // not paid yet
      await inserted(customer.userId, worker.userId, {
        status: 'CANCELLED',
        amount: 888,
        completedAt: new Date(),
      });
      await inserted(customer.userId, other.userId, { amount: 9999 });

      const res = await http
        .get(`${V1}/workers/me/earnings`, { token: worker.accessToken })
        .expect(200);
      expect(res.body).toMatchObject({
        period: 'today',
        amount: 1450,
        jobsDone: 2,
        platformFee: 0,
        currency: 'INR',
        timezone: 'Asia/Kolkata',
        from: start.toISOString(),
        to: new Date(start.getTime() + 86_400_000).toISOString(),
      });
    });

    it('the day boundary is midnight IST: a payment 1 ms before belongs to yesterday, exactly at midnight to today', async () => {
      const customer = await customerIn(t);
      const worker = await verifiedWorkerIn(t);
      const start = istMidnightOf(new Date());
      const end = new Date(start.getTime() + 86_400_000);
      await inserted(customer.userId, worker.userId, {
        amount: 1,
        completedAt: new Date(start.getTime() - 1),
      });
      await inserted(customer.userId, worker.userId, {
        amount: 10,
        completedAt: start,
      });
      await inserted(customer.userId, worker.userId, {
        amount: 100,
        completedAt: new Date(end.getTime() - 1),
      });
      await inserted(customer.userId, worker.userId, {
        amount: 1000,
        completedAt: end,
      });
      const res = await http
        .get(`${V1}/workers/me/earnings?period=today`, {
          token: worker.accessToken,
        })
        .expect(200);
      expect([res.body.amount, res.body.jobsDone]).toEqual([110, 2]);
    });

    it('week and month cover the whole IST period and nothing outside it', async () => {
      const customer = await customerIn(t);
      const worker = await verifiedWorkerIn(t);
      const week = await http
        .get(`${V1}/workers/me/earnings?period=week`, {
          token: worker.accessToken,
        })
        .expect(200);
      const month = await http
        .get(`${V1}/workers/me/earnings?period=month`, {
          token: worker.accessToken,
        })
        .expect(200);
      const wFrom = new Date(week.body.from);
      expect(wFrom.getTime() % 86_400_000).toBe(
        istMidnightOf(wFrom).getTime() % 86_400_000,
      ); // starts at IST midnight
      expect(new Date(week.body.to).getTime() - wFrom.getTime()).toBe(
        7 * 86_400_000,
      );
      expect(new Date(month.body.from).getTime()).toBeLessThanOrEqual(
        wFrom.getTime() + 7 * 86_400_000,
      );

      await inserted(customer.userId, worker.userId, {
        amount: 5,
        completedAt: new Date(new Date(week.body.from).getTime() - 1),
      });
      await inserted(customer.userId, worker.userId, {
        amount: 50,
        completedAt: new Date(week.body.from),
      });
      const again = await http
        .get(`${V1}/workers/me/earnings?period=week`, {
          token: worker.accessToken,
        })
        .expect(200);
      expect([again.body.amount, again.body.jobsDone]).toEqual([50, 1]);
    });

    it('zero, not an error, before any job; bad period is 422; needs a worker profile but not verification', async () => {
      const customer = await customerIn(t);
      const worker = await verifiedWorkerIn(t, { verified: false }); // still in review
      const res = await http
        .get(`${V1}/workers/me/earnings`, { token: worker.accessToken })
        .expect(200);
      expect(res.body).toMatchObject({
        amount: 0,
        jobsDone: 0,
        platformFee: 0,
      });
      await http
        .get(`${V1}/workers/me/earnings?period=year`, {
          token: worker.accessToken,
        })
        .expect(422);
      await http.get(`${V1}/workers/me/earnings`).expect(401);
      await http
        .get(`${V1}/workers/me/earnings`, { token: customer.accessToken })
        .expect(403);
    });
  });

  // ───────────────────────────── savings ─────────────────────────────

  describe('GET /me/savings', () => {
    it('customer: paid bills of finished jobs x the benchmark rate (default 20%), and only their own', async () => {
      const customer = await customerIn(t);
      const someoneElse = await customerIn(t);
      const worker = await verifiedWorkerIn(t);
      await inserted(customer.userId, worker.userId, { amount: 1000 });
      await inserted(customer.userId, worker.userId, { amount: 450 });
      await inserted(customer.userId, worker.userId, {
        status: 'WORK_COMPLETED',
        amount: 777, // a stray payment on a job that is not COMPLETED must never count
      });
      await inserted(customer.userId, worker.userId, {
        status: 'CANCELLED',
        amount: 888,
      });
      await inserted(someoneElse.userId, worker.userId, { amount: 8000 });

      const res = await http
        .get(`${V1}/me/savings`, { token: customer.accessToken })
        .expect(200);
      expect(res.body).toEqual({
        commissionSaved: 290,
        benchmarkRate: 0.2,
        currency: 'INR',
        role: 'customer',
        jobsCount: 2,
        jobsTotal: 1450,
      });
    });

    it('worker: the commission they were spared on what they earned', async () => {
      const customer = await customerIn(t);
      const worker = await verifiedWorkerIn(t);
      await inserted(customer.userId, worker.userId, { amount: 2000 });
      const res = await http
        .get(`${V1}/me/savings`, { token: worker.accessToken })
        .expect(200);
      expect(res.body).toMatchObject({
        role: 'worker',
        commissionSaved: 400,
        jobsCount: 1,
        jobsTotal: 2000,
      });
    });

    it('a person with both profiles gets the customer side unless they ask for the worker side', async () => {
      const dual = await bothProfiles(t);
      const customer = await customerIn(t);
      const worker = await verifiedWorkerIn(t);
      await inserted(dual.userId, worker.userId, { amount: 500 }); // dual as the customer
      await inserted(customer.userId, dual.userId, { amount: 3000 }); // dual as the worker

      const byDefault = await http
        .get(`${V1}/me/savings`, { token: dual.accessToken })
        .expect(200);
      expect(byDefault.body).toMatchObject({
        role: 'customer',
        jobsTotal: 500,
        commissionSaved: 100,
      });
      const asWorker = await http
        .get(`${V1}/me/savings?role=worker`, { token: dual.accessToken })
        .expect(200);
      expect(asWorker.body).toMatchObject({
        role: 'worker',
        jobsTotal: 3000,
        commissionSaved: 600,
      });
      await http
        .get(`${V1}/me/savings?role=admin`, { token: dual.accessToken })
        .expect(422);
    });

    it('tips are not part of the figure; a brand-new user sees zeros; unauthenticated is 401', async () => {
      const customer = await customerIn(t);
      const worker = await verifiedWorkerIn(t);
      const job = await inserted(customer.userId, worker.userId, {
        amount: 1000,
      });
      await review(job.id, customer, { rating: 5, tipAmount: 500 }).expect(201);
      const res = await http
        .get(`${V1}/me/savings`, { token: customer.accessToken })
        .expect(200);
      expect(res.body).toMatchObject({ jobsTotal: 1000, commissionSaved: 200 });

      const fresh = await customerIn(t);
      const none = await http
        .get(`${V1}/me/savings`, { token: fresh.accessToken })
        .expect(200);
      expect(none.body).toMatchObject({
        commissionSaved: 0,
        jobsCount: 0,
        jobsTotal: 0,
        benchmarkRate: 0.2,
      });
      await http.get(`${V1}/me/savings`).expect(401);
    });
  });
});
