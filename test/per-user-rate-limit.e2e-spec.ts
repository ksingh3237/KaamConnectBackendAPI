// A second, per-USER rate limit behind the existing per-IP one (docs/09 section 1.4). The test client gives every call
// a fresh IP unless told otherwise, which is exactly the situation this layer exists for: one account that keeps
// changing address. The per-IP limit must be exactly what it was, and SOS must be exempt.

import { seedReferenceData } from '../prisma/seed/reference-data.js';
import { api, createTestApp, type TestApp } from './helpers/app.js';
import { loginAs } from './helpers/auth.js';
import { resetDatabase } from './helpers/db.js';
import { nextPhone } from './helpers/factories.js';
import { V1 } from './helpers/fulfilment.js';

const LIMIT = 8;
const SOME_ID = '0197a0c0-0000-7000-8000-000000000000';

describe('per-user rate limit (e2e)', () => {
  describe('with a low limit', () => {
    let t: TestApp;
    let http: ReturnType<typeof api>;

    beforeAll(async () => {
      t = await createTestApp({ userRateLimitPerMin: LIMIT });
      http = api(t.app);
    });
    afterAll(async () => {
      await t.close();
    });
    beforeEach(async () => {
      await resetDatabase(t.prisma);
      await seedReferenceData(t.prisma);
    });

    it('one account is refused after its limit even though every call comes from a different address', async () => {
      const me = await loginAs(t, nextPhone());
      for (let i = 0; i < LIMIT; i += 1)
        await http.get(`${V1}/me`, { token: me.accessToken }).expect(200);

      const refused = await http.get(`${V1}/me`, { token: me.accessToken });
      expect(refused.status).toBe(429);
      expect(refused.body).toMatchObject({
        statusCode: 429,
        code: 'TOO_MANY_REQUESTS',
      });
      expect(Number(refused.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    });

    it('the limit is across routes, not per route', async () => {
      const me = await loginAs(t, nextPhone());
      const routes = [
        `${V1}/me`,
        `${V1}/service-categories`,
        `${V1}/locations`,
      ];
      for (let i = 0; i < LIMIT; i += 1)
        await http
          .get(routes[i % routes.length]!, { token: me.accessToken })
          .expect(200);
      // A route this user has not called at all is refused too.
      await http
        .get(`${V1}/customers/me/jobs`, { token: me.accessToken })
        .expect(429);
    });

    it('is counted per account: another user is unaffected while the first is refused', async () => {
      const a = await loginAs(t, nextPhone());
      const b = await loginAs(t, nextPhone());
      for (let i = 0; i < LIMIT; i += 1)
        await http.get(`${V1}/me`, { token: a.accessToken }).expect(200);
      await http.get(`${V1}/me`, { token: a.accessToken }).expect(429);
      await http.get(`${V1}/me`, { token: b.accessToken }).expect(200);
    });

    it('follows the account, not the token: logging in again does not give a fresh budget', async () => {
      const phone = nextPhone();
      const first = await loginAs(t, phone);
      const second = await loginAs(t, phone);
      expect(second.userId).toBe(first.userId);
      for (let i = 0; i < LIMIT; i += 1)
        await http.get(`${V1}/me`, { token: first.accessToken }).expect(200);
      await http.get(`${V1}/me`, { token: second.accessToken }).expect(429);
    });

    it('SOS is exempt: an exhausted account can still raise an alert', async () => {
      const me = await loginAs(t, nextPhone());
      for (let i = 0; i < LIMIT; i += 1)
        await http.get(`${V1}/me`, { token: me.accessToken }).expect(200);
      await http.get(`${V1}/me`, { token: me.accessToken }).expect(429);

      // Not 429: the request reaches the handler (an unknown job is a plain 404 there).
      const sos = await http.post(
        `${V1}/jobs/${SOME_ID}/sos`,
        {},
        { token: me.accessToken },
      );
      expect(sos.status).not.toBe(429);
    });

    it('requests with nobody signed in are not counted against anyone, and health is never limited', async () => {
      for (let i = 0; i < LIMIT * 3; i += 1) {
        const res = await http.get(`${V1}/me`); // no token: 401 from the login guard, not 429
        expect(res.status).toBe(401);
      }
      for (let i = 0; i < 30; i += 1) await http.get('/health').expect(200);
    });

    it('a refused request is cheap: it never reaches the profile lookup or the handler (no job is created)', async () => {
      const me = await loginAs(t, nextPhone());
      for (let i = 0; i < LIMIT; i += 1)
        await http.get(`${V1}/me`, { token: me.accessToken }).expect(200);
      const before = await t.prisma.job.count();
      await http
        .post(
          `${V1}/jobs`,
          { categoryId: 'plumber', title: 'x', timing: 'IMMEDIATE' },
          { token: me.accessToken },
        )
        .expect(429);
      expect(await t.prisma.job.count()).toBe(before);
    });
  });

  describe('with the normal limit', () => {
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

    it('the per-IP limit is unchanged: 60 a minute per route per address, also for a signed-in user', async () => {
      const me = await loginAs(t, nextPhone());
      const ip = '203.0.113.50';
      for (let i = 0; i < 60; i += 1)
        await http.get(`${V1}/me`, { token: me.accessToken, ip }).expect(200);
      const refused = await http.get(`${V1}/me`, { token: me.accessToken, ip });
      expect(refused.status).toBe(429);
      expect(refused.body.code).toBe('TOO_MANY_REQUESTS');
      // A different address, same account: not refused (the user limit is far above 60).
      await http
        .get(`${V1}/me`, { token: me.accessToken, ip: '203.0.113.51' })
        .expect(200);
    });
  });
});
