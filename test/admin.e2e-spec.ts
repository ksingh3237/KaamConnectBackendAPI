import request from 'supertest';
import { seedReferenceData } from '../prisma/seed/reference-data.js';
import { api, createTestApp, freshIp, type TestApp } from './helpers/app.js';
import { resetDatabase } from './helpers/db.js';
import {
  anAreaId,
  makeAdmin,
  newUser,
  onboardedWorker,
  workerPayload,
} from './helpers/personas.js';

const V1 = '/api/v1';
const QUEUE = `${V1}/admin/workers`;

describe('admin worker verification (e2e, real PostgreSQL)', () => {
  let t: TestApp;
  let http: ReturnType<typeof api>;
  let admin: Awaited<ReturnType<typeof newUser>>;

  beforeAll(async () => {
    t = await createTestApp({ verificationMode: 'manual' });
    http = api(t.app);
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await resetDatabase(t.prisma);
    await seedReferenceData(t.prisma);
    admin = await newUser(t);
    await makeAdmin(t, admin.userId);
  });

  const adminToken = () => admin.accessToken;

  describe('who may call it', () => {
    it('is invisible to normal users: a plain 404, not a 403', async () => {
      const user = await newUser(t);
      const w = await onboardedWorker(t);
      for (const call of [
        http.get(QUEUE, { token: user.accessToken }),
        http.post(
          `${QUEUE}/${w.userId}/verify`,
          {},
          { token: user.accessToken },
        ),
        http.post(
          `${QUEUE}/${w.userId}/reject`,
          { reason: 'no' },
          { token: user.accessToken },
        ),
      ]) {
        const res = await call.expect(404);
        expect(res.body.code).toBe('NOT_FOUND');
      }
      const row = await t.prisma.workerProfile.findUniqueOrThrow({
        where: { userId: w.userId },
      });
      expect(row.verificationStatus).toBe('PENDING');
    });

    it('a worker cannot verify themselves through the admin API', async () => {
      const w = await onboardedWorker(t);
      await http
        .post(`${QUEUE}/${w.userId}/verify`, {}, { token: w.accessToken })
        .expect(404);
    });

    it('requires login', async () => {
      await http.get(QUEUE).expect(401);
    });

    it('is checked against the database on every call (revoked or disabled admins lose access at once)', async () => {
      await http.get(QUEUE, { token: adminToken() }).expect(200);

      await t.prisma.user.update({
        where: { id: admin.userId },
        data: { isAdmin: false },
      });
      await http.get(QUEUE, { token: adminToken() }).expect(404);

      await t.prisma.user.update({
        where: { id: admin.userId },
        data: { isAdmin: true, isActive: false },
      });
      await http.get(QUEUE, { token: adminToken() }).expect(404);
    });

    it('cannot be granted through any public endpoint', async () => {
      const user = await newUser(t);
      await http
        .patch(`${V1}/me`, { isAdmin: true }, { token: user.accessToken })
        .expect(422);
      expect(
        (await t.prisma.user.findUniqueOrThrow({ where: { id: user.userId } }))
          .isAdmin,
      ).toBe(false);
    });
  });

  describe('GET /admin/workers (review queue)', () => {
    it('lists pending workers with contact details and short-lived Aadhaar links', async () => {
      const w = await onboardedWorker(t);
      const res = await http.get(QUEUE, { token: adminToken() }).expect(200);

      expect(res.body.nextCursor).toBeNull();
      expect(res.body.items).toHaveLength(1);
      const item = res.body.items[0];
      expect(item).toMatchObject({
        userId: w.userId,
        phone: w.phone,
        fullName: 'Rajesh Kumar',
        verificationStatus: 'PENDING',
        trades: [
          { categoryId: 'electrician', isPrimary: true },
          { categoryId: 'appliance', isPrimary: false },
        ],
        baseArea: { name: 'Sector 15', city: 'Chandigarh' },
        experienceYears: 8,
      });
      expect(item.documents.AADHAAR_FRONT).toContain('/dev-storage/private/');
      expect(item.documents.AADHAAR_BACK).toContain('/dev-storage/private/');
    });

    it('the Aadhaar links actually download the uploaded image', async () => {
      await onboardedWorker(t);
      const res = await http.get(QUEUE, { token: adminToken() }).expect(200);
      const url = new URL(res.body.items[0].documents.AADHAAR_FRONT);
      const file = await request(t.app.getHttpServer())
        .get(url.pathname + url.search)
        .set('X-Forwarded-For', freshIp())
        .expect(200);
      expect(file.headers['content-type']).toBe('image/jpeg');
    });

    it('shows null for a side the worker has not uploaded', async () => {
      const me = await newUser(t);
      await http
        .put(`${V1}/workers/me`, workerPayload(await anAreaId(t)), {
          token: me.accessToken,
        })
        .expect(200);
      const res = await http.get(QUEUE, { token: adminToken() }).expect(200);
      expect(res.body.items[0].documents).toEqual({
        AADHAAR_FRONT: null,
        AADHAAR_BACK: null,
      });
    });

    it('filters by status and defaults to PENDING', async () => {
      const pending = await onboardedWorker(t);
      const verified = await onboardedWorker(t);
      const rejected = await onboardedWorker(t);
      await t.prisma.workerProfile.update({
        where: { userId: verified.userId },
        data: { verificationStatus: 'VERIFIED' },
      });
      await t.prisma.workerProfile.update({
        where: { userId: rejected.userId },
        data: { verificationStatus: 'REJECTED' },
      });

      const ids = async (query: string) =>
        (
          await http
            .get(`${QUEUE}${query}`, { token: adminToken() })
            .expect(200)
        ).body.items.map((i: { userId: string }) => i.userId);
      expect(await ids('')).toEqual([pending.userId]);
      expect(await ids('?status=VERIFIED')).toEqual([verified.userId]);
      expect(await ids('?status=REJECTED')).toEqual([rejected.userId]);
    });

    it('pages through the queue oldest first without gaps or repeats', async () => {
      const created: string[] = [];
      for (let i = 0; i < 5; i += 1)
        created.push((await onboardedWorker(t)).userId);

      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const res: request.Response = await http
          .get(`${QUEUE}?limit=2${cursor ? `&cursor=${cursor}` : ''}`, {
            token: adminToken(),
          })
          .expect(200);
        seen.push(...res.body.items.map((i: { userId: string }) => i.userId));
        cursor = res.body.nextCursor;
        pages += 1;
      } while (cursor && pages < 10);

      expect(pages).toBe(3);
      expect(seen).toEqual(created);
    });

    it('rejects bad paging input', async () => {
      await http.get(`${QUEUE}?limit=0`, { token: adminToken() }).expect(422);
      await http.get(`${QUEUE}?limit=51`, { token: adminToken() }).expect(422);
      await http.get(`${QUEUE}?limit=abc`, { token: adminToken() }).expect(422);
      await http
        .get(`${QUEUE}?status=MAYBE`, { token: adminToken() })
        .expect(422);
      const bad = await http
        .get(`${QUEUE}?cursor=not-a-cursor`, { token: adminToken() })
        .expect(422);
      expect(bad.body.details).toEqual([
        { field: 'cursor', issue: 'invalid cursor' },
      ]);
    });
  });

  describe('POST /admin/workers/:id/verify', () => {
    it('verifies a worker, who then sees it, can send location, and leaves the pending queue', async () => {
      const w = await onboardedWorker(t);
      const res = await http
        .post(
          `${QUEUE}/${w.userId}/verify`,
          { badge: 'Govt Certified Pro' },
          { token: adminToken() },
        )
        .expect(200);
      expect(res.body).toEqual({
        userId: w.userId,
        verificationStatus: 'VERIFIED',
        badge: 'Govt Certified Pro',
        rejectionReason: null,
      });

      const mine = await http
        .get(`${V1}/workers/me`, { token: w.accessToken })
        .expect(200);
      expect(mine.body).toMatchObject({
        verificationStatus: 'VERIFIED',
        badge: 'Govt Certified Pro',
      });
      expect(
        (
          await t.prisma.workerProfile.findUniqueOrThrow({
            where: { userId: w.userId },
          })
        ).verifiedAt,
      ).not.toBeNull();

      await http
        .put(
          `${V1}/workers/me/location`,
          { lat: 30.7, lng: 76.7 },
          { token: w.accessToken },
        )
        .expect(200);
      expect(
        (await http.get(QUEUE, { token: adminToken() }).expect(200)).body.items,
      ).toHaveLength(0);
    });

    it('refuses to verify without both Aadhaar images', async () => {
      const me = await newUser(t);
      await http
        .put(`${V1}/workers/me`, workerPayload(await anAreaId(t)), {
          token: me.accessToken,
        })
        .expect(200);
      const res = await http
        .post(`${QUEUE}/${me.userId}/verify`, {}, { token: adminToken() })
        .expect(409);
      expect(res.body.code).toBe('DOCUMENTS_MISSING');
      expect(
        (
          await t.prisma.workerProfile.findUniqueOrThrow({
            where: { userId: me.userId },
          })
        ).verificationStatus,
      ).toBe('PENDING');
    });

    it('is idempotent and keeps the existing badge when none is sent', async () => {
      const w = await onboardedWorker(t);
      await http
        .post(
          `${QUEUE}/${w.userId}/verify`,
          { badge: 'Police Verified' },
          { token: adminToken() },
        )
        .expect(200);
      const again = await http
        .post(`${QUEUE}/${w.userId}/verify`, {}, { token: adminToken() })
        .expect(200);
      expect(again.body).toMatchObject({
        verificationStatus: 'VERIFIED',
        badge: 'Police Verified',
      });
    });

    it('can verify a previously rejected worker and clears the reason', async () => {
      const w = await onboardedWorker(t);
      await http
        .post(
          `${QUEUE}/${w.userId}/reject`,
          { reason: 'Blurry' },
          { token: adminToken() },
        )
        .expect(200);
      const res = await http
        .post(`${QUEUE}/${w.userId}/verify`, {}, { token: adminToken() })
        .expect(200);
      expect(res.body).toMatchObject({
        verificationStatus: 'VERIFIED',
        rejectionReason: null,
      });
    });

    it('answers 404 for an unknown worker, 400 for a malformed id, 422 for a bad badge', async () => {
      await http
        .post(
          `${QUEUE}/018f0000-0000-7000-8000-000000000000/verify`,
          {},
          { token: adminToken() },
        )
        .expect(404);
      await http
        .post(`${QUEUE}/not-a-uuid/verify`, {}, { token: adminToken() })
        .expect(400);
      const w = await onboardedWorker(t);
      await http
        .post(
          `${QUEUE}/${w.userId}/verify`,
          { badge: 'x'.repeat(61) },
          { token: adminToken() },
        )
        .expect(422);
      await http
        .post(
          `${QUEUE}/${w.userId}/verify`,
          { badge: 'ok', verificationStatus: 'x' },
          { token: adminToken() },
        )
        .expect(422);
    });

    it('a customer-only user (no worker profile) is a 404, not a crash', async () => {
      const user = await newUser(t);
      await http
        .post(`${QUEUE}/${user.userId}/verify`, {}, { token: adminToken() })
        .expect(404);
    });
  });

  describe('POST /admin/workers/:id/reject', () => {
    it('rejects with a reason the worker can read, and re-queues after they fix it', async () => {
      const w = await onboardedWorker(t);
      const res = await http
        .post(
          `${QUEUE}/${w.userId}/reject`,
          { reason: '  Aadhaar back side is unreadable  ' },
          { token: adminToken() },
        )
        .expect(200);
      expect(res.body).toMatchObject({
        verificationStatus: 'REJECTED',
        rejectionReason: 'Aadhaar back side is unreadable',
      });

      const mine = await http
        .get(`${V1}/workers/me`, { token: w.accessToken })
        .expect(200);
      expect(mine.body).toMatchObject({
        verificationStatus: 'REJECTED',
        rejectionReason: 'Aadhaar back side is unreadable',
      });
      expect(
        (await http.get(QUEUE, { token: adminToken() }).expect(200)).body.items,
      ).toHaveLength(0);

      await http
        .patch(
          `${V1}/workers/me`,
          { fullName: 'Rajesh Kumar' },
          { token: w.accessToken },
        )
        .expect(200);
      const queue = await http.get(QUEUE, { token: adminToken() }).expect(200);
      expect(queue.body.items.map((i: { userId: string }) => i.userId)).toEqual(
        [w.userId],
      );
    });

    it('revokes an existing verification and takes away live-location access immediately', async () => {
      const w = await onboardedWorker(t);
      await http
        .post(`${QUEUE}/${w.userId}/verify`, {}, { token: adminToken() })
        .expect(200);
      await http
        .put(
          `${V1}/workers/me/location`,
          { lat: 30.7, lng: 76.7 },
          { token: w.accessToken },
        )
        .expect(200);

      await http
        .post(
          `${QUEUE}/${w.userId}/reject`,
          { reason: 'Complaint received' },
          { token: adminToken() },
        )
        .expect(200);
      const denied = await http
        .put(
          `${V1}/workers/me/location`,
          { lat: 30.8, lng: 76.8 },
          { token: w.accessToken },
        )
        .expect(403);
      expect(denied.body.code).toBe('NOT_VERIFIED');
      expect(
        (
          await t.prisma.workerProfile.findUniqueOrThrow({
            where: { userId: w.userId },
          })
        ).verifiedAt,
      ).toBeNull();
    });

    it('requires a reason', async () => {
      const w = await onboardedWorker(t);
      await http
        .post(`${QUEUE}/${w.userId}/reject`, {}, { token: adminToken() })
        .expect(422);
      await http
        .post(
          `${QUEUE}/${w.userId}/reject`,
          { reason: '   ' },
          { token: adminToken() },
        )
        .expect(422);
      await http
        .post(
          `${QUEUE}/${w.userId}/reject`,
          { reason: 'x'.repeat(301) },
          { token: adminToken() },
        )
        .expect(422);
    });

    it('answers 404 for an unknown worker', async () => {
      await http
        .post(
          `${QUEUE}/018f0000-0000-7000-8000-000000000000/reject`,
          { reason: 'x' },
          { token: adminToken() },
        )
        .expect(404);
    });
  });
});
