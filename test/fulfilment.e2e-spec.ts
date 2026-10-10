import { seedReferenceData } from '../prisma/seed/reference-data.js';
import { api, createTestApp, type TestApp } from './helpers/app.js';
import { resetDatabase } from './helpers/db.js';
import {
  V1,
  VISIT_FEE,
  approveBill,
  arriveAt,
  assigned,
  bothProfiles,
  customerIn,
  finished,
  onSite,
  payFor,
  putItems,
  statusOf,
  underWay,
  verifiedWorkerIn,
} from './helpers/fulfilment.js';
import { giveCoordinates, postJob } from './helpers/marketplace.js';
import { uploadFile } from './helpers/personas.js';
import { ask, closeAllSockets, connect, record } from './helpers/socket.js';

type Inbox = ReturnType<typeof record>;

describe('fulfilment: bill, photos, tracking, SOS, job list, service durations (e2e)', () => {
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
  afterEach(() => {
    closeAllSockets();
    t.safety.sent = [];
    t.safety.fail = false;
  });
  beforeEach(async () => {
    await resetDatabase(t.prisma);
    await seedReferenceData(t.prisma);
  });

  const listen = async (who: { accessToken: string }): Promise<Inbox> =>
    record(await connect(t, who.accessToken));
  const settle = () => new Promise((resolve) => setTimeout(resolve, 250));
  const setFix = (workerId: string, lat: number, lng: number, ageSec = 5) =>
    t.prisma.$executeRaw`
      INSERT INTO worker_locations (worker_id, lat, lng, updated_at)
      VALUES (${workerId}::uuid, ${lat}, ${lng}, now() - make_interval(secs => ${ageSec}))
      ON CONFLICT (worker_id) DO UPDATE SET lat = EXCLUDED.lat, lng = EXCLUDED.lng, updated_at = EXCLUDED.updated_at`;

  // ───────────────────────────── bill ─────────────────────────────

  describe('the bill', () => {
    it.each([
      [
        'the visit-fee kind, which only the system adds',
        [{ kind: 'VISIT_FEE', description: 'x', amount: 5 }],
      ],
      ['an unknown kind', [{ kind: 'TIP', description: 'x', amount: 5 }]],
      ['a zero amount', [{ kind: 'PARTS', description: 'x', amount: 0 }]],
      [
        'a fractional amount',
        [{ kind: 'PARTS', description: 'x', amount: 1.5 }],
      ],
      [
        'an amount over 100,000',
        [{ kind: 'PARTS', description: 'x', amount: 100_001 }],
      ],
      [
        'a blank description',
        [{ kind: 'PARTS', description: '   ', amount: 5 }],
      ],
      [
        'a 121-character description',
        [{ kind: 'PARTS', description: 'x'.repeat(121), amount: 5 }],
      ],
      [
        '21 items',
        Array.from({ length: 21 }, () => ({
          kind: 'PARTS',
          description: 'x',
          amount: 1,
        })),
      ],
      [
        'a platform fee smuggled into an item',
        [{ kind: 'PARTS', description: 'x', amount: 5, platformFee: 10 }],
      ],
    ])(
      'rejects %s with a 422 and leaves the bill alone',
      async (_label, items) => {
        const customer = await customerIn(t);
        const worker = await verifiedWorkerIn(t);
        const { job } = await onSite(t, customer, worker);
        await putItems(t, worker, job.id, items as never).expect(422);
        const bill = await http
          .get(`${V1}/jobs/${job.id}/bill`, { token: worker.accessToken })
          .expect(200);
        expect(bill.body.items).toHaveLength(1); // the visit fee only
        expect(bill.body.total).toBe(VISIT_FEE);
      },
    );

    it('requires the items list and refuses extra fields on the request', async () => {
      const customer = await customerIn(t);
      const worker = await verifiedWorkerIn(t);
      const { job } = await onSite(t, customer, worker);
      await http
        .put(
          `${V1}/jobs/${job.id}/bill-items`,
          {},
          { token: worker.accessToken },
        )
        .expect(422);
      await http
        .put(
          `${V1}/jobs/${job.id}/bill-items`,
          { items: [], total: 1 },
          { token: worker.accessToken },
        )
        .expect(422);
    });

    it('only lets the worker edit while ARRIVED, and the visit fee survives every edit', async () => {
      const customer = await customerIn(t);
      const worker = await verifiedWorkerIn(t);
      const made = await assigned(t, customer, worker);
      await putItems(t, worker, made.job.id, []).expect(409); // not arrived yet
      await arriveAt(t, worker, made.job.id, made.code).expect(200);
      for (let i = 0; i < 3; i += 1)
        await putItems(t, worker, made.job.id, [
          { kind: 'OTHER', description: 'Call-out', amount: 10 + i },
        ]).expect(200);
      const items = await t.prisma.billItem.findMany({
        where: { jobId: made.job.id },
      });
      expect(items.filter((i) => i.kind === 'VISIT_FEE')).toHaveLength(1);
      expect(items.filter((i) => i.kind === 'OTHER')).toHaveLength(1);
    });

    it("a worker's late edit and the customer's approval cannot both win", async () => {
      const customer = await customerIn(t);
      const worker = await verifiedWorkerIn(t);
      const { job } = await onSite(t, customer, worker);
      await putItems(t, worker, job.id, [
        { kind: 'PARTS', description: 'Elbow', amount: 100 },
      ]).expect(200);

      // The customer approves 350 (what they saw) at the same moment the worker raises the bill.
      const [edit, approve] = await Promise.all([
        putItems(t, worker, job.id, [
          { kind: 'PARTS', description: 'Elbow', amount: 900 },
        ]),
        approveBill(t, customer, job.id, VISIT_FEE + 100),
      ]);
      const total = (
        await http
          .get(`${V1}/jobs/${job.id}/bill`, { token: customer.accessToken })
          .expect(200)
      ).body.total;
      if (approve.status === 200) {
        // Approval first: the edit was refused and the customer pays what they approved.
        expect(edit.status).toBe(409);
        expect(total).toBe(VISIT_FEE + 100);
      } else {
        // Edit first: the approval of the old total was refused, nothing was approved.
        expect(edit.status).toBe(200);
        expect(approve.status).toBe(409);
        expect(approve.body.code).toBe('BILL_CHANGED');
        expect(await statusOf(t, job.id)).toBe('ARRIVED');
        expect(total).toBe(VISIT_FEE + 900);
      }
    });

    it('is visible to the two people on the job only, and only once a worker has been chosen', async () => {
      const customer = await customerIn(t);
      const worker = await verifiedWorkerIn(t);
      const open = await postJob(t, customer);
      const early = await http
        .get(`${V1}/jobs/${open.id}/bill`, { token: customer.accessToken })
        .expect(409);
      expect(early.body.code).toBe('BILL_NOT_AVAILABLE');

      const { job } = await assigned(t, await customerIn(t), worker);
      const stranger = await customerIn(t);
      await http
        .get(`${V1}/jobs/${job.id}/bill`, { token: stranger.accessToken })
        .expect(404);
      await http
        .get(`${V1}/jobs/${job.id}/bill`, { token: worker.accessToken })
        .expect(200);
      await http.get(`${V1}/jobs/${job.id}/bill`).expect(401);
    });

    it('approval needs the total that was shown', async () => {
      const customer = await customerIn(t);
      const worker = await verifiedWorkerIn(t);
      const { job } = await onSite(t, customer, worker);
      for (const body of [
        {},
        { expectedTotal: 0 },
        { expectedTotal: 12.5 },
        { expectedTotal: 'all' },
      ]) {
        await http
          .post(`${V1}/jobs/${job.id}/bill/approve`, body, {
            token: customer.accessToken,
          })
          .expect(422);
      }
      expect(await statusOf(t, job.id)).toBe('ARRIVED');
    });
  });

  // ───────────────────────────── work photos ─────────────────────────────

  describe('before and after photos', () => {
    it('are added by the assigned worker while on site and shown to the customer and the worker only', async () => {
      const customer = await customerIn(t);
      const worker = await verifiedWorkerIn(t);
      const { job } = await onSite(t, customer, worker);
      const before = await uploadFile(t, worker.accessToken, 'WORK_PROOF');
      const after = await uploadFile(t, worker.accessToken, 'WORK_PROOF');

      const one = await http
        .post(
          `${V1}/jobs/${job.id}/work-photos`,
          { kind: 'BEFORE', key: before.key },
          { token: worker.accessToken },
        )
        .expect(201);
      expect(one.body.before).toHaveLength(1);
      expect(one.body.after).toHaveLength(0);
      // Sending the same photo twice changes nothing.
      const same = await http
        .post(
          `${V1}/jobs/${job.id}/work-photos`,
          { kind: 'BEFORE', key: before.key },
          { token: worker.accessToken },
        )
        .expect(201);
      expect(same.body.before).toHaveLength(1);
      await http
        .post(
          `${V1}/jobs/${job.id}/work-photos`,
          { kind: 'AFTER', key: after.key },
          { token: worker.accessToken },
        )
        .expect(201);

      for (const who of [customer, worker]) {
        const view = await http
          .get(`${V1}/jobs/${job.id}`, { token: who.accessToken })
          .expect(200);
        expect(view.body.workPhotos.before).toHaveLength(1);
        expect(view.body.workPhotos.after).toHaveLength(1);
      }
      expect(
        await t.prisma.jobMedia.count({
          where: { jobId: job.id, kind: 'BEFORE_PHOTO' },
        }),
      ).toBe(1);
    });

    it("refuses keys that are not the worker's own work-proof uploads, wrong states, and a sixth photo", async () => {
      const customer = await customerIn(t);
      const worker = await verifiedWorkerIn(t);
      const other = await verifiedWorkerIn(t);
      const made = await assigned(t, customer, worker);
      const mine = await uploadFile(t, worker.accessToken, 'WORK_PROOF');

      // Not on site yet.
      await http
        .post(
          `${V1}/jobs/${made.job.id}/work-photos`,
          { kind: 'BEFORE', key: mine.key },
          { token: worker.accessToken },
        )
        .expect(409);
      await arriveAt(t, worker, made.job.id, made.code).expect(200);

      // Someone else's upload, the wrong purpose, a made-up key, a bad kind.
      const theirs = await uploadFile(t, other.accessToken, 'WORK_PROOF');
      const wrongPurpose = await uploadFile(t, worker.accessToken, 'JOB_PHOTO');
      for (const key of [theirs.key, wrongPurpose.key, 'u/not/a/key.jpg'])
        await http
          .post(
            `${V1}/jobs/${made.job.id}/work-photos`,
            { kind: 'BEFORE', key },
            { token: worker.accessToken },
          )
          .expect(422);
      await http
        .post(
          `${V1}/jobs/${made.job.id}/work-photos`,
          { kind: 'DURING', key: mine.key },
          { token: worker.accessToken },
        )
        .expect(422);

      // At most five of each kind.
      for (let i = 0; i < 5; i += 1) {
        const up = await uploadFile(t, worker.accessToken, 'WORK_PROOF');
        await http
          .post(
            `${V1}/jobs/${made.job.id}/work-photos`,
            { kind: 'AFTER', key: up.key },
            { token: worker.accessToken },
          )
          .expect(201);
      }
      const sixth = await uploadFile(t, worker.accessToken, 'WORK_PROOF');
      const refused = await http
        .post(
          `${V1}/jobs/${made.job.id}/work-photos`,
          { kind: 'AFTER', key: sixth.key },
          { token: worker.accessToken },
        )
        .expect(409);
      expect(refused.body.code).toBe('PHOTO_LIMIT');
    });
  });

  // ───────────────────────────── tracking ─────────────────────────────

  describe('tracking: honest numbers', () => {
    it('measures distance and ETA only from real coordinates, and says how exact they are', async () => {
      await giveCoordinates(t, 'Sector 22');
      const customer = await customerIn(t, 'Sector 22');
      const worker = await verifiedWorkerIn(t);
      const { job } = await assigned(t, customer, worker);

      // The worker is at Phase 7, about 6 km away; the customer shared no GPS, so the area centre is used.
      await setFix(worker.userId, 30.711, 76.72);
      const rough = await http
        .get(`${V1}/jobs/${job.id}/tracking`, { token: customer.accessToken })
        .expect(200);
      expect(rough.body.distanceBasis).toBe('AREA_CENTROID');
      expect(rough.body.distanceKm).toBeGreaterThan(5);
      expect(rough.body.etaMinutes).toBe(
        Math.ceil((rough.body.distanceKm / 20) * 60),
      );
      expect(rough.body.location).toMatchObject({
        lat: 30.711,
        lng: 76.72,
        stale: false,
      });

      // With the customer's own coordinates it is labelled as exact.
      await t.prisma.job.update({
        where: { id: job.id },
        data: { lat: 30.7333, lng: 76.7794 },
      });
      const exact = await http
        .get(`${V1}/jobs/${job.id}/tracking`, { token: customer.accessToken })
        .expect(200);
      expect(exact.body.distanceBasis).toBe('JOB_COORDINATES');
    });

    it('flags a fix older than two minutes as stale, and drops the distance for one older than thirty', async () => {
      await giveCoordinates(t, 'Sector 22');
      const customer = await customerIn(t, 'Sector 22');
      const worker = await verifiedWorkerIn(t);
      const { job } = await assigned(t, customer, worker);
      const read = async () =>
        (
          await http
            .get(`${V1}/jobs/${job.id}/tracking`, {
              token: customer.accessToken,
            })
            .expect(200)
        ).body;

      await setFix(worker.userId, 30.711, 76.72, 10);
      expect((await read()).location.stale).toBe(false);
      await setFix(worker.userId, 30.711, 76.72, 3 * 60);
      const stale = await read();
      expect(stale.location.stale).toBe(true);
      expect(stale.distanceKm).not.toBeNull();
      await setFix(worker.userId, 30.711, 76.72, 40 * 60);
      const old = await read();
      expect(old.location.stale).toBe(true);
      expect(old).toMatchObject({ distanceKm: null, etaMinutes: null });
    });

    it('is available from assignment until the work is done, and not before or after', async () => {
      const customer = await customerIn(t);
      const worker = await verifiedWorkerIn(t);
      const open = await postJob(t, customer);
      const asking = (id: string) =>
        http.get(`${V1}/jobs/${id}/tracking`, { token: customer.accessToken });
      expect((await asking(open.id).expect(409)).body.code).toBe(
        'TRACKING_NOT_AVAILABLE',
      );

      const made = await finished(t, customer, worker);
      await asking(made.job.id).expect(200); // WORK_COMPLETED
      await payFor(t, customer, made.job.id).expect(200);
      await asking(made.job.id).expect(409); // COMPLETED
    });

    it("pushes job.location to whoever is watching, from the REST update and from the socket, and only for the worker's own job", async () => {
      await giveCoordinates(t, 'Sector 22');
      const customer = await customerIn(t, 'Sector 22');
      const worker = await verifiedWorkerIn(t);
      const stranger = await verifiedWorkerIn(t);
      const { job } = await assigned(t, customer, worker);

      const watcher = await connect(t, customer.accessToken);
      const events = record(watcher);
      expect(await ask(watcher, 'job:watch', { jobId: job.id })).toEqual({
        ok: true,
      });

      // 1. The REST location update.
      await http
        .put(
          `${V1}/workers/me/location`,
          { lat: 30.711, lng: 76.72 },
          { token: worker.accessToken },
        )
        .expect(200);
      const [first] = await events.waitFor('job.location');
      expect(first).toMatchObject({
        jobId: job.id,
        lat: 30.711,
        lng: 76.72,
        distanceBasis: 'AREA_CENTROID',
        distanceKm: expect.any(Number),
        etaMinutes: expect.any(Number),
      });

      // 2. The socket update (needs a moment: one fix per three seconds is stored).
      const phone = await connect(t, worker.accessToken);
      await new Promise((resolve) => setTimeout(resolve, 3100));
      const ack = await ask(phone, 'location:update', {
        jobId: job.id,
        lat: 30.72,
        lng: 76.75,
      });
      expect(ack).toEqual({ ok: true, accepted: true });
      const second = (await events.waitFor('job.location', 2))[1];
      expect(second).toMatchObject({ lat: 30.72, lng: 76.75 });
      // Faster than that is acknowledged but not stored or rebroadcast.
      expect(
        await ask(phone, 'location:update', {
          jobId: job.id,
          lat: 30.73,
          lng: 76.76,
        }),
      ).toEqual({ ok: true, accepted: false });
      await settle();
      expect(events.matching('job.location')).toHaveLength(2);

      // Not someone else's job, not nonsense, not a job that is over.
      const intruder = await connect(t, stranger.accessToken);
      expect(
        await ask(intruder, 'location:update', {
          jobId: job.id,
          lat: 1,
          lng: 1,
        }),
      ).toEqual({ ok: false, error: 'NOT_FOUND' });
      for (const bad of [
        { jobId: job.id, lat: 'x', lng: 1 },
        { jobId: job.id, lat: 91, lng: 1 },
        { jobId: 'nope', lat: 1, lng: 1 },
        null,
      ])
        expect(await ask(phone, 'location:update', bad)).toEqual({
          ok: false,
          error: 'INVALID',
        });
      await t.prisma.job.update({
        where: { id: job.id },
        data: { status: 'IN_PROGRESS', arrivedAt: new Date() },
      });
      expect(
        await ask(phone, 'location:update', {
          jobId: job.id,
          lat: 30.7,
          lng: 76.7,
        }),
      ).toEqual({ ok: false, error: 'NOT_FOUND' });
    });

    it('does not send job.location to people who are not watching, and nothing after the worker has arrived', async () => {
      const customer = await customerIn(t);
      const worker = await verifiedWorkerIn(t);
      const { job } = await assigned(t, customer, worker);
      const notWatching = await listen(customer);
      await http
        .put(
          `${V1}/workers/me/location`,
          { lat: 30.711, lng: 76.72 },
          { token: worker.accessToken },
        )
        .expect(200);
      await settle();
      expect(notWatching.matching('job.location')).toEqual([]);

      await t.prisma.job.update({
        where: { id: job.id },
        data: { status: 'ARRIVED', arrivedAt: new Date() },
      });
      const watcher = await connect(t, customer.accessToken);
      const events = record(watcher);
      await ask(watcher, 'job:watch', { jobId: job.id });
      await new Promise((resolve) => setTimeout(resolve, 3100));
      await http
        .put(
          `${V1}/workers/me/location`,
          { lat: 30.7112, lng: 76.7201 },
          { token: worker.accessToken },
        )
        .expect(200);
      await settle();
      expect(events.matching('job.location')).toEqual([]);
    });
  });

  // ───────────────────────────── location permission rules ─────────────────────────────

  describe('who may report a location', () => {
    it('lets a verified worker always, a worker in review only while a job is assigned to them', async () => {
      const customer = await customerIn(t);
      const worker = await verifiedWorkerIn(t);
      const body = { lat: 30.7, lng: 76.7 };
      await t.prisma.workerProfile.update({
        where: { userId: worker.userId },
        data: { verificationStatus: 'PENDING' },
      });

      const refused = await http
        .put(`${V1}/workers/me/location`, body, { token: worker.accessToken })
        .expect(403);
      expect(refused.body.code).toBe('NOT_VERIFIED');

      // Verified again, they take a job, lose verification: they may still report where they are.
      await t.prisma.workerProfile.update({
        where: { userId: worker.userId },
        data: { verificationStatus: 'VERIFIED' },
      });
      await assigned(t, customer, worker);
      await t.prisma.workerProfile.update({
        where: { userId: worker.userId },
        data: { verificationStatus: 'PENDING' },
      });
      await http
        .put(`${V1}/workers/me/location`, body, { token: worker.accessToken })
        .expect(200);

      // A customer-only user has no worker profile at all.
      await http
        .put(`${V1}/workers/me/location`, body, { token: customer.accessToken })
        .expect(403);
    });
  });

  // ───────────────────────────── SOS ─────────────────────────────

  describe('SOS', () => {
    it('lets the worker raise it, using their last stored fix when the phone sends none (and saying so)', async () => {
      const customer = await customerIn(t);
      const worker = await verifiedWorkerIn(t);
      const { job } = await assigned(t, customer, worker);

      // No fix and no coordinates: the desk is told the location is unknown, not given a guess.
      const none = await http
        .post(`${V1}/jobs/${job.id}/sos`, {}, { token: worker.accessToken })
        .expect(201);
      expect(t.safety.sent[0]).toMatchObject({
        alertId: none.body.alertId,
        raisedBy: { role: 'WORKER' },
        otherParty: { role: 'CUSTOMER', phone: customer.phone },
        location: null,
      });
      const row = await t.prisma.sosAlert.findUniqueOrThrow({
        where: { id: none.body.alertId },
      });
      expect(row.lat).toBeNull();

      // With a stored fix, it is used and labelled with its age.
      await t.prisma.sosAlert.deleteMany();
      await setFix(worker.userId, 30.711, 76.72, 90);
      await http
        .post(`${V1}/jobs/${job.id}/sos`, {}, { token: worker.accessToken })
        .expect(201);
      expect(t.safety.sent[1]?.location).toMatchObject({
        source: 'LAST_WORKER_FIX',
        lat: 30.711,
        lng: 76.72,
        fixAgeSec: expect.any(Number),
      });
      expect(t.safety.sent[1]!.location!.fixAgeSec).toBeGreaterThanOrEqual(89);
    });

    it('does not page the desk twice for a double tap, but does for a later, separate alert', async () => {
      const customer = await customerIn(t);
      const worker = await verifiedWorkerIn(t);
      const { job } = await assigned(t, customer, worker);
      const first = await http
        .post(`${V1}/jobs/${job.id}/sos`, {}, { token: customer.accessToken })
        .expect(201);
      const again = await http
        .post(`${V1}/jobs/${job.id}/sos`, {}, { token: customer.accessToken })
        .expect(201);
      expect(again.body).toEqual({
        alertId: first.body.alertId,
        repeated: true,
      });
      expect(t.safety.sent).toHaveLength(1);
      expect(await t.prisma.sosAlert.count()).toBe(1);

      // The worker's own alert is separate, and an older one makes room for a new one.
      await http
        .post(`${V1}/jobs/${job.id}/sos`, {}, { token: worker.accessToken })
        .expect(201);
      expect(t.safety.sent).toHaveLength(2);
      await t.prisma.sosAlert.updateMany({
        where: { userId: customer.userId },
        data: { createdAt: new Date(Date.now() - 5 * 60_000) },
      });
      const later = await http
        .post(`${V1}/jobs/${job.id}/sos`, {}, { token: customer.accessToken })
        .expect(201);
      expect(later.body.repeated).toBe(false);
      expect(t.safety.sent).toHaveLength(3);
    });

    it('keeps the alert and still answers 201 when the safety desk cannot be reached', async () => {
      const customer = await customerIn(t);
      const worker = await verifiedWorkerIn(t);
      const { job } = await assigned(t, customer, worker);
      t.safety.fail = true;
      const res = await http
        .post(`${V1}/jobs/${job.id}/sos`, {}, { token: customer.accessToken })
        .expect(201);
      expect(
        await t.prisma.sosAlert.findUnique({ where: { id: res.body.alertId } }),
      ).toMatchObject({ status: 'OPEN' });
      expect(t.safety.sent).toEqual([]);
    });

    it('validates the coordinates, and works only while a worker is on the job', async () => {
      const customer = await customerIn(t);
      const worker = await verifiedWorkerIn(t);
      const open = await postJob(t, customer);
      expect(
        (
          await http
            .post(
              `${V1}/jobs/${open.id}/sos`,
              {},
              { token: customer.accessToken },
            )
            .expect(409)
        ).body.code,
      ).toBe('SOS_NOT_AVAILABLE');

      const made = await finished(t, customer, worker);
      for (const bad of [
        { lat: 30.7 },
        { lng: 76.7 },
        { lat: 91, lng: 0 },
        { lat: 0, lng: 181 },
        { lat: 'x', lng: 1 },
      ])
        await http
          .post(`${V1}/jobs/${made.job.id}/sos`, bad, {
            token: customer.accessToken,
          })
          .expect(422);
      await http
        .post(
          `${V1}/jobs/${made.job.id}/sos`,
          {},
          { token: customer.accessToken },
        )
        .expect(201); // WORK_COMPLETED still counts
      await payFor(t, customer, made.job.id).expect(200);
      await t.prisma.sosAlert.deleteMany();
      await http
        .post(
          `${V1}/jobs/${made.job.id}/sos`,
          {},
          { token: customer.accessToken },
        )
        .expect(409); // COMPLETED does not
      await http.post(`${V1}/jobs/${made.job.id}/sos`, {}).expect(401);
    });
  });

  // ───────────────────────────── the worker's job list ─────────────────────────────

  describe('GET /workers/me/jobs', () => {
    it('lists each tab newest first with a cursor, and customer-only users are refused', async () => {
      const worker = await verifiedWorkerIn(t);
      const customers = [
        await customerIn(t),
        await customerIn(t),
        await customerIn(t),
      ];

      // Three jobs one after the other (each finished before the next so the worker is free).
      const ids: string[] = [];
      for (const customer of customers) {
        const made = await finished(t, customer, worker, 100);
        await payFor(t, customer, made.job.id).expect(200);
        ids.push(made.job.id);
      }
      const first = await http
        .get(`${V1}/workers/me/jobs?tab=completed&limit=2`, {
          token: worker.accessToken,
        })
        .expect(200);
      expect(first.body.items.map((i: { id: string }) => i.id)).toEqual([
        ids[2],
        ids[1],
      ]);
      expect(first.body.nextCursor).toEqual(expect.any(String));
      expect(first.body.items[0]).toMatchObject({
        status: 'COMPLETED',
        total: VISIT_FEE + 100,
        customerName: 'Sunita Sharma',
      });
      const rest = await http
        .get(
          `${V1}/workers/me/jobs?tab=completed&limit=2&cursor=${encodeURIComponent(first.body.nextCursor)}`,
          { token: worker.accessToken },
        )
        .expect(200);
      expect(rest.body.items.map((i: { id: string }) => i.id)).toEqual([
        ids[0],
      ]);
      expect(rest.body.nextCursor).toBeNull();
      expect(rest.body.meta.counts).toEqual({
        ongoing: 0,
        completed: 3,
        cancelled: 0,
      });

      await http
        .get(`${V1}/workers/me/jobs`, { token: customers[0]!.accessToken })
        .expect(403);
      await http.get(`${V1}/workers/me/jobs`).expect(401);
      await http
        .get(`${V1}/workers/me/jobs?tab=weird`, { token: worker.accessToken })
        .expect(422);
    });

    it('puts a job the customer cancelled after assignment in the cancelled tab, and drops a re-opened one entirely', async () => {
      const worker = await verifiedWorkerIn(t);
      const c1 = await customerIn(t);
      const c2 = await customerIn(t);
      const cancelled = await assigned(t, c1, worker);
      await http
        .post(
          `${V1}/jobs/${cancelled.job.id}/cancel`,
          {},
          { token: c1.accessToken },
        )
        .expect(200);
      const backedOut = await assigned(t, c2, worker);
      await http
        .post(
          `${V1}/jobs/${backedOut.job.id}/cancel`,
          {},
          { token: worker.accessToken },
        )
        .expect(200);

      const res = await http
        .get(`${V1}/workers/me/jobs?tab=cancelled`, {
          token: worker.accessToken,
        })
        .expect(200);
      expect(res.body.items.map((i: { id: string }) => i.id)).toEqual([
        cancelled.job.id,
      ]);
      expect(res.body.meta.counts).toEqual({
        ongoing: 0,
        completed: 0,
        cancelled: 1,
      });
      // No address in a list item.
      expect(JSON.stringify(res.body)).not.toContain('House #1402');
    });
  });

  // ───────────────────────────── service durations (decision D-14) ─────────────────────────────

  describe('PATCH /admin/service-categories/:id/duration', () => {
    async function admin() {
      const me = await customerIn(t);
      await t.prisma.user.update({
        where: { id: me.userId },
        data: { isAdmin: true },
      });
      return me;
    }
    const url = (id: string) => `${V1}/admin/service-categories/${id}/duration`;

    afterEach(async () => {
      await t.prisma.serviceCategory.updateMany({
        data: { defaultDurationMin: null },
      });
    });

    it('sets how long a service usually takes, and new jobs for it use that length', async () => {
      const boss = await admin();
      const set = await http
        .patch(
          url('plumber'),
          { defaultDurationMin: 120 },
          { token: boss.accessToken },
        )
        .expect(200);
      expect(set.body).toEqual({ id: 'plumber', defaultDurationMin: 120 });

      const customer = await customerIn(t);
      expect((await postJob(t, customer)).durationMin).toBe(120);
      expect(
        (await postJob(t, customer, { categoryId: 'electrician' })).durationMin,
      ).toBe(90); // others unchanged
      expect(
        (await postJob(t, customer, { durationMin: 45 })).durationMin,
      ).toBe(45); // the customer's own number wins

      await http
        .patch(
          url('plumber'),
          { defaultDurationMin: null },
          { token: boss.accessToken },
        )
        .expect(200);
      expect((await postJob(t, customer)).durationMin).toBe(90);
    });

    it('rejects nonsense, unknown services, non-admins and anonymous callers', async () => {
      const boss = await admin();
      for (const bad of [
        {},
        { defaultDurationMin: 10 },
        { defaultDurationMin: 481 },
        { defaultDurationMin: 'long' },
        { defaultDurationMin: 90.5 },
      ])
        await http
          .patch(url('plumber'), bad, { token: boss.accessToken })
          .expect(422);
      await http
        .patch(
          url('astrology'),
          { defaultDurationMin: 60 },
          { token: boss.accessToken },
        )
        .expect(404);

      const customer = await customerIn(t);
      await http
        .patch(
          url('plumber'),
          { defaultDurationMin: 60 },
          { token: customer.accessToken },
        )
        .expect(404);
      await http.patch(url('plumber'), { defaultDurationMin: 60 }).expect(401);
      expect(
        (
          await t.prisma.serviceCategory.findUniqueOrThrow({
            where: { id: 'plumber' },
          })
        ).defaultDurationMin,
      ).toBeNull();
    });

    it('changes only what new jobs get; a booking already made keeps its window', async () => {
      const boss = await admin();
      const customer = await customerIn(t);
      const worker = await verifiedWorkerIn(t);
      const { job } = await assigned(t, customer, worker);
      const before = await t.prisma.job.findUniqueOrThrow({
        where: { id: job.id },
      });
      await http
        .patch(
          url('plumber'),
          { defaultDurationMin: 200 },
          { token: boss.accessToken },
        )
        .expect(200);
      const after = await t.prisma.job.findUniqueOrThrow({
        where: { id: job.id },
      });
      expect(after.durationMin).toBe(before.durationMin);
      expect(after.bookedEndAt).toEqual(before.bookedEndAt);
    });
  });

  // ───────────────────────────── access matrix and privacy ─────────────────────────────

  describe('access to every new route', () => {
    it('answers anonymous callers with 401 and a stranger with 404 (or 403 when they lack the profile)', async () => {
      const customer = await customerIn(t);
      const worker = await verifiedWorkerIn(t);
      const { job } = await onSite(t, customer, worker);
      const fake = '018f0000-0000-7000-8000-000000000000';

      const routes: [string, string, object | undefined][] = [
        ['post', `/jobs/${job.id}/arrival`, { code: '1234' }],
        ['put', `/jobs/${job.id}/bill-items`, { items: [] }],
        ['post', `/jobs/${job.id}/work-photos`, { kind: 'BEFORE', key: 'x' }],
        ['post', `/jobs/${job.id}/complete-work`, {}],
        ['post', `/jobs/${job.id}/bill/approve`, { expectedTotal: 1 }],
        ['post', `/jobs/${job.id}/payment`, { method: 'CASH' }],
        ['get', `/jobs/${job.id}/bill`, undefined],
        ['get', `/jobs/${job.id}/tracking`, undefined],
        ['get', `/jobs/${job.id}/receipt`, undefined],
        ['post', `/jobs/${job.id}/sos`, {}],
        ['get', `/workers/me/jobs`, undefined],
      ];
      const call = (
        method: string,
        path: string,
        body: object | undefined,
        token?: string,
      ) => {
        const opts = token ? { token } : {};
        return method === 'get'
          ? http.get(`${V1}${path}`, opts)
          : method === 'put'
            ? http.put(`${V1}${path}`, body, opts)
            : http.post(`${V1}${path}`, body, opts);
      };
      const outsider = await bothProfiles(t); // has BOTH profiles, but is nobody on this job
      for (const [method, path, body] of routes) {
        expect(
          (await call(method, path, body)).status,
          `anonymous ${method} ${path}`,
        ).toBe(401);
        if (path === '/workers/me/jobs') continue;
        const res = await call(method, path, body, outsider.accessToken);
        expect(res.status, `outsider ${method} ${path}`).toBe(404);
        // An unknown job id behaves exactly like someone else's.
        const unknown = await call(
          method,
          path.replace(job.id, fake),
          body,
          outsider.accessToken,
        );
        expect(unknown.status, `unknown id ${method} ${path}`).toBe(404);
      }
      expect(await statusOf(t, job.id)).toBe('ARRIVED'); // nothing above changed the job
    });

    it('never puts an address, a phone number or the arrival code in a live event', async () => {
      const customer = await customerIn(t);
      const worker = await verifiedWorkerIn(t);
      const inbox = {
        customer: await listen(customer),
        worker: await listen(worker),
      };
      const made = await finished(t, customer, worker);
      await payFor(t, customer, made.job.id).expect(200);
      await settle();
      const text = JSON.stringify([
        ...inbox.customer.received,
        ...inbox.worker.received,
      ]);
      for (const secret of [
        'House #1402',
        'Near Subhash Park',
        'addressLine',
        customer.phone,
        worker.phone,
        made.code ? `"arrivalCode":"${made.code}"` : 'arrivalCode',
      ])
        expect(text).not.toContain(secret);
    });

    it('shows a worker the address only while the job is live for them', async () => {
      const customer = await customerIn(t);
      const worker = await verifiedWorkerIn(t);
      const made = await underWay(t, customer, worker);
      const live = await http
        .get(`${V1}/jobs/${made.job.id}`, { token: worker.accessToken })
        .expect(200);
      expect(live.body.addressLine).toBe('House #1402, Near Subhash Park');
      await t.prisma.job.update({
        where: { id: made.job.id },
        data: {
          status: 'CANCELLED',
          cancelledAt: new Date(),
          cancelledBy: 'CUSTOMER',
        },
      });
      const over = await http
        .get(`${V1}/jobs/${made.job.id}`, { token: worker.accessToken })
        .expect(200);
      expect(over.body.addressLine).toBeUndefined();
    });
  });
});
