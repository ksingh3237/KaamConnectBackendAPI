import { seedReferenceData } from '../../prisma/seed/reference-data.js';
import { LeadCatchUpService } from '../../src/modules/offers/lead-catch-up.service.js';
import { api, createTestApp, type TestApp } from '../helpers/app.js';
import { resetDatabase } from '../helpers/db.js';
import { customerIn, verifiedWorkerIn } from '../helpers/marketplace.js';

const V1 = '/api/v1';
const WORKERS = 5_000;
const OPEN_JOBS = 600;
const COMPLETED_JOBS = 30_000;
const CANCELLED_JOBS = 19_400;
const SAMPLES = 40;

/** Phase 4 acceptance (docs/07-roadmap.md): discovery p95 < 300 ms on 5,000 workers. */
const P95_BUDGET_MS = 300;

const percentile = (sorted: number[], p: number) =>
  sorted[
    Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  ]!;

describe('marketplace performance at launch scale (5,000 workers, 50,000 jobs)', () => {
  let t: TestApp;
  let http: ReturnType<typeof api>;
  const report: Record<string, string>[] = [];

  beforeAll(async () => {
    t = await createTestApp();
    http = api(t.app);
    await resetDatabase(t.prisma);
    await seedReferenceData(t.prisma);
    await bulkLoad();
  });
  afterAll(async () => {
    // Written straight to the terminal so the table survives vitest's output capturing.
    const header = ['endpoint', 'p50 ms', 'p95 ms', 'max ms'] as const;
    const lines = [
      header.join(' | '),
      ...report.map((r) => header.map((h) => r[h] ?? '').join(' | ')),
    ];
    process.stderr.write(`\n${lines.join('\n')}\n\n`);
    await t.close();
  });

  /** Loads rows straight with SQL (the API would take minutes). Only ever runs on the *_test database. */
  async function bulkLoad() {
    const sql = (text: string) => t.prisma.$executeRawUnsafe(text);
    const CATS = `ARRAY['electrician','plumber','ac_repair','carpenter','painter','cleaner','appliance','car_wash']`;
    const AREAS = `(SELECT array_agg(id ORDER BY id) FROM areas)`;

    // 5,000 verified workers, spread over all areas and trades.
    await sql(`INSERT INTO users (id, phone, language, is_admin, is_active, created_at, updated_at)
      SELECT gen_random_uuid(), '+9170' || lpad(g::text, 8, '0'), 'en', false, true, now(), now() FROM generate_series(1, ${WORKERS}) g`);
    await sql(`INSERT INTO worker_profiles (user_id, full_name, base_area_id, radius_km, experience_years, languages, skills,
        verification_status, terms_accepted_at, rating_sum, review_count, created_at, updated_at)
      SELECT u.id, 'Perf Worker ' || n, (${AREAS})[1 + (n % 13)], (ARRAY[3,6,12])[1 + (n % 3)], 1 + (n % 30),
        ARRAY['hi']::"Language"[], ARRAY['Wiring','Pipes']::text[], 'VERIFIED', now(), (n % 50), (n % 11), now(), now()
      FROM (SELECT id, row_number() OVER (ORDER BY phone) AS n FROM users WHERE phone LIKE '+9170%') u`);
    await sql(`INSERT INTO worker_trades (worker_id, category_id, is_primary)
      SELECT user_id, (${CATS})[1 + (row_number() OVER (ORDER BY user_id) % 8)], true FROM worker_profiles WHERE full_name LIKE 'Perf Worker%'`);

    // 300 customers with an address each, then the jobs.
    await sql(`INSERT INTO users (id, phone, language, is_admin, is_active, created_at, updated_at)
      SELECT gen_random_uuid(), '+9171' || lpad(g::text, 8, '0'), 'en', false, true, now(), now() FROM generate_series(1, 300) g`);
    await sql(`INSERT INTO customer_profiles (user_id, full_name, comm_language, allow_direct_calls, created_at, updated_at)
      SELECT id, 'Perf Customer', 'hi', true, now(), now() FROM users WHERE phone LIKE '+9171%'`);

    const customers = `(SELECT array_agg(user_id ORDER BY user_id) FROM customer_profiles WHERE full_name = 'Perf Customer')`;
    const workers = `(SELECT array_agg(user_id ORDER BY user_id) FROM worker_profiles WHERE full_name LIKE 'Perf Worker%')`;
    const jobColumns = `id, customer_id, category_id, title, timing, area_id, address_line, status, worker_id, expires_at,
        cancelled_at, cancelled_by, completed_at, created_at, updated_at, booked_start_at, booked_end_at, booking_confirmed_at`;
    const common = (n: string) =>
      `gen_random_uuid(), (${customers})[1 + (${n} % 300)], (${CATS})[1 + (${n} % 8)], 'Perf job ' || ${n}, 'IMMEDIATE', (${AREAS})[1 + (${n} % 13)], 'House ' || ${n}`;

    await sql(`INSERT INTO jobs (${jobColumns}) SELECT ${common('g')}, 'OPEN', NULL, now() + interval '20 hours',
        NULL, NULL, NULL, now() - (g || ' seconds')::interval, now(), NULL, NULL, NULL FROM generate_series(1, ${OPEN_JOBS}) g`);
    await sql(`INSERT INTO jobs (${jobColumns}) SELECT ${common('g')}, 'COMPLETED', (${workers})[1 + (g % ${WORKERS})], now() - interval '3 days',
        NULL, NULL, now() - interval '2 days', now() - ((g + 1000) || ' minutes')::interval, now(),
        now() - interval '2 days 2 hours', now() - interval '2 days 30 minutes', now() - interval '2 days 3 hours' FROM generate_series(1, ${COMPLETED_JOBS}) g`);
    await sql(`INSERT INTO jobs (${jobColumns}) SELECT ${common('g')}, 'CANCELLED', NULL, now() - interval '3 days',
        now() - interval '2 days', 'SYSTEM', NULL, now() - ((g + 50000) || ' minutes')::interval, now(), NULL, NULL, NULL FROM generate_series(1, ${CANCELLED_JOBS}) g`);
    // Money and feedback behind every finished job, so the activity, earnings and savings queries have real rows.
    await sql(`INSERT INTO payments (id, job_id, method, amount, status, marked_at)
      SELECT gen_random_uuid(), id, 'CASH', 300 + (job_number % 1700), 'MARKED_PAID', completed_at FROM jobs WHERE status = 'COMPLETED'`);
    await sql(`INSERT INTO bill_items (id, job_id, kind, description, amount, created_at)
      SELECT gen_random_uuid(), j.id, k.kind::"BillItemKind", 'Perf item', 150 + (j.job_number % 800), j.created_at
      FROM jobs j CROSS JOIN (VALUES ('VISIT_FEE'), ('LABOUR')) AS k(kind) WHERE j.status = 'COMPLETED'`);
    await sql(`INSERT INTO reviews (id, job_id, customer_id, worker_id, rating, tags, tip_amount, created_at)
      SELECT gen_random_uuid(), id, customer_id, worker_id, 1 + (job_number % 5), ARRAY[]::"ReviewTag"[], 0, completed_at
      FROM jobs WHERE status = 'COMPLETED' AND job_number % 3 = 0`);
    // Quotes at a realistic volume (about three per job), so the offers indexes are judged on a table of real size:
    // one ACCEPTED quote per finished job (from its worker) and two REJECTED ones, three PENDING ones per open job.
    await sql(`INSERT INTO offers (id, job_id, worker_id, visit_fee, eta_minutes, status, accepted_at, created_at, updated_at)
      SELECT gen_random_uuid(), j.id, j.worker_id, 200, 30, 'ACCEPTED', j.assigned_at, j.created_at, j.created_at
      FROM jobs j WHERE j.status = 'COMPLETED'`);
    await sql(`INSERT INTO offers (id, job_id, worker_id, visit_fee, eta_minutes, status, created_at, updated_at)
      SELECT gen_random_uuid(), j.id, (${workers})[1 + ((j.job_number * 13 + k * 97) % ${WORKERS})], 250, 30,
        CASE WHEN j.status = 'OPEN' THEN 'PENDING' ELSE 'REJECTED' END::"OfferStatus", j.created_at, j.created_at
      FROM jobs j CROSS JOIN generate_series(1, 2) k WHERE j.status IN ('COMPLETED', 'OPEN')
      ON CONFLICT (job_id, worker_id) DO NOTHING`);
    await sql('ANALYZE');
  }

  /** Gives `workerId` and `customerId` a realistic heavy history: `n` finished jobs each (cannot overlap: they are COMPLETED). */
  async function giveHistory(workerId: string, customerId: string, n: number) {
    await t.prisma.$executeRawUnsafe(
      `UPDATE jobs SET worker_id = '${workerId}'::uuid WHERE id IN
         (SELECT id FROM jobs WHERE status = 'COMPLETED' ORDER BY id LIMIT ${n})`,
    );
    await t.prisma.$executeRawUnsafe(
      `UPDATE reviews SET worker_id = '${workerId}'::uuid WHERE job_id IN (SELECT id FROM jobs WHERE worker_id = '${workerId}'::uuid)`,
    );
    await t.prisma.$executeRawUnsafe(
      `UPDATE jobs SET customer_id = '${customerId}'::uuid WHERE id IN
         (SELECT id FROM jobs WHERE status = 'COMPLETED' ORDER BY id DESC LIMIT ${n})`,
    );
    await t.prisma.$executeRawUnsafe(
      `UPDATE reviews SET customer_id = '${customerId}'::uuid WHERE job_id IN (SELECT id FROM jobs WHERE customer_id = '${customerId}'::uuid)`,
    );
    // A worker with quotes waiting on open jobs (the "pending quotes" part of the Activity screen).
    await t.prisma.$executeRawUnsafe(
      `INSERT INTO offers (id, job_id, worker_id, visit_fee, eta_minutes, status, created_at, updated_at)
       SELECT gen_random_uuid(), id, '${workerId}'::uuid, 300, 30, 'PENDING', created_at, created_at
       FROM jobs WHERE status = 'OPEN' ORDER BY id LIMIT 30 ON CONFLICT (job_id, worker_id) DO NOTHING`,
    );
    await t.prisma.$executeRawUnsafe('ANALYZE jobs');
    await t.prisma.$executeRawUnsafe('ANALYZE offers');
  }

  /** Runs EXPLAIN (ANALYZE) and returns every plan node, for "no sequential scan on a big table" checks. */
  async function explain(label: string, query: string) {
    const rows = await t.prisma.$queryRawUnsafe<{ 'QUERY PLAN': any }[]>(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query}`,
    );
    const plan = rows[0]!['QUERY PLAN'][0];
    const nodes: any[] = [];
    const walk = (node: any) => {
      nodes.push(node);
      (node.Plans ?? []).forEach(walk);
    };
    walk(plan.Plan);
    const summary = nodes.map(
      (n) =>
        `${n['Node Type']}${n['Relation Name'] ? ` on ${n['Relation Name']}` : ''}${n['Index Name'] ? ` (${n['Index Name']})` : ''}`,
    );
    report.push({
      endpoint: `EXPLAIN ${label}`,
      'p50 ms': plan['Execution Time'].toFixed(1),
      'p95 ms': '',
      'max ms': summary.join(' > '),
    });
    const bigSeqScans = nodes
      .filter(
        (n) =>
          n['Node Type'] === 'Seq Scan' &&
          // payments is left out on purpose: a hash join over one heavy user's 2,000 of 30,000 payments is the
          // planner's right choice at this size; its time is still held to the budget by the caller.
          ['jobs', 'reviews', 'bill_items', 'offers'].includes(
            n['Relation Name'],
          ),
      )
      .map((n) => n['Relation Name']);
    return { plan, summary, bigSeqScans };
  }

  /** Runs `call` sequentially `SAMPLES` times and records p50 / p95 / max. */
  async function measure(
    name: string,
    call: () => Promise<void>,
    budgetMs?: number,
  ) {
    await call(); // warm-up: connection pool, JIT
    const times: number[] = [];
    for (let i = 0; i < SAMPLES; i += 1) {
      const start = performance.now();
      await call();
      times.push(performance.now() - start);
    }
    times.sort((a, b) => a - b);
    const row = {
      endpoint: name,
      'p50 ms': percentile(times, 50).toFixed(0),
      'p95 ms': percentile(times, 95).toFixed(0),
      'max ms': times[times.length - 1]!.toFixed(0),
    };
    report.push(row);
    if (budgetMs !== undefined)
      expect(percentile(times, 95), `${name} p95`).toBeLessThan(budgetMs);
  }

  it('loaded the expected volume', async () => {
    expect(
      await t.prisma.workerProfile.count({
        where: { verificationStatus: 'VERIFIED' },
      }),
    ).toBe(WORKERS);
    expect(await t.prisma.job.count()).toBe(
      OPEN_JOBS + COMPLETED_JOBS + CANCELLED_JOBS,
    );
  });

  it('GET /workers (discovery) p95 stays under 300 ms with 5,000 workers', async () => {
    const customer = await customerIn(t, 'Sector 22');
    await measure(
      'GET /workers',
      async () => {
        await http
          .get(`${V1}/workers?limit=20`, { token: customer.accessToken })
          .expect(200);
      },
      P95_BUDGET_MS,
    );
    await measure(
      'GET /workers?categoryId=plumber&sort=rating',
      async () => {
        await http
          .get(`${V1}/workers?categoryId=plumber&sort=rating&limit=20`, {
            token: customer.accessToken,
          })
          .expect(200);
      },
      P95_BUDGET_MS,
    );
  });

  it('GET /leads (radar) p95 stays under 300 ms with 50,000 jobs', async () => {
    const worker = await verifiedWorkerIn(t, {
      trades: ['plumber'],
      area: 'Sector 22',
    });
    await measure(
      'GET /leads',
      async () => {
        await http
          .get(`${V1}/leads?limit=20`, { token: worker.accessToken })
          .expect(200);
      },
      P95_BUDGET_MS,
    );
  });

  it('GET /customers/me/jobs and POST /jobs (with fan-out to matching workers)', async () => {
    const customer = await customerIn(t, 'Sector 22');
    await measure(
      'GET /customers/me/jobs',
      async () => {
        await http
          .get(`${V1}/customers/me/jobs`, { token: customer.accessToken })
          .expect(200);
      },
      P95_BUDGET_MS,
    );

    let posted = 0;
    await measure(
      'POST /jobs (finds + notifies matching workers)',
      async () => {
        // Stay under the 10-open-jobs-per-customer cap by closing each job straight away.
        const res = await http
          .post(
            `${V1}/jobs`,
            {
              categoryId: 'plumber',
              title: 'Perf',
              timing: 'IMMEDIATE',
              addressId: customer.addressId,
            },
            { token: customer.accessToken },
          )
          .expect(201);
        posted = res.body.notifiedWorkers;
        await http
          .post(
            `${V1}/jobs/${res.body.id}/cancel`,
            {},
            { token: customer.accessToken },
          )
          .expect(200);
      },
    );
    report.push({
      endpoint: '  (plumbers notified per new job)',
      'p50 ms': String(posted),
      'p95 ms': '',
      'max ms': '',
    });
    expect(posted).toBeGreaterThan(50);
  });

  it('discovery returns EVERY worker who serves the customer, not just the first few hundred rows', async () => {
    const customer = await customerIn(t, 'Sector 22');
    // Without area coordinates the rule is "same city": everyone based in Chandigarh, nobody else.
    const [{ n }] = await t.prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM worker_profiles w
      JOIN areas a ON a.id = w.base_area_id JOIN cities c ON c.id = a.city_id
      WHERE c.name = 'Chandigarh' AND w.verification_status = 'VERIFIED' AND w.user_id <> ${customer.userId}::uuid`;

    const seen = new Set<string>();
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res: {
        status: number;
        body: { items: { id: string }[]; nextCursor: string | null };
      } = await http.get(
        `${V1}/workers?limit=50${cursor ? `&cursor=${cursor}` : ''}`,
        { token: customer.accessToken },
      );
      expect(res.status).toBe(200);
      res.body.items.forEach((i) => seen.add(i.id));
      cursor = res.body.nextCursor;
      pages += 1;
    } while (cursor && pages < 200);

    expect(Number(n)).toBeGreaterThan(1500); // far more than the old 500-row cap
    expect(seen.size).toBe(Number(n));
  });

  it('lead catch-up: a first position fix that claims a large batch of open leads (Phase 7, Milestone B)', async () => {
    const worker = await verifiedWorkerIn(t, {
      area: 'Sector 22',
      trades: ['plumber', 'electrician'], // two trades: the most a worker can have
    });
    const catchUp = t.app.get(LeadCatchUpService);
    const times: number[] = [];
    let claimedEach = 0;
    for (let i = 0; i < 20; i += 1) {
      // Forget what was sent, so each run claims the whole batch again (the delivery guard is the only memory).
      await t.prisma.workerLead.deleteMany({
        where: { workerId: worker.userId },
      });
      const start = performance.now();
      claimedEach = await catchUp.onFix(
        { workerId: worker.userId, lat: 30.7333, lng: 76.7794, previous: null },
        Date.now() + (i + 1) * 120_000, // two minutes apart: always "time to look again"
      );
      times.push(performance.now() - start);
    }
    times.sort((a, b) => a - b);
    report.push({
      endpoint: `lead catch-up, first fix (${claimedEach} leads claimed and pushed)`,
      'p50 ms': percentile(times, 50).toFixed(0),
      'p95 ms': percentile(times, 95).toFixed(0),
      'max ms': times[times.length - 1]!.toFixed(0),
    });
    expect(claimedEach).toBeGreaterThan(20);
    expect(percentile(times, 95)).toBeLessThan(P95_BUDGET_MS);
  });

  it('serves 20 simultaneous discovery requests without errors', async () => {
    const customer = await customerIn(t, 'Sector 22');
    const start = performance.now();
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        http.get(`${V1}/workers?limit=20`, { token: customer.accessToken }),
      ),
    );
    const elapsed = performance.now() - start;
    expect(results.every((r) => r.status === 200)).toBe(true);
    report.push({
      endpoint: '20 concurrent GET /workers (wall time)',
      'p50 ms': elapsed.toFixed(0),
      'p95 ms': '',
      'max ms': '',
    });
  });

  // Phase 7, Milestone B: the endpoints added after the Phase 4 benchmark, for a HEAVY user (2,000 finished jobs).
  describe('activity, earnings, savings and schedule for a heavy user (2,000 finished jobs)', () => {
    const HISTORY = 2_000;
    let powerWorker: Awaited<ReturnType<typeof verifiedWorkerIn>>;
    let powerCustomer: Awaited<ReturnType<typeof customerIn>>;

    beforeAll(async () => {
      powerWorker = await verifiedWorkerIn(t, { trades: ['plumber'] });
      powerCustomer = await customerIn(t, 'Sector 22');
      await giveHistory(powerWorker.userId, powerCustomer.userId, HISTORY);
    });

    it('has the history it should', async () => {
      expect(
        await t.prisma.job.count({
          where: { workerId: powerWorker.userId, status: 'COMPLETED' },
        }),
      ).toBe(HISTORY);
      expect(
        await t.prisma.job.count({
          where: { customerId: powerCustomer.userId, status: 'COMPLETED' },
        }),
      ).toBe(HISTORY);
    });

    it('worker: GET /workers/me/jobs (completed, ongoing), earnings, savings, schedule, public profile', async () => {
      const token = powerWorker.accessToken;
      const get = (path: string) => async () => {
        await http.get(`${V1}${path}`, { token }).expect(200);
      };
      await measure(
        'GET /workers/me/jobs?tab=completed',
        get('/workers/me/jobs?tab=completed&limit=20'),
        P95_BUDGET_MS,
      );
      await measure(
        'GET /workers/me/jobs?tab=ongoing',
        get('/workers/me/jobs?tab=ongoing'),
        P95_BUDGET_MS,
      );
      await measure(
        'GET /workers/me/earnings?period=month',
        get('/workers/me/earnings?period=month'),
        P95_BUDGET_MS,
      );
      await measure(
        'GET /me/savings (worker)',
        get('/me/savings?role=worker'),
        P95_BUDGET_MS,
      );
      await measure(
        'GET /workers/me/schedule',
        get('/workers/me/schedule'),
        P95_BUDGET_MS,
      );
    });

    it("customer-facing: GET /workers/:id (the heavy worker's review summary)", async () => {
      await measure(
        'GET /workers/:id (review summary)',
        async () => {
          await http
            .get(`${V1}/workers/${powerWorker.userId}`, {
              token: powerCustomer.accessToken,
            })
            .expect(200);
        },
        P95_BUDGET_MS,
      );
    });

    it('customer: GET /customers/me/jobs (completed) and savings', async () => {
      const token = powerCustomer.accessToken;
      await measure(
        'GET /customers/me/jobs?tab=completed',
        async () => {
          await http
            .get(`${V1}/customers/me/jobs?tab=completed&limit=20`, { token })
            .expect(200);
        },
        P95_BUDGET_MS,
      );
      await measure(
        'GET /me/savings (customer)',
        async () => {
          await http
            .get(`${V1}/me/savings?role=customer`, { token })
            .expect(200);
        },
        P95_BUDGET_MS,
      );
    });

    it('EXPLAIN: earnings, savings, the tab counts and the pending-quotes query use indexes, not whole-table scans', async () => {
      const w = powerWorker.userId;
      const queries: [string, string][] = [
        [
          'worker earnings (month)',
          `SELECT sum(p.amount), count(*) FROM payments p JOIN jobs j ON j.id = p.job_id
           WHERE j.worker_id = '${w}'::uuid AND j.status = 'COMPLETED' AND j.completed_at >= now() - interval '30 days' AND j.completed_at < now()`,
        ],
        [
          'savings (worker)',
          `SELECT sum(p.amount), count(*) FROM payments p JOIN jobs j ON j.id = p.job_id
           WHERE j.worker_id = '${w}'::uuid AND j.status = 'COMPLETED'`,
        ],
        [
          'savings (customer)',
          `SELECT sum(p.amount), count(*) FROM payments p JOIN jobs j ON j.id = p.job_id
           WHERE j.customer_id = '${powerCustomer.userId}'::uuid AND j.status = 'COMPLETED'`,
        ],
        [
          'worker tab counts',
          `SELECT status, count(*) FROM jobs WHERE worker_id = '${w}'::uuid GROUP BY status`,
        ],
        [
          'worker completed list (page 1)',
          `SELECT * FROM jobs WHERE worker_id = '${w}'::uuid AND status IN ('COMPLETED') ORDER BY created_at DESC, id DESC LIMIT 21`,
        ],
        [
          'pending quotes',
          `SELECT * FROM offers o JOIN jobs j ON j.id = o.job_id
           WHERE o.worker_id = '${w}'::uuid AND o.status = 'PENDING' AND j.status = 'OPEN' ORDER BY o.created_at DESC LIMIT 50`,
        ],
        [
          'worker schedule',
          `SELECT * FROM jobs WHERE worker_id = '${w}'::uuid AND status IN ('ASSIGNED','ARRIVED','IN_PROGRESS')
           AND booked_start_at IS NOT NULL AND booked_end_at > now() ORDER BY booked_start_at LIMIT 50`,
        ],
      ];
      const findings: string[] = [];
      for (const [label, query] of queries) {
        const { plan, bigSeqScans, summary } = await explain(label, query);
        if (bigSeqScans.length > 0)
          findings.push(
            `${label}: Seq Scan on ${bigSeqScans.join(', ')} (${summary.join(' > ')})`,
          );
        if (plan['Execution Time'] > 50)
          findings.push(`${label}: ${plan['Execution Time'].toFixed(1)} ms`);
      }
      expect(findings).toEqual([]);
    });
  });

  it('EXPLAIN: the lead-feed query uses the jobs index and does not scan the whole table', async () => {
    const worker = await verifiedWorkerIn(t, { trades: ['plumber'] });
    const rows = await t.prisma.$queryRawUnsafe<{ 'QUERY PLAN': any }[]>(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
       SELECT * FROM jobs
       WHERE status = 'OPEN' AND expires_at > now() AND customer_id <> '${worker.userId}'::uuid
         AND category_id IN ('plumber') AND (target_worker_id IS NULL OR target_worker_id = '${worker.userId}'::uuid)
       ORDER BY created_at DESC, id DESC LIMIT 500`,
    );
    const plan = rows[0]!['QUERY PLAN'][0];
    const nodes: any[] = [];
    const walk = (node: any) => {
      nodes.push(node);
      (node.Plans ?? []).forEach(walk);
    };
    walk(plan.Plan);

    const summary = nodes.map(
      (n) =>
        `${n['Node Type']}${n['Relation Name'] ? ` on ${n['Relation Name']}` : ''}${n['Index Name'] ? ` (${n['Index Name']})` : ''}`,
    );
    report.push({
      endpoint: 'EXPLAIN lead feed',
      'p50 ms': plan['Execution Time'].toFixed(1),
      'p95 ms': '',
      'max ms': summary.join(' > '),
    });

    const seqScansOnJobs = nodes.filter(
      (n) => n['Node Type'] === 'Seq Scan' && n['Relation Name'] === 'jobs',
    );
    expect(seqScansOnJobs, `plan: ${summary.join(' > ')}`).toHaveLength(0);
    expect(plan['Execution Time']).toBeLessThan(50);
  });
});
