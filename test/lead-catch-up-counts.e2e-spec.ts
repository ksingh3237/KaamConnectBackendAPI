// Phase 7, Milestone B: when a worker's position changes, the leads that now reach them are pushed in a batch
// (up to 300 at once). Their "how many quotes" number is counted in one query for the whole batch
// (visibleOfferCounts) and not by a join-time aggregate over every quote. The number on each pushed lead must be
// that lead's own, by the K-36 visibility rule, and equal to what the customer sees.

import { seedReferenceData } from '../prisma/seed/reference-data.js';
import { api, createTestApp, type TestApp } from './helpers/app.js';
import { resetDatabase } from './helpers/db.js';
import { V1 } from './helpers/fulfilment.js';
import {
  customerIn,
  giveCoordinates,
  postJob,
  sendQuote,
  verifiedWorkerIn,
} from './helpers/marketplace.js';
import { closeAllSockets, connect, record } from './helpers/socket.js';

const MOHALI = 'Mohali (SAS Nagar)';

describe('lead catch-up: quote counts on pushed leads (e2e)', () => {
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
  beforeEach(async () => {
    await resetDatabase(t.prisma);
    await seedReferenceData(t.prisma);
    await giveCoordinates(t, 'Sector 22'); // the viewer's base area
    await giveCoordinates(t, 'Phase 7', MOHALI); // about 6 km away
  });

  /**
   * Three open jobs in Phase 7 with 0, 1 and 3 quotes; the author of one quote on the third job is then sent back
   * for review, so 2 are visible there. A worker whose base is 6 km away (radius 3) has been told nothing yet.
   */
  async function scene() {
    const customer = await customerIn(t, 'Phase 7', MOHALI);
    const near = { area: 'Phase 7', city: MOHALI };
    const q1 = await verifiedWorkerIn(t, { ...near, fullName: 'Rajesh Kumar' });
    const q2 = await verifiedWorkerIn(t, { ...near, fullName: 'Sunil Verma' });
    const q3 = await verifiedWorkerIn(t, { ...near, fullName: 'Amit Sharma' });
    const viewer = await verifiedWorkerIn(t, { radiusKm: 3 });

    const j0 = await postJob(t, customer, { title: 'Job 0' });
    const j1 = await postJob(t, customer, { title: 'Job 1' });
    const j2 = await postJob(t, customer, { title: 'Job 2' });
    await sendQuote(t, q1, j1.id);
    await sendQuote(t, q1, j2.id);
    await sendQuote(t, q2, j2.id);
    await sendQuote(t, q3, j2.id);
    await t.prisma.workerProfile.update({
      where: { userId: q3.userId },
      data: { verificationStatus: 'PENDING' },
    });
    return { customer, viewer, j0, j1, j2 };
  }

  const moveToPhase7 = (viewer: { accessToken: string }) =>
    http
      .put(
        `${V1}/workers/me/location`,
        { lat: 30.7112, lng: 76.7201 },
        { token: viewer.accessToken },
      )
      .expect(200);

  it('each pushed lead carries its own visible-quote count, and the hidden quote is not counted', async () => {
    const s = await scene();
    const inbox = record(await connect(t, s.viewer.accessToken));
    await inbox.expectNone('lead.new'); // 6 km from home: nothing yet

    await moveToPhase7(s.viewer);
    const leads = (await inbox.waitFor('lead.new', 3)) as {
      id: string;
      reason: string;
      offersCount: number;
    }[];

    expect(leads.map((l) => l.reason)).toEqual([
      'LOCATION',
      'LOCATION',
      'LOCATION',
    ]);
    const counts = Object.fromEntries(leads.map((l) => [l.id, l.offersCount]));
    expect(counts).toEqual({ [s.j0.id]: 0, [s.j1.id]: 1, [s.j2.id]: 2 });
  });

  it("the pushed count equals the number the customer's own screen shows", async () => {
    const s = await scene();
    const inbox = record(await connect(t, s.viewer.accessToken));
    await moveToPhase7(s.viewer);
    const leads = (await inbox.waitFor('lead.new', 3)) as {
      id: string;
      offersCount: number;
    }[];
    for (const lead of leads) {
      const job = await http
        .get(`${V1}/jobs/${lead.id}`, { token: s.customer.accessToken })
        .expect(200);
      expect(lead.offersCount, `pushed vs customer view for ${lead.id}`).toBe(
        job.body.offersCount,
      );
    }
  });

  it('the privacy of the payload is unchanged: no address, no phone', async () => {
    const s = await scene();
    const inbox = record(await connect(t, s.viewer.accessToken));
    await moveToPhase7(s.viewer);
    const leads = await inbox.waitFor('lead.new', 3);
    const text = JSON.stringify(leads);
    expect(text).not.toContain('House #1402');
    expect(text).not.toMatch(/\+91\d{10}/);
    expect(text).not.toContain('addressLine');
  });
});
