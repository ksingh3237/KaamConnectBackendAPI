import type request from 'supertest';
import { seedReferenceData } from '../prisma/seed/reference-data.js';
import { api, createTestApp, type TestApp } from './helpers/app.js';
import { resetDatabase } from './helpers/db.js';
import {
  customerIn,
  giveCoordinates,
  postJob,
  sendQuote,
  verifiedWorkerIn,
} from './helpers/marketplace.js';
import { uploadFile } from './helpers/personas.js';

const V1 = '/api/v1';
const LEADS = `${V1}/leads`;
const JOBS = `${V1}/jobs`;
const OFFERS = `${V1}/offers`;

describe('leads and quotes (e2e, real PostgreSQL)', () => {
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

  const ids = (body: { items: { id: string }[] }) =>
    body.items.map((i) => i.id);
  const accept = (
    customer: { accessToken: string },
    jobId: string,
    offerId: string,
  ) =>
    http.post(
      `${JOBS}/${jobId}/offers/${offerId}/accept`,
      {},
      { token: customer.accessToken },
    );

  describe('GET /leads (Leads Radar)', () => {
    it("shows open jobs in the worker's trade and city, newest first, and nothing else", async () => {
      const worker = await verifiedWorkerIn(t, { trades: ['plumber'] });
      const customer = await customerIn(t, 'Sector 22');
      const mohali = await customerIn(t, 'Phase 7', 'Mohali (SAS Nagar)');

      const first = await postJob(t, customer, { title: 'First' });
      const second = await postJob(t, customer, { title: 'Second' });
      await postJob(t, customer, {
        categoryId: 'electrician',
        title: 'Wrong trade',
      });
      await postJob(t, mohali, { title: 'Other city' });
      const cancelled = await postJob(t, customer, { title: 'Cancelled' });
      await http
        .post(
          `${JOBS}/${cancelled.id}/cancel`,
          {},
          { token: customer.accessToken },
        )
        .expect(200);
      const expired = await postJob(t, customer, { title: 'Expired' });
      await t.prisma.job.update({
        where: { id: expired.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });

      const res = await http
        .get(LEADS, { token: worker.accessToken })
        .expect(200);
      expect(ids(res.body)).toEqual([second.id, first.id]);
    });

    it('describes each lead for the radar card, with no address and no phone', async () => {
      const worker = await verifiedWorkerIn(t);
      const customer = await customerIn(t);
      const voice = await uploadFile(t, customer.accessToken, 'JOB_VOICE');
      const job = await postJob(t, customer, {
        title: 'Urgent: sink pipe burst',
        description: 'Under-sink PVC pipe cracked',
        voiceNote: { key: voice.key, durationSec: 14 },
      });

      const res = await http
        .get(LEADS, { token: worker.accessToken })
        .expect(200);
      expect(res.body.items[0]).toEqual({
        id: job.id,
        reference: 'KC-10000',
        title: 'Urgent: sink pipe burst',
        category: {
          id: 'plumber',
          title: { en: 'Plumber', hi: 'प्लंबर / नलसाज', pa: 'ਪਲੰਬਰ' },
        },
        customerName: 'Sunita Sharma',
        areaName: 'Sector 22',
        cityName: 'Chandigarh',
        distanceKm: null,
        urgency: 'IMMEDIATE',
        scheduledFor: null,
        durationMin: 90,
        extendedReach: false,
        leadState: 'NEW',
        availability: {
          free: true,
          etaOptions: [15, 30, 45],
          reason: null,
          nextFreeAt: null,
        },
        postedAt: expect.any(String),
        hasVoiceNote: true,
        notes: 'Under-sink PVC pipe cracked',
        offersCount: 0,
        baseVisitFee: 200,
        isDirect: false,
        expiresAt: expect.any(String),
        myOffer: null,
      });

      const text = JSON.stringify(res.body);
      for (const secret of [
        'addressLine',
        'House #1402',
        customer.phone,
        'lat',
        'lng',
        'arrivalCode',
        'storageKey',
      ]) {
        expect(text).not.toContain(secret);
      }
    });

    it("shows the worker their own quote on the lead, and counts everyone's", async () => {
      const worker = await verifiedWorkerIn(t);
      const rival = await verifiedWorkerIn(t);
      const customer = await customerIn(t);
      const job = await postJob(t, customer);
      const mine = await sendQuote(t, worker, job.id, {
        visitFee: 300,
        etaMinutes: 30,
        message: 'On my way',
      });
      await sendQuote(t, rival, job.id);

      const item = (
        await http.get(LEADS, { token: worker.accessToken }).expect(200)
      ).body.items[0];
      expect(item.offersCount).toBe(2);
      expect(item.myOffer).toMatchObject({
        id: mine.id,
        visitFee: 300,
        etaMinutes: 30,
        message: 'On my way',
        status: 'PENDING',
      });
    });

    it('filters: Immediate vs All, and by trade', async () => {
      const worker = await verifiedWorkerIn(t, {
        trades: ['plumber', 'electrician'],
      });
      const customer = await customerIn(t);
      const urgent = await postJob(t, customer, { timing: 'IMMEDIATE' });
      const later = await postJob(t, customer, { timing: 'TOMORROW' });
      const sparky = await postJob(t, customer, {
        categoryId: 'electrician',
        timing: 'AFTERNOON',
      });

      const get = async (query: string) =>
        ids(
          (
            await http
              .get(`${LEADS}${query}`, { token: worker.accessToken })
              .expect(200)
          ).body,
        );
      expect((await get('')).sort()).toEqual(
        [urgent.id, later.id, sparky.id].sort(),
      );
      expect(await get('?filter=all')).toHaveLength(3);
      expect(await get('?filter=immediate')).toEqual([urgent.id]);
      expect(await get('?categoryId=electrician')).toEqual([sparky.id]);
      expect(await get('?categoryId=carpenter')).toEqual([]); // not one of this worker's trades
      expect(await get('?categoryId=plumber&filter=immediate')).toEqual([
        urgent.id,
      ]);
    });

    it('pages newest first without gaps or repeats', async () => {
      const worker = await verifiedWorkerIn(t);
      const customer = await customerIn(t);
      const created: string[] = [];
      for (let i = 0; i < 5; i += 1)
        created.unshift((await postJob(t, customer)).id);

      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const res: request.Response = await http
          .get(`${LEADS}?limit=2${cursor ? `&cursor=${cursor}` : ''}`, {
            token: worker.accessToken,
          })
          .expect(200);
        seen.push(...ids(res.body));
        cursor = res.body.nextCursor;
        pages += 1;
      } while (cursor && pages < 10);
      expect(pages).toBe(3);
      expect(seen).toEqual(created);
    });

    it("with coordinates, hides jobs outside the worker's radius and reports distance on the ones inside", async () => {
      await giveCoordinates(t, 'Sector 22');
      await giveCoordinates(t, 'Sector 35');
      await giveCoordinates(t, 'Phase 7', 'Mohali (SAS Nagar)');
      const worker = await verifiedWorkerIn(t, {
        area: 'Sector 35',
        radiusKm: 3,
      });
      const near = await postJob(t, await customerIn(t, 'Sector 22'));
      await postJob(t, await customerIn(t, 'Phase 7', 'Mohali (SAS Nagar)'));

      const res = await http
        .get(LEADS, { token: worker.accessToken })
        .expect(200);
      expect(ids(res.body)).toEqual([near.id]);
      expect(res.body.items[0].distanceKm).toBeGreaterThan(1.5);
      expect(res.body.items[0].distanceKm).toBeLessThan(3);
    });

    it('never shows a worker their own request', async () => {
      const dual = await customerIn(t);
      await http
        .put(
          `${V1}/workers/me`,
          {
            fullName: 'Dual',
            trades: ['plumber'],
            experienceYears: 3,
            languages: ['hi'],
            baseAreaId: dual.areaId,
            radiusKm: 6,
            termsAccepted: true,
          },
          { token: dual.accessToken },
        )
        .expect(200);
      await t.prisma.workerProfile.update({
        where: { userId: dual.userId },
        data: { verificationStatus: 'VERIFIED' },
      });
      await postJob(t, dual);
      expect(
        ids(
          (await http.get(LEADS, { token: dual.accessToken }).expect(200)).body,
        ),
      ).toEqual([]);
    });

    it('requires a verified worker', async () => {
      const unverified = await verifiedWorkerIn(t, { verified: false });
      const customer = await customerIn(t);
      expect(
        (await http.get(LEADS, { token: unverified.accessToken }).expect(403))
          .body.code,
      ).toBe('NOT_VERIFIED');
      expect(
        (await http.get(LEADS, { token: customer.accessToken }).expect(403))
          .body.code,
      ).toBe('WORKER_PROFILE_REQUIRED');
      await http.get(LEADS).expect(401);
    });

    it('rejects bad query values', async () => {
      const worker = await verifiedWorkerIn(t);
      for (const q of [
        '?filter=urgent',
        '?limit=0',
        '?limit=51',
        '?cursor=junk',
        '?sort=newest',
      ]) {
        await http
          .get(`${LEADS}${q}`, { token: worker.accessToken })
          .expect(422);
      }
    });
  });

  describe('GET /leads/:id', () => {
    it('returns the full lead with photo and voice links, still without address or phone', async () => {
      const worker = await verifiedWorkerIn(t);
      const customer = await customerIn(t);
      const photo = await uploadFile(t, customer.accessToken, 'JOB_PHOTO');
      const voice = await uploadFile(t, customer.accessToken, 'JOB_VOICE');
      const job = await postJob(t, customer, {
        photoKeys: [photo.key],
        voiceNote: { key: voice.key, durationSec: 9 },
      });

      const res = await http
        .get(`${LEADS}/${job.id}`, { token: worker.accessToken })
        .expect(200);
      expect(res.body).toMatchObject({
        id: job.id,
        status: 'OPEN',
        hasVoiceNote: true,
        voiceNote: { durationSec: 9 },
      });
      expect(res.body.photoUrls).toHaveLength(1);
      expect(res.body.voiceNote.url).toContain('/dev-storage/media/');
      const text = JSON.stringify(res.body);
      for (const secret of ['addressLine', 'House #1402', customer.phone])
        expect(text).not.toContain(secret);
    });

    it('is a plain 404 when it is not a lead for this worker (other trade, other city, unknown, own job)', async () => {
      const worker = await verifiedWorkerIn(t, { trades: ['plumber'] });
      const customer = await customerIn(t);
      const elsewhere = await customerIn(t, 'Phase 7', 'Mohali (SAS Nagar)');
      const wrongTrade = await postJob(t, customer, {
        categoryId: 'electrician',
      });
      const otherCity = await postJob(t, elsewhere);

      for (const id of [
        wrongTrade.id,
        otherCity.id,
        '018f0000-0000-7000-8000-000000000000',
      ]) {
        await http
          .get(`${LEADS}/${id}`, { token: worker.accessToken })
          .expect(404);
      }
      await http
        .get(`${LEADS}/not-a-uuid`, { token: worker.accessToken })
        .expect(400);
    });

    it('stays readable for a worker who quoted, after the job went to someone else', async () => {
      const loser = await verifiedWorkerIn(t);
      const winner = await verifiedWorkerIn(t);
      const customer = await customerIn(t);
      const job = await postJob(t, customer);
      await sendQuote(t, loser, job.id);
      const won = await sendQuote(t, winner, job.id);
      await accept(customer, job.id, won.id).expect(200);

      const res = await http
        .get(`${LEADS}/${job.id}`, { token: loser.accessToken })
        .expect(200);
      expect(res.body).toMatchObject({
        status: 'ASSIGNED',
        myOffer: { status: 'REJECTED' },
      });
      expect(JSON.stringify(res.body)).not.toContain('House #1402');
    });

    it('is a 404 for a worker who never quoted once the job is closed', async () => {
      const bystander = await verifiedWorkerIn(t);
      const winner = await verifiedWorkerIn(t);
      const customer = await customerIn(t);
      const job = await postJob(t, customer);
      const won = await sendQuote(t, winner, job.id);
      await accept(customer, job.id, won.id).expect(200);
      await http
        .get(`${LEADS}/${job.id}`, { token: bystander.accessToken })
        .expect(404);
    });
  });

  describe('POST /leads/:id/offers (send a quote)', () => {
    it('creates a PENDING quote that the customer can see', async () => {
      const worker = await verifiedWorkerIn(t, { fullName: 'Rajesh Kumar' });
      const customer = await customerIn(t);
      const job = await postJob(t, customer);

      const res = await http
        .post(
          `${LEADS}/${job.id}/offers`,
          {
            visitFee: 250,
            etaMinutes: 15,
            message: '  I have PVC pipes in stock  ',
          },
          { token: worker.accessToken },
        )
        .expect(201);
      expect(res.body).toMatchObject({
        visitFee: 250,
        etaMinutes: 15,
        message: 'I have PVC pipes in stock',
        status: 'PENDING',
      });

      const list = await http
        .get(`${JOBS}/${job.id}/offers`, { token: customer.accessToken })
        .expect(200);
      expect(list.body).toHaveLength(1);
      expect(list.body[0]).toMatchObject({
        offerId: res.body.id,
        visitFee: 250,
        etaMinutes: 15,
        worker: { id: worker.userId, name: 'Rajesh Kumar' },
      });
    });

    it.each([
      ['a zero fee', { visitFee: 0, etaMinutes: 15 }, 'visitFee'],
      ['a negative fee', { visitFee: -5, etaMinutes: 15 }, 'visitFee'],
      ['a fee over 100000', { visitFee: 100001, etaMinutes: 15 }, 'visitFee'],
      ['a fractional fee', { visitFee: 250.5, etaMinutes: 15 }, 'visitFee'],
      ['a fee as text', { visitFee: '250', etaMinutes: 15 }, 'visitFee'],
      [
        'an arrival time the screen does not offer',
        { visitFee: 250, etaMinutes: 20 },
        'etaMinutes',
      ],
      ['a missing arrival time', { visitFee: 250 }, 'etaMinutes'],
      [
        'a 301-character message',
        { visitFee: 250, etaMinutes: 15, message: 'x'.repeat(301) },
        'message',
      ],
      [
        'fields the worker must not set',
        { visitFee: 250, etaMinutes: 15, status: 'ACCEPTED', workerId: 'x' },
        'status',
      ],
    ])('rejects %s with a 422', async (_label, body, field) => {
      const worker = await verifiedWorkerIn(t);
      const job = await postJob(t, await customerIn(t));
      const res = await http
        .post(`${LEADS}/${job.id}/offers`, body, { token: worker.accessToken })
        .expect(422);
      expect(res.body.details.map((d: { field: string }) => d.field)).toContain(
        field,
      );
      expect(await t.prisma.offer.count()).toBe(0);
    });

    it('is a 404 for a job that is not a lead for this worker', async () => {
      const worker = await verifiedWorkerIn(t, { trades: ['plumber'] });
      const customer = await customerIn(t);
      const wrongTrade = await postJob(t, customer, {
        categoryId: 'electrician',
      });
      const elsewhere = await postJob(
        t,
        await customerIn(t, 'Phase 7', 'Mohali (SAS Nagar)'),
      );
      for (const id of [
        wrongTrade.id,
        elsewhere.id,
        '018f0000-0000-7000-8000-000000000000',
      ]) {
        await http
          .post(
            `${LEADS}/${id}/offers`,
            { visitFee: 250, etaMinutes: 15 },
            { token: worker.accessToken },
          )
          .expect(404);
      }
      expect(await t.prisma.offer.count()).toBe(0);
    });

    it('refuses a quote on your own request', async () => {
      const dual = await customerIn(t);
      await http
        .put(
          `${V1}/workers/me`,
          {
            fullName: 'Dual',
            trades: ['plumber'],
            experienceYears: 3,
            languages: ['hi'],
            baseAreaId: dual.areaId,
            radiusKm: 6,
            termsAccepted: true,
          },
          { token: dual.accessToken },
        )
        .expect(200);
      await t.prisma.workerProfile.update({
        where: { userId: dual.userId },
        data: { verificationStatus: 'VERIFIED' },
      });
      const job = await postJob(t, dual);
      const res = await http
        .post(
          `${LEADS}/${job.id}/offers`,
          { visitFee: 250, etaMinutes: 15 },
          { token: dual.accessToken },
        )
        .expect(403);
      expect(res.body.code).toBe('OWN_JOB');
    });

    it('allows one quote per worker per job', async () => {
      const worker = await verifiedWorkerIn(t);
      const job = await postJob(t, await customerIn(t));
      await sendQuote(t, worker, job.id);
      const res = await http
        .post(
          `${LEADS}/${job.id}/offers`,
          { visitFee: 100, etaMinutes: 30 },
          { token: worker.accessToken },
        )
        .expect(409);
      expect(res.body.code).toBe('OFFER_EXISTS');
      expect(await t.prisma.offer.count()).toBe(1);
    });

    it('lets only one of two simultaneous quotes from the same worker through', async () => {
      const worker = await verifiedWorkerIn(t);
      const job = await postJob(t, await customerIn(t));
      const results = await Promise.all([
        http.post(
          `${LEADS}/${job.id}/offers`,
          { visitFee: 250, etaMinutes: 15 },
          { token: worker.accessToken },
        ),
        http.post(
          `${LEADS}/${job.id}/offers`,
          { visitFee: 260, etaMinutes: 15 },
          { token: worker.accessToken },
        ),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
      expect(await t.prisma.offer.count()).toBe(1);
    });

    it('refuses quotes on closed jobs (cancelled, expired, already assigned)', async () => {
      const worker = await verifiedWorkerIn(t);
      const other = await verifiedWorkerIn(t);
      const customer = await customerIn(t);

      const cancelled = await postJob(t, customer);
      await http
        .post(
          `${JOBS}/${cancelled.id}/cancel`,
          {},
          { token: customer.accessToken },
        )
        .expect(200);
      const expired = await postJob(t, customer);
      await t.prisma.job.update({
        where: { id: expired.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      const taken = await postJob(t, customer);
      const won = await sendQuote(t, other, taken.id);
      await accept(customer, taken.id, won.id).expect(200);

      for (const id of [cancelled.id, expired.id, taken.id]) {
        const res = await http
          .post(
            `${LEADS}/${id}/offers`,
            { visitFee: 250, etaMinutes: 15 },
            { token: worker.accessToken },
          )
          .expect(409);
        expect(res.body.code).toBe('JOB_NOT_OPEN');
      }
    });

    it('needs a verified worker', async () => {
      const unverified = await verifiedWorkerIn(t, { verified: false });
      const job = await postJob(t, await customerIn(t));
      await http
        .post(
          `${LEADS}/${job.id}/offers`,
          { visitFee: 250, etaMinutes: 15 },
          { token: unverified.accessToken },
        )
        .expect(403);
    });
  });

  describe('PATCH / DELETE /offers/:id (revise or withdraw)', () => {
    it('revises fee, arrival and message while the quote is waiting', async () => {
      const worker = await verifiedWorkerIn(t);
      const job = await postJob(t, await customerIn(t));
      const quote = await sendQuote(t, worker, job.id);

      const res = await http
        .patch(
          `${OFFERS}/${quote.id}`,
          { visitFee: 199, etaMinutes: 45, message: 'Updated' },
          { token: worker.accessToken },
        )
        .expect(200);
      expect(res.body).toMatchObject({
        id: quote.id,
        visitFee: 199,
        etaMinutes: 45,
        message: 'Updated',
        status: 'PENDING',
      });

      const partial = await http
        .patch(
          `${OFFERS}/${quote.id}`,
          { visitFee: 180 },
          { token: worker.accessToken },
        )
        .expect(200);
      expect(partial.body).toMatchObject({
        visitFee: 180,
        etaMinutes: 45,
        message: 'Updated',
      });
    });

    it('validates a revision and refuses to touch other fields', async () => {
      const worker = await verifiedWorkerIn(t);
      const quote = await sendQuote(
        t,
        worker,
        (await postJob(t, await customerIn(t))).id,
      );
      await http
        .patch(
          `${OFFERS}/${quote.id}`,
          { visitFee: 0 },
          { token: worker.accessToken },
        )
        .expect(422);
      await http
        .patch(
          `${OFFERS}/${quote.id}`,
          { etaMinutes: 10 },
          { token: worker.accessToken },
        )
        .expect(422);
      await http
        .patch(
          `${OFFERS}/${quote.id}`,
          { status: 'ACCEPTED' },
          { token: worker.accessToken },
        )
        .expect(422);
    });

    it("withdraws a quote: it disappears from the customer's list, and the worker may quote again", async () => {
      const worker = await verifiedWorkerIn(t);
      const customer = await customerIn(t);
      const job = await postJob(t, customer);
      const quote = await sendQuote(t, worker, job.id, { visitFee: 300 });

      await http
        .delete(`${OFFERS}/${quote.id}`, { token: worker.accessToken })
        .expect(204);
      expect(
        (
          await http
            .get(`${JOBS}/${job.id}/offers`, { token: customer.accessToken })
            .expect(200)
        ).body,
      ).toEqual([]);

      const again = await http
        .post(
          `${LEADS}/${job.id}/offers`,
          { visitFee: 220, etaMinutes: 30 },
          { token: worker.accessToken },
        )
        .expect(201);
      expect(again.body).toMatchObject({
        id: quote.id,
        visitFee: 220,
        etaMinutes: 30,
        status: 'PENDING',
      }); // the same row, revived
      expect(await t.prisma.offer.count()).toBe(1);
    });

    it('cannot revise or withdraw a quote that is no longer waiting', async () => {
      const worker = await verifiedWorkerIn(t);
      const winner = await verifiedWorkerIn(t);
      const customer = await customerIn(t);
      const job = await postJob(t, customer);
      const lost = await sendQuote(t, worker, job.id);
      const won = await sendQuote(t, winner, job.id);
      await accept(customer, job.id, won.id).expect(200);

      for (const call of [
        http.patch(
          `${OFFERS}/${lost.id}`,
          { visitFee: 100 },
          { token: worker.accessToken },
        ),
        http.delete(`${OFFERS}/${lost.id}`, { token: worker.accessToken }),
        http.patch(
          `${OFFERS}/${won.id}`,
          { visitFee: 100 },
          { token: winner.accessToken },
        ),
        http.delete(`${OFFERS}/${won.id}`, { token: winner.accessToken }),
      ]) {
        expect((await call.expect(409)).body.code).toBe('OFFER_NOT_PENDING');
      }
    });

    it('only the owner can touch a quote; others get a 404', async () => {
      const owner = await verifiedWorkerIn(t);
      const rival = await verifiedWorkerIn(t);
      const customer = await customerIn(t);
      const quote = await sendQuote(t, owner, (await postJob(t, customer)).id);
      await http
        .patch(
          `${OFFERS}/${quote.id}`,
          { visitFee: 1 },
          { token: rival.accessToken },
        )
        .expect(404);
      await http
        .delete(`${OFFERS}/${quote.id}`, { token: rival.accessToken })
        .expect(404);
      await http
        .delete(`${OFFERS}/${quote.id}`, { token: customer.accessToken })
        .expect(403);
      await http
        .delete(`${OFFERS}/018f0000-0000-7000-8000-000000000000`, {
          token: owner.accessToken,
        })
        .expect(404);
      expect(
        (await t.prisma.offer.findUniqueOrThrow({ where: { id: quote.id } }))
          .visitFee,
      ).toBe(250);
    });
  });

  describe('GET /jobs/:id/offers (Compare Offers)', () => {
    it('lists live quotes with a full worker card, cheapest first, flagging the fastest', async () => {
      const customer = await customerIn(t);
      const cheap = await verifiedWorkerIn(t, { fullName: 'Cheap' });
      const quick = await verifiedWorkerIn(t, { fullName: 'Quick' });
      const mid = await verifiedWorkerIn(t, { fullName: 'Mid' });
      const job = await postJob(t, customer);
      await sendQuote(t, cheap, job.id, { visitFee: 150, etaMinutes: 45 });
      await sendQuote(t, quick, job.id, { visitFee: 300, etaMinutes: 15 });
      await sendQuote(t, mid, job.id, { visitFee: 200, etaMinutes: 30 });

      const byFee = await http
        .get(`${JOBS}/${job.id}/offers`, { token: customer.accessToken })
        .expect(200);
      expect(
        byFee.body.map((o: { worker: { name: string } }) => o.worker.name),
      ).toEqual(['Cheap', 'Mid', 'Quick']);
      expect(
        byFee.body.map((o: { isFastest: boolean }) => o.isFastest),
      ).toEqual([false, false, true]);
      expect(byFee.body[2].worker).toMatchObject({
        id: quick.userId,
        phone: quick.phone,
        trade: 'Plumber',
        experienceYears: 8,
      });

      const byEta = await http
        .get(`${JOBS}/${job.id}/offers?sort=eta`, {
          token: customer.accessToken,
        })
        .expect(200);
      expect(
        byEta.body.map((o: { worker: { name: string } }) => o.worker.name),
      ).toEqual(['Quick', 'Mid', 'Cheap']);
    });

    it('flags every quote tied for the earliest arrival', async () => {
      const customer = await customerIn(t);
      const a = await verifiedWorkerIn(t);
      const b = await verifiedWorkerIn(t);
      const c = await verifiedWorkerIn(t);
      const job = await postJob(t, customer);
      await sendQuote(t, a, job.id, { etaMinutes: 15 });
      await sendQuote(t, b, job.id, { etaMinutes: 15 });
      await sendQuote(t, c, job.id, { etaMinutes: 30 });
      const res = await http
        .get(`${JOBS}/${job.id}/offers`, { token: customer.accessToken })
        .expect(200);
      expect(
        res.body.filter((o: { isFastest: boolean }) => o.isFastest),
      ).toHaveLength(2);
    });

    it('is empty for a job with no quotes, and only the owner can look', async () => {
      const customer = await customerIn(t);
      const stranger = await customerIn(t);
      const worker = await verifiedWorkerIn(t);
      const job = await postJob(t, customer);
      expect(
        (
          await http
            .get(`${JOBS}/${job.id}/offers`, { token: customer.accessToken })
            .expect(200)
        ).body,
      ).toEqual([]);
      await http
        .get(`${JOBS}/${job.id}/offers`, { token: stranger.accessToken })
        .expect(404);
      await http
        .get(`${JOBS}/${job.id}/offers`, { token: worker.accessToken })
        .expect(403);
      await http
        .get(`${JOBS}/${job.id}/offers?sort=best`, {
          token: customer.accessToken,
        })
        .expect(422);
    });

    it('after assignment shows only the chosen quote', async () => {
      const customer = await customerIn(t);
      const a = await verifiedWorkerIn(t);
      const b = await verifiedWorkerIn(t);
      const job = await postJob(t, customer);
      const qa = await sendQuote(t, a, job.id);
      await sendQuote(t, b, job.id);
      await accept(customer, job.id, qa.id).expect(200);
      const res = await http
        .get(`${JOBS}/${job.id}/offers`, { token: customer.accessToken })
        .expect(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0]).toMatchObject({ offerId: qa.id, status: 'ACCEPTED' });
    });
  });

  describe('POST /jobs/:id/offers/:offerId/accept', () => {
    it('assigns the worker: job, quotes, arrival code and the visit-fee line on the bill all agree', async () => {
      const customer = await customerIn(t);
      const winner = await verifiedWorkerIn(t, { fullName: 'Winner' });
      const loser = await verifiedWorkerIn(t);
      const job = await postJob(t, customer);
      const won = await sendQuote(t, winner, job.id, {
        visitFee: 275,
        etaMinutes: 30,
      });
      const lost = await sendQuote(t, loser, job.id, { visitFee: 190 });

      const res = await accept(customer, job.id, won.id).expect(200);
      expect(res.body).toMatchObject({
        status: 'ASSIGNED',
        worker: { id: winner.userId, name: 'Winner' },
      });
      expect(res.body.arrivalCode).toMatch(/^\d{4}$/);

      const row = await t.prisma.job.findUniqueOrThrow({
        where: { id: job.id },
        include: { billItems: true },
      });
      expect(row).toMatchObject({
        status: 'ASSIGNED',
        workerId: winner.userId,
        acceptedOfferId: won.id,
        arrivalCode: res.body.arrivalCode,
      });
      expect(row.assignedAt).not.toBeNull();
      expect(row.billItems).toHaveLength(1);
      expect(row.billItems[0]).toMatchObject({
        kind: 'VISIT_FEE',
        amount: 275,
      });

      const offers = await t.prisma.offer.findMany({
        where: { jobId: job.id },
        orderBy: { createdAt: 'asc' },
      });
      expect(offers.map((o) => [o.id, o.status])).toEqual([
        [won.id, 'ACCEPTED'],
        [lost.id, 'REJECTED'],
      ]);
    });

    it('a second accept, or accepting another quote afterwards, is refused', async () => {
      const customer = await customerIn(t);
      const a = await verifiedWorkerIn(t);
      const b = await verifiedWorkerIn(t);
      const job = await postJob(t, customer);
      const qa = await sendQuote(t, a, job.id);
      const qb = await sendQuote(t, b, job.id);
      await accept(customer, job.id, qa.id).expect(200);

      for (const id of [qa.id, qb.id]) {
        expect((await accept(customer, job.id, id).expect(409)).body.code).toBe(
          'JOB_NOT_OPEN',
        );
      }
      expect(
        (await t.prisma.job.findUniqueOrThrow({ where: { id: job.id } }))
          .workerId,
      ).toBe(a.userId);
    });

    it('refuses a quote that was withdrawn, leaving the job open', async () => {
      const customer = await customerIn(t);
      const worker = await verifiedWorkerIn(t);
      const job = await postJob(t, customer);
      const quote = await sendQuote(t, worker, job.id);
      await http
        .delete(`${OFFERS}/${quote.id}`, { token: worker.accessToken })
        .expect(204);

      expect(
        (await accept(customer, job.id, quote.id).expect(409)).body.code,
      ).toBe('OFFER_NOT_PENDING');
      const row = await t.prisma.job.findUniqueOrThrow({
        where: { id: job.id },
      });
      expect([row.status, row.workerId]).toEqual(['OPEN', null]);
    });

    it('refuses a job that expired (even before the sweeper ran) or was cancelled, changing nothing', async () => {
      const customer = await customerIn(t);
      const worker = await verifiedWorkerIn(t);
      const expired = await postJob(t, customer);
      const eq = await sendQuote(t, worker, expired.id);
      await t.prisma.job.update({
        where: { id: expired.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      expect(
        (await accept(customer, expired.id, eq.id).expect(409)).body.code,
      ).toBe('JOB_NOT_OPEN');
      expect(
        (await t.prisma.job.findUniqueOrThrow({ where: { id: expired.id } }))
          .status,
      ).toBe('OPEN');
      expect(
        (await t.prisma.offer.findUniqueOrThrow({ where: { id: eq.id } }))
          .status,
      ).toBe('PENDING');

      const cancelled = await postJob(t, customer);
      const cq = await sendQuote(t, worker, cancelled.id);
      await http
        .post(
          `${JOBS}/${cancelled.id}/cancel`,
          {},
          { token: customer.accessToken },
        )
        .expect(200);
      expect(
        (await accept(customer, cancelled.id, cq.id).expect(409)).body.code,
      ).toBe('JOB_NOT_OPEN');
    });

    it("is a 404 for a quote of another job, another customer's job, or an unknown id; 403 for a worker", async () => {
      const customer = await customerIn(t);
      const stranger = await customerIn(t);
      const worker = await verifiedWorkerIn(t);
      const job = await postJob(t, customer);
      const other = await postJob(t, customer);
      const quote = await sendQuote(t, worker, job.id);
      const otherQuote = await sendQuote(t, worker, other.id);

      await accept(customer, job.id, otherQuote.id).expect(404);
      await accept(stranger, job.id, quote.id).expect(404);
      await accept(
        customer,
        job.id,
        '018f0000-0000-7000-8000-000000000000',
      ).expect(404);
      await accept(
        customer,
        '018f0000-0000-7000-8000-000000000000',
        quote.id,
      ).expect(404);
      await accept(worker, job.id, quote.id).expect(403);
      await accept(customer, 'bad', quote.id).expect(400);
      expect(
        (await t.prisma.job.findUniqueOrThrow({ where: { id: job.id } }))
          .status,
      ).toBe('OPEN');
    });
  });

  describe('races (the database must never end up inconsistent)', () => {
    const assertConsistent = async (jobId: string) => {
      const job = await t.prisma.job.findUniqueOrThrow({
        where: { id: jobId },
        include: { offers: true },
      });
      const accepted = job.offers.filter((o) => o.status === 'ACCEPTED');
      if (job.status === 'ASSIGNED') {
        expect(accepted).toHaveLength(1);
        expect(job.workerId).toBe(accepted[0]!.workerId);
        expect(job.acceptedOfferId).toBe(accepted[0]!.id);
        expect(job.offers.filter((o) => o.status === 'PENDING')).toHaveLength(
          0,
        );
        expect(await t.prisma.billItem.count({ where: { jobId } })).toBe(1);
      } else {
        expect(accepted).toHaveLength(0);
        expect(job.workerId).toBeNull();
      }
      return job;
    };

    it('two simultaneous accepts of different quotes: exactly one wins', async () => {
      const customer = await customerIn(t);
      const a = await verifiedWorkerIn(t);
      const b = await verifiedWorkerIn(t);
      const job = await postJob(t, customer);
      const qa = await sendQuote(t, a, job.id);
      const qb = await sendQuote(t, b, job.id);

      const results = await Promise.all([
        accept(customer, job.id, qa.id),
        accept(customer, job.id, qb.id),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      expect((await assertConsistent(job.id)).status).toBe('ASSIGNED');
    });

    it('five simultaneous accepts of the same quote: exactly one wins', async () => {
      const customer = await customerIn(t);
      const worker = await verifiedWorkerIn(t);
      const job = await postJob(t, customer);
      const quote = await sendQuote(t, worker, job.id);

      const results = await Promise.all(
        Array.from({ length: 5 }, () => accept(customer, job.id, quote.id)),
      );
      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      expect(results.filter((r) => r.status === 409)).toHaveLength(4);
      await assertConsistent(job.id);
      expect(await t.prisma.billItem.count()).toBe(1);
    });

    it('quotes arriving while the customer accepts never leave a waiting quote on an assigned job', async () => {
      const customer = await customerIn(t);
      const first = await verifiedWorkerIn(t);
      const late = await Promise.all(
        Array.from({ length: 6 }, () => verifiedWorkerIn(t)),
      );
      const job = await postJob(t, customer);
      const firstQuote = await sendQuote(t, first, job.id);

      const results = await Promise.all([
        accept(customer, job.id, firstQuote.id),
        ...late.map((w) =>
          http.post(
            `${LEADS}/${job.id}/offers`,
            { visitFee: 200, etaMinutes: 15 },
            { token: w.accessToken },
          ),
        ),
      ]);

      expect(results[0]!.status).toBe(200);
      for (const r of results.slice(1)) {
        expect([201, 409]).toContain(r.status);
        if (r.status === 409) expect(r.body.code).toBe('JOB_NOT_OPEN');
      }
      await assertConsistent(job.id);
      // Any quote that got in before the accept was rejected, not left waiting.
      const quotes = await t.prisma.offer.findMany({
        where: { jobId: job.id, id: { not: firstQuote.id } },
      });
      for (const q of quotes) expect(q.status).toBe('REJECTED');
    });

    it('accept racing a cancel: the job always ends CANCELLED, and the records agree with whichever came first', async () => {
      for (let round = 0; round < 4; round += 1) {
        const customer = await customerIn(t);
        const worker = await verifiedWorkerIn(t);
        const job = await postJob(t, customer);
        const quote = await sendQuote(t, worker, job.id);

        const [acceptRes, cancelRes] = await Promise.all([
          accept(customer, job.id, quote.id),
          http.post(
            `${JOBS}/${job.id}/cancel`,
            {},
            { token: customer.accessToken },
          ),
        ]);

        // A cancel is allowed from OPEN and from ASSIGNED, so it can never lose this race.
        expect(cancelRes.status).toBe(200);
        const final = await t.prisma.job.findUniqueOrThrow({
          where: { id: job.id },
          include: { offers: true },
        });
        expect(final.status).toBe('CANCELLED');
        expect(final.offers.filter((o) => o.status === 'PENDING')).toHaveLength(
          0,
        );

        if (acceptRes.status === 200) {
          // Accepted first, cancelled afterwards: the assignment is kept on record.
          expect(final.workerId).toBe(worker.userId);
          expect(final.offers.map((o) => o.status)).toEqual(['ACCEPTED']);
        } else {
          // Cancelled first: the accept must have changed nothing.
          expect(acceptRes.status).toBe(409);
          expect(final.workerId).toBeNull();
          expect(final.offers.map((o) => o.status)).toEqual(['REJECTED']);
        }
      }
    });
  });
});
