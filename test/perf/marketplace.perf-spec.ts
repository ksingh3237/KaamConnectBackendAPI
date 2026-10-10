import { seedReferenceData } from '../../prisma/seed/reference-data.js';
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
    await sql('ANALYZE');
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
