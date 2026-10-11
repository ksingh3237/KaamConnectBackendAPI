// Phase 7, Milestone B: "how many quotes" on a LIST of jobs is counted for the page's jobs only (visibleOfferCounts),
// not by a join-time aggregate over every quote. The numbers must be exactly what they were: per job, across
// page boundaries, with the K-36 visibility rule, for the customer list and for the worker lead feed, and equal to
// what the single-job reads say. The existing K-36 spec looks at one job at a time, so it cannot see a list where
// every row got the same number or the numbers shifted across a page.

import { seedReferenceData } from '../prisma/seed/reference-data.js';
import { api, createTestApp, type TestApp } from './helpers/app.js';
import { resetDatabase } from './helpers/db.js';
import { V1 } from './helpers/fulfilment.js';
import {
  customerIn,
  postJob,
  sendQuote,
  verifiedWorkerIn,
} from './helpers/marketplace.js';
import { acceptQuote } from './helpers/scheduling.js';

interface Row {
  id: string;
  offersCount: number;
}

describe('quote counts on lists (e2e)', () => {
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

  /**
   * Customer c1 posts A (no quote), B (1 quote) and C (3 quotes, one from a worker who is then sent back for
   * review, so 2 are visible). Customer c2 has D with 1 quote, to prove counts never leak between customers.
   */
  async function scene() {
    const c1 = await customerIn(t);
    const c2 = await customerIn(t);
    const w1 = await verifiedWorkerIn(t, { fullName: 'Rajesh Kumar' });
    const w2 = await verifiedWorkerIn(t, { fullName: 'Sunil Verma' });
    const reviewed = await verifiedWorkerIn(t, { fullName: 'Amit Sharma' });
    const viewer = await verifiedWorkerIn(t, { fullName: 'Viewer Worker' });

    const a = await postJob(t, c1, { title: 'Job A' });
    const b = await postJob(t, c1, { title: 'Job B' });
    const c = await postJob(t, c1, { title: 'Job C' });
    const d = await postJob(t, c2, { title: 'Job D' });
    await sendQuote(t, w1, b.id);
    await sendQuote(t, w1, c.id);
    await sendQuote(t, w2, c.id);
    await sendQuote(t, reviewed, c.id);
    await sendQuote(t, w2, d.id);
    await t.prisma.workerProfile.update({
      where: { userId: reviewed.userId },
      data: { verificationStatus: 'PENDING' },
    });
    return { c1, c2, w1, w2, reviewed, viewer, a, b, c, d };
  }

  /** Walks every page of a list and returns its rows, newest first, plus how many pages it took. */
  async function walk(path: string, token: string, limit: number) {
    const rows: Row[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const sep = path.includes('?') ? '&' : '?';
      const res: {
        body: { items: Row[]; nextCursor: string | null };
      } = await http
        .get(
          `${V1}${path}${sep}limit=${limit}${cursor ? `&cursor=${cursor}` : ''}`,
          { token },
        )
        .expect(200);
      rows.push(...res.body.items);
      cursor = res.body.nextCursor;
      pages += 1;
    } while (cursor && pages < 20);
    return { rows, pages };
  }

  const countsOf = (rows: Row[]) =>
    Object.fromEntries(rows.map((r) => [r.id, r.offersCount]));

  it('customer list: each row has its own count, across page boundaries, and the hidden quote is not counted', async () => {
    const s = await scene();
    const { rows, pages } = await walk(
      '/customers/me/jobs?tab=ongoing',
      s.c1.accessToken,
      2,
    );
    expect(pages).toBe(2); // 3 jobs, 2 per page: the boundary splits C,B | A
    expect(rows.map((r) => r.id)).toEqual([s.c.id, s.b.id, s.a.id]);
    expect(countsOf(rows)).toEqual({ [s.a.id]: 0, [s.b.id]: 1, [s.c.id]: 2 });
  });

  it("customer list: counts never include another customer's quotes", async () => {
    const s = await scene();
    const { rows } = await walk(
      '/customers/me/jobs?tab=ongoing',
      s.c2.accessToken,
      20,
    );
    expect(countsOf(rows)).toEqual({ [s.d.id]: 1 });
  });

  it('customer list: a chosen worker is always counted (ACCEPTED), and the list agrees with GET /jobs/:id', async () => {
    const s = await scene();
    const quotes = await http
      .get(`${V1}/jobs/${s.b.id}/offers`, { token: s.c1.accessToken })
      .expect(200);
    await acceptQuote(t, s.c1, s.b.id, quotes.body[0].offerId).expect(200);

    const { rows } = await walk(
      '/customers/me/jobs?tab=ongoing',
      s.c1.accessToken,
      20,
    );
    for (const row of rows) {
      const single = await http
        .get(`${V1}/jobs/${row.id}`, { token: s.c1.accessToken })
        .expect(200);
      expect(row.offersCount, `list vs single for ${row.id}`).toBe(
        single.body.offersCount,
      );
    }
    expect(countsOf(rows)[s.b.id]).toBe(1);
  });

  it('customer list: a customer with no jobs gets an empty page (no count query is needed)', async () => {
    await scene();
    const empty = await customerIn(t);
    const { rows } = await walk(
      '/customers/me/jobs?tab=ongoing',
      empty.accessToken,
      20,
    );
    expect(rows).toEqual([]);
  });

  it('worker lead feed: each lead has its own count across pages, equal to the single-lead read and to what the customer sees', async () => {
    const s = await scene();
    const { rows, pages } = await walk('/leads', s.viewer.accessToken, 2);
    expect(pages).toBeGreaterThanOrEqual(2);
    const counts = countsOf(rows);
    expect(counts).toMatchObject({
      [s.a.id]: 0,
      [s.b.id]: 1,
      [s.c.id]: 2,
      [s.d.id]: 1,
    });

    for (const row of rows) {
      const detail = await http
        .get(`${V1}/leads/${row.id}`, { token: s.viewer.accessToken })
        .expect(200);
      expect(detail.body.offersCount, `feed vs detail for ${row.id}`).toBe(
        row.offersCount,
      );
    }
  });

  it('the quote of a worker under review comes back into the count when they are verified again', async () => {
    const s = await scene();
    await t.prisma.workerProfile.update({
      where: { userId: s.reviewed.userId },
      data: { verificationStatus: 'VERIFIED' },
    });
    const customerRows = (
      await walk('/customers/me/jobs?tab=ongoing', s.c1.accessToken, 2)
    ).rows;
    expect(countsOf(customerRows)[s.c.id]).toBe(3);
    const leadRows = (await walk('/leads', s.viewer.accessToken, 2)).rows;
    expect(countsOf(leadRows)[s.c.id]).toBe(3);
  });
});
