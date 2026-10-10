import type request from 'supertest';
import { seedReferenceData } from '../prisma/seed/reference-data.js';
import { api, createTestApp, type TestApp } from './helpers/app.js';
import { resetDatabase } from './helpers/db.js';
import {
  customerIn,
  giveCoordinates,
  verifiedWorkerIn,
} from './helpers/marketplace.js';
import { workerPayload } from './helpers/personas.js';

const V1 = '/api/v1';
const WORKERS = `${V1}/workers`;

describe('worker discovery: "Verified Artisans Near You" (e2e, real PostgreSQL)', () => {
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

  const names = (body: { items: { name: string }[] }) =>
    body.items.map((i) => i.name);

  describe('GET /workers', () => {
    it('lists only verified workers, with everything the Home card needs', async () => {
      const customer = await customerIn(t);
      const worker = await verifiedWorkerIn(t, {
        fullName: 'Rajesh Kumar',
        trades: ['electrician', 'appliance'],
        visitingFee: 200,
      });
      await t.prisma.workerProfile.update({
        where: { userId: worker.userId },
        data: {
          badge: 'Aadhaar & Police Verified',
          ratingSum: 49,
          reviewCount: 10,
          vehicle: 'Hero Splendor (CH 01 BG 4590)',
        },
      });
      await verifiedWorkerIn(t, {
        fullName: 'Not Yet Verified',
        verified: false,
      });

      const res = await http
        .get(WORKERS, { token: customer.accessToken })
        .expect(200);

      expect(names(res.body)).toEqual(['Rajesh Kumar']);
      expect(res.body.items[0]).toEqual({
        id: worker.userId,
        name: 'Rajesh Kumar',
        trade: 'Electrician',
        tradeId: 'electrician',
        areaName: 'Sector 22',
        cityName: 'Chandigarh',
        distanceKm: null, // area centroids are not filled in this test
        rating: 4.9,
        reviewsCount: 10,
        visitingFee: 200,
        etaMinutes: null,
        badge: 'Aadhaar & Police Verified',
        experienceYears: 8,
        vehicle: 'Hero Splendor (CH 01 BG 4590)',
        skills: ['Wiring', 'MCB Box Repair', 'Fan Repair'],
        photoUrl: null,
        phone: worker.phone,
      });
      expect(res.body.nextCursor).toBeNull();
    });

    it('uses the category base fee when the worker has not set their own', async () => {
      const customer = await customerIn(t);
      await verifiedWorkerIn(t, { trades: ['ac_repair'] });
      const res = await http
        .get(WORKERS, { token: customer.accessToken })
        .expect(200);
      expect(res.body.items[0].visitingFee).toBe(299);
    });

    it('filters by trade and shows the trade that was asked for', async () => {
      const customer = await customerIn(t);
      await verifiedWorkerIn(t, { fullName: 'Plumber', trades: ['plumber'] });
      await verifiedWorkerIn(t, {
        fullName: 'Both',
        trades: ['electrician', 'plumber'],
      });
      await verifiedWorkerIn(t, {
        fullName: 'Sparky',
        trades: ['electrician'],
      });

      const res = await http
        .get(`${WORKERS}?categoryId=plumber`, { token: customer.accessToken })
        .expect(200);
      expect(names(res.body).sort()).toEqual(['Both', 'Plumber']);
      const both = res.body.items.find(
        (i: { name: string }) => i.name === 'Both',
      );
      expect(both).toMatchObject({ trade: 'Plumber', tradeId: 'plumber' }); // not its primary (electrician)
    });

    it('without coordinates, shows workers in the same city only', async () => {
      const customer = await customerIn(t, 'Sector 22');
      await verifiedWorkerIn(t, { fullName: 'Same city', area: 'Sector 35' });
      await verifiedWorkerIn(t, {
        fullName: 'Other city',
        area: 'Phase 7',
        city: 'Mohali (SAS Nagar)',
      });
      const res = await http
        .get(WORKERS, { token: customer.accessToken })
        .expect(200);
      expect(names(res.body)).toEqual(['Same city']);
    });

    it("with coordinates, applies each worker's radius and reports distance and ETA", async () => {
      await giveCoordinates(t, 'Sector 22');
      await giveCoordinates(t, 'Sector 35');
      await giveCoordinates(t, 'Phase 7', 'Mohali (SAS Nagar)');
      const customer = await customerIn(t, 'Sector 22');
      await verifiedWorkerIn(t, {
        fullName: 'Near',
        area: 'Sector 35',
        radiusKm: 3,
      });
      await verifiedWorkerIn(t, {
        fullName: 'Far but wide',
        area: 'Phase 7',
        city: 'Mohali (SAS Nagar)',
        radiusKm: 12,
      });
      await verifiedWorkerIn(t, {
        fullName: 'Far and narrow',
        area: 'Phase 7',
        city: 'Mohali (SAS Nagar)',
        radiusKm: 3,
      });

      const res = await http
        .get(WORKERS, { token: customer.accessToken })
        .expect(200);
      expect(names(res.body)).toEqual(['Near', 'Far but wide']); // nearest first
      const [near, far] = res.body.items;
      expect(near.distanceKm).toBeGreaterThan(1.5);
      expect(near.distanceKm).toBeLessThan(3);
      expect(near.etaMinutes).toBeGreaterThanOrEqual(1);
      expect(far.distanceKm).toBeGreaterThan(5);
      expect(far.etaMinutes).toBeGreaterThan(near.etaMinutes);
    });

    it("can look at another area instead of the customer's own", async () => {
      const customer = await customerIn(t, 'Sector 22');
      await verifiedWorkerIn(t, {
        fullName: 'In Mohali',
        area: 'Phase 7',
        city: 'Mohali (SAS Nagar)',
      });
      const mohali = await t.prisma.area.findFirstOrThrow({
        where: { name: 'Phase 7' },
      });

      expect(
        names(
          (await http.get(WORKERS, { token: customer.accessToken }).expect(200))
            .body,
        ),
      ).toEqual([]);
      const there = await http
        .get(`${WORKERS}?areaId=${mohali.id}`, { token: customer.accessToken })
        .expect(200);
      expect(names(there.body)).toEqual(['In Mohali']);
    });

    it('sorts by rating on request, best first, unrated last', async () => {
      const customer = await customerIn(t);
      const low = await verifiedWorkerIn(t, { fullName: 'Low' });
      const high = await verifiedWorkerIn(t, { fullName: 'High' });
      await verifiedWorkerIn(t, { fullName: 'Unrated' });
      await t.prisma.workerProfile.update({
        where: { userId: low.userId },
        data: { ratingSum: 30, reviewCount: 10 },
      }); // 3.0
      await t.prisma.workerProfile.update({
        where: { userId: high.userId },
        data: { ratingSum: 49, reviewCount: 10 },
      }); // 4.9

      const res = await http
        .get(`${WORKERS}?sort=rating`, { token: customer.accessToken })
        .expect(200);
      expect(names(res.body)).toEqual(['High', 'Low', 'Unrated']);
      expect(
        res.body.items.map((i: { rating: number | null }) => i.rating),
      ).toEqual([4.9, 3, null]);
    });

    it('pages through everyone once, in a stable order', async () => {
      const customer = await customerIn(t);
      for (let i = 0; i < 5; i += 1)
        await verifiedWorkerIn(t, { fullName: `Worker ${i}` });

      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const res: request.Response = await http
          .get(`${WORKERS}?limit=2${cursor ? `&cursor=${cursor}` : ''}`, {
            token: customer.accessToken,
          })
          .expect(200);
        seen.push(...res.body.items.map((i: { id: string }) => i.id));
        cursor = res.body.nextCursor;
        pages += 1;
      } while (cursor && pages < 10);

      expect(pages).toBe(3);
      expect(new Set(seen).size).toBe(5);
    });

    it('never lists the customer themself, even if they are also a verified worker', async () => {
      const dual = await customerIn(t);
      await http
        .put(
          `${V1}/workers/me`,
          workerPayload(dual.areaId, { fullName: 'Me as worker' }),
          { token: dual.accessToken },
        )
        .expect(200);
      await t.prisma.workerProfile.update({
        where: { userId: dual.userId },
        data: { verificationStatus: 'VERIFIED' },
      });
      await verifiedWorkerIn(t, { fullName: 'Someone else' });

      const res = await http
        .get(WORKERS, { token: dual.accessToken })
        .expect(200);
      expect(names(res.body)).toEqual(['Someone else']);
    });

    it('is empty (not an error) when nobody matches', async () => {
      const customer = await customerIn(t);
      const res = await http
        .get(WORKERS, { token: customer.accessToken })
        .expect(200);
      expect(res.body).toEqual({ items: [], nextCursor: null });
    });

    it.each([
      ['an unknown category', '?categoryId=astrology'],
      ['an unknown area', '?areaId=999999'],
      ['a bad sort', '?sort=popularity'],
      ['limit 0', '?limit=0'],
      ['limit 51', '?limit=51'],
      ['a non-numeric limit', '?limit=abc'],
      ['a bad cursor', '?cursor=junk'],
      ['an unsupported parameter', '?q=plumber'],
    ])('rejects %s with 422', async (_label, query) => {
      const customer = await customerIn(t);
      const res = await http
        .get(`${WORKERS}${query}`, { token: customer.accessToken })
        .expect(422);
      expect(res.body.code).toBe('VALIDATION_FAILED');
    });

    it('needs a customer profile and a login', async () => {
      const workerOnly = await verifiedWorkerIn(t);
      const res = await http
        .get(WORKERS, { token: workerOnly.accessToken })
        .expect(403);
      expect(res.body.code).toBe('CUSTOMER_PROFILE_REQUIRED');
      await http.get(WORKERS).expect(401);
    });

    it('does not expose internals (documents, upload keys, ratings sums, user id of others)', async () => {
      const customer = await customerIn(t);
      await verifiedWorkerIn(t);
      const text = JSON.stringify(
        (await http.get(WORKERS, { token: customer.accessToken }).expect(200))
          .body,
      );
      for (const secret of [
        'storageKey',
        'photoKey',
        'AADHAAR',
        'ratingSum',
        'verificationStatus',
        'upiId',
        'termsAcceptedAt',
      ]) {
        expect(text).not.toContain(secret);
      }
    });
  });

  describe('GET /workers/:id', () => {
    it('returns the card plus languages, radius and trades', async () => {
      const customer = await customerIn(t);
      const worker = await verifiedWorkerIn(t, {
        fullName: 'Amit Sharma',
        trades: ['ac_repair', 'appliance'],
        radiusKm: 12,
      });
      const res = await http
        .get(`${WORKERS}/${worker.userId}`, { token: customer.accessToken })
        .expect(200);

      expect(res.body).toMatchObject({
        id: worker.userId,
        name: 'Amit Sharma',
        trade: 'AC & Cooling',
        languages: ['hi', 'pa'],
        radiusKm: 12,
        trades: [
          { categoryId: 'ac_repair', title: 'AC & Cooling', isPrimary: true },
          { categoryId: 'appliance', title: 'Appliances', isPrimary: false },
        ],
      });
    });

    it('is a 404 for unverified workers, customers and unknown ids, and 400 for a malformed id', async () => {
      const customer = await customerIn(t);
      const pending = await verifiedWorkerIn(t, { verified: false });
      await http
        .get(`${WORKERS}/${pending.userId}`, { token: customer.accessToken })
        .expect(404);
      await http
        .get(`${WORKERS}/${customer.userId}`, { token: customer.accessToken })
        .expect(404);
      await http
        .get(`${WORKERS}/018f0000-0000-7000-8000-000000000000`, {
          token: customer.accessToken,
        })
        .expect(404);
      await http
        .get(`${WORKERS}/not-a-uuid`, { token: customer.accessToken })
        .expect(400);
    });
  });

  describe('route order', () => {
    it("GET /workers/me still reaches the worker's own profile, not the discovery detail route", async () => {
      const worker = await verifiedWorkerIn(t, { fullName: 'Myself' });
      const res = await http
        .get(`${WORKERS}/me`, { token: worker.accessToken })
        .expect(200);
      expect(res.body.fullName).toBe('Myself');
      expect(res.body.verificationStatus).toBe('VERIFIED');
    });
  });
});
