// Firebase Phone Authentication sign-in (POST /auth/firebase/verify) and the switch that turns the legacy SMS-code
// login off. Google is replaced by FakeFirebaseVerifier; everything else is the real app on the real test database.

import { ConfigService } from '@nestjs/config';
import { seedReferenceData } from '../prisma/seed/reference-data.js';
import { api, createTestApp, freshIp, type TestApp } from './helpers/app.js';
import { loginAs } from './helpers/auth.js';
import { resetDatabase } from './helpers/db.js';
import { nextPhone } from './helpers/factories.js';

const V1 = '/api/v1';
const FIREBASE_VERIFY = `${V1}/auth/firebase/verify`;
const OTP_REQUEST = `${V1}/auth/otp/request`;
const OTP_VERIFY = `${V1}/auth/otp/verify`;
const nowSec = () => Math.floor(Date.now() / 1000);

describe('Firebase phone sign-in (e2e, real PostgreSQL)', () => {
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
    t.sender.sent = [];
    t.firebase.verified = [];
    t.firebase.unavailableNext = false;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Makes the app behave as if these settings were in the environment (same technique as the dev-OTP spec). */
  const withConfig = (overrides: Record<string, unknown>) => {
    const config = t.app.get(ConfigService);
    const real = config.get.bind(config);
    vi.spyOn(config, 'get').mockImplementation(((
      key: string,
      opts?: unknown,
    ) =>
      key in overrides
        ? overrides[key]
        : real(key as never, opts as never)) as never);
  };

  describe('signing in', () => {
    it('creates the account on first sign-in and returns the same session shape as the SMS login', async () => {
      const phone = nextPhone();
      const res = await http
        .post(FIREBASE_VERIFY, { idToken: t.firebase.issue(phone) })
        .expect(200);

      expect(res.body).toMatchObject({
        isNewUser: true,
        expiresIn: 900,
        user: {
          phone,
          language: 'en',
          hasCustomerProfile: false,
          hasWorkerProfile: false,
        },
      });
      expect(res.body.accessToken).toBeTruthy();
      expect(res.body.refreshToken).toBeTruthy();

      // The session is OUR session: the access token opens protected routes.
      const me = await http
        .get(`${V1}/me`, { token: res.body.accessToken })
        .expect(200);
      expect(me.body.phone).toBe(phone);
      expect(await t.prisma.user.count({ where: { phone } })).toBe(1);
    });

    it('recognises a returning user, including one first created by the SMS login (same id, isNewUser=false)', async () => {
      const viaSms = await loginAs(t, nextPhone());
      const res = await http
        .post(FIREBASE_VERIFY, { idToken: t.firebase.issue(viaSms.phone) })
        .expect(200);
      expect(res.body.isNewUser).toBe(false);
      expect(res.body.user.id).toBe(viaSms.userId);

      const again = await http
        .post(FIREBASE_VERIFY, { idToken: t.firebase.issue(viaSms.phone) })
        .expect(200);
      expect(again.body.user.id).toBe(viaSms.userId);
      expect(await t.prisma.user.count()).toBe(1);
    });

    it('starts a normal rotating session: the refresh token works once and a replay revokes the login', async () => {
      const res = await http
        .post(FIREBASE_VERIFY, { idToken: t.firebase.issue(nextPhone()) })
        .expect(200);
      const first = await http
        .post(`${V1}/auth/refresh`, { refreshToken: res.body.refreshToken })
        .expect(200);
      expect(first.body.refreshToken).not.toBe(res.body.refreshToken);
      await http
        .post(`${V1}/auth/refresh`, { refreshToken: res.body.refreshToken })
        .expect(401);
      await http
        .post(`${V1}/auth/refresh`, { refreshToken: first.body.refreshToken })
        .expect(401); // the whole family is revoked
    });

    it('stores no Firebase token and no Firebase id: only our own hashed refresh token', async () => {
      const token = t.firebase.issue(nextPhone());
      await http.post(FIREBASE_VERIFY, { idToken: token }).expect(200);
      const rows = JSON.stringify(await t.prisma.refreshToken.findMany());
      expect(rows).not.toContain(token);
      expect(JSON.stringify(await t.prisma.user.findMany())).not.toContain(
        'uid-',
      );
    });

    it('refuses a disabled account and starts no session', async () => {
      const disabled = await loginAs(t, nextPhone());
      await t.prisma.user.update({
        where: { id: disabled.userId },
        data: { isActive: false },
      });
      const before = await t.prisma.refreshToken.count();

      const res = await http
        .post(FIREBASE_VERIFY, { idToken: t.firebase.issue(disabled.phone) })
        .expect(403);
      expect(res.body.code).toBe('ACCOUNT_DISABLED');
      expect(res.body).not.toHaveProperty('accessToken');
      expect(await t.prisma.refreshToken.count()).toBe(before);
    });
  });

  describe('tokens that must not sign anyone in', () => {
    const expectRefused = async (
      idToken: string,
      status: number,
      code: string,
    ) => {
      const res = await http.post(FIREBASE_VERIFY, { idToken }).expect(status);
      expect(res.body.code).toBe(code);
      expect(res.body).not.toHaveProperty('accessToken');
      expect(await t.prisma.user.count()).toBe(0);
      expect(await t.prisma.refreshToken.count()).toBe(0);
    };

    it('an unknown, forged or expired token (the verifier rejects it): 401 and no account', async () => {
      await expectRefused(
        `not-a-real-token-${'z'.repeat(30)}`,
        401,
        'FIREBASE_TOKEN_INVALID',
      );
    });

    it('a stale sign-in is refused (the token itself may still be valid for an hour); a fresh one inside the window is accepted', async () => {
      const phone = nextPhone();
      await expectRefused(
        t.firebase.issue(phone, { authTimeSec: nowSec() - 301 }),
        401,
        'FIREBASE_TOKEN_STALE',
      );
      await http
        .post(FIREBASE_VERIFY, {
          idToken: t.firebase.issue(phone, { authTimeSec: nowSec() - 290 }),
        })
        .expect(200);
    });

    it('honours FIREBASE_AUTH_MAX_AGE_SEC', async () => {
      withConfig({ FIREBASE_AUTH_MAX_AGE_SEC: 60 });
      await expectRefused(
        t.firebase.issue(nextPhone(), { authTimeSec: nowSec() - 120 }),
        401,
        'FIREBASE_TOKEN_STALE',
      );
    });

    it('a sign-in time far in the future is not trusted', async () => {
      await expectRefused(
        t.firebase.issue(nextPhone(), { authTimeSec: nowSec() + 3600 }),
        401,
        'FIREBASE_TOKEN_INVALID',
      );
    });

    it('a Firebase user who did not sign in with a phone proves nothing (email, anonymous, custom)', async () => {
      for (const signInProvider of [
        'password',
        'anonymous',
        'custom',
        'google.com',
        undefined,
      ]) {
        await expectRefused(
          t.firebase.issue(nextPhone(), { signInProvider }),
          401,
          'FIREBASE_TOKEN_INVALID',
        );
      }
    });

    it('a token without a phone number is refused', async () => {
      await expectRefused(
        t.firebase.issue(nextPhone(), { phoneNumber: undefined }),
        401,
        'FIREBASE_TOKEN_INVALID',
      );
    });

    it('only Indian mobile numbers are accepted', async () => {
      for (const phoneNumber of [
        '+14155550123',
        '+911234567890', // does not start 6-9
        '919876543210', // not E.164
        '+91987654321', // too short
      ]) {
        const res = await http
          .post(FIREBASE_VERIFY, {
            idToken: t.firebase.issue('+919876543210', { phoneNumber }),
          })
          .expect(422);
        expect(res.body.code).toBe('PHONE_NOT_SUPPORTED');
      }
      expect(await t.prisma.user.count()).toBe(0);
    });

    it('reports an unreachable Google as 503 (not 401), creates nothing, and a retry works', async () => {
      const phone = nextPhone();
      t.firebase.unavailableNext = true;
      const res = await http
        .post(FIREBASE_VERIFY, { idToken: t.firebase.issue(phone) })
        .expect(503);
      expect(res.body.code).toBe('FIREBASE_UNAVAILABLE');
      expect(await t.prisma.user.count()).toBe(0);
      await http
        .post(FIREBASE_VERIFY, { idToken: t.firebase.issue(phone) })
        .expect(200);
    });

    it('validates the body: missing, too short, wrong type and unknown fields are 422', async () => {
      await http.post(FIREBASE_VERIFY, {}).expect(422);
      await http.post(FIREBASE_VERIFY, { idToken: 'short' }).expect(422);
      await http.post(FIREBASE_VERIFY, { idToken: 12345 }).expect(422);
      await http
        .post(FIREBASE_VERIFY, {
          idToken: t.firebase.issue(nextPhone()),
          phone: nextPhone(), // the number must come from the token, never from the caller
        })
        .expect(422);
      expect(t.firebase.verified).toHaveLength(0); // none of those reached the verifier
    });

    it('trusts the phone number in the token, not one supplied by the caller', async () => {
      const real = nextPhone();
      const res = await http
        .post(FIREBASE_VERIFY, { idToken: t.firebase.issue(real) })
        .expect(200);
      expect(res.body.user.phone).toBe(real);
    });
  });

  describe('rate limiting', () => {
    it('limits exchanges to 30 per 15 minutes per client IP, independently per IP', async () => {
      const ip = freshIp();
      for (let i = 0; i < 30; i += 1) {
        await http
          .post(
            FIREBASE_VERIFY,
            { idToken: `bad-token-${'q'.repeat(30)}` },
            { ip },
          )
          .expect(401);
      }
      const blocked = await http
        .post(
          FIREBASE_VERIFY,
          { idToken: `bad-token-${'q'.repeat(30)}` },
          { ip },
        )
        .expect(429);
      expect(blocked.body.code).toBe('TOO_MANY_REQUESTS');

      await http
        .post(
          FIREBASE_VERIFY,
          { idToken: t.firebase.issue(nextPhone()) },
          { ip: freshIp() },
        )
        .expect(200);
    });
  });

  describe('the legacy SMS-code login stays as it was', () => {
    it('still works end to end with Firebase available (default settings)', async () => {
      const phone = nextPhone();
      await http.post(OTP_REQUEST, { phone }).expect(202);
      const res = await http
        .post(OTP_VERIFY, { phone, code: t.sender.lastCode(phone) })
        .expect(200);
      expect(res.body.isNewUser).toBe(true);
    });

    it('the development bypass (fixed code 123456, with its notice) still works when it is switched on', async () => {
      withConfig({ OTP_DEV_BYPASS: true });
      const phone = nextPhone();
      const requested = await http.post(OTP_REQUEST, { phone }).expect(202);
      expect(requested.body.devNotice).toMatch(/DEVELOPMENT ONLY/);
      await http.post(OTP_VERIFY, { phone, code: '123456' }).expect(200);
    });
  });

  describe('LEGACY_OTP_ENABLED=false (production with Firebase sign-in)', () => {
    it('switches off requesting and verifying a code: 404 LEGACY_OTP_DISABLED, nothing sent, nothing stored, no account', async () => {
      withConfig({ LEGACY_OTP_ENABLED: false });
      const phone = nextPhone();
      const requested = await http.post(OTP_REQUEST, { phone }).expect(404);
      expect(requested.body.code).toBe('LEGACY_OTP_DISABLED');
      const verified = await http
        .post(OTP_VERIFY, { phone, code: '123456' })
        .expect(404);
      expect(verified.body.code).toBe('LEGACY_OTP_DISABLED');

      expect(t.sender.sent).toHaveLength(0);
      expect(await t.prisma.otpChallenge.count()).toBe(0);
      expect(await t.prisma.user.count()).toBe(0);
    });

    it('refuses even a code that was issued just before the switch, and even the development bypass code', async () => {
      const phone = nextPhone();
      await http.post(OTP_REQUEST, { phone }).expect(202);
      const code = t.sender.lastCode(phone);

      withConfig({ LEGACY_OTP_ENABLED: false, OTP_DEV_BYPASS: true });
      await http.post(OTP_VERIFY, { phone, code }).expect(404);
      await http.post(OTP_VERIFY, { phone, code: '123456' }).expect(404);
      expect(await t.prisma.user.count()).toBe(0);
    });

    it('does not affect Firebase sign-in, refresh or logout', async () => {
      withConfig({ LEGACY_OTP_ENABLED: false });
      const res = await http
        .post(FIREBASE_VERIFY, { idToken: t.firebase.issue(nextPhone()) })
        .expect(200);
      const refreshed = await http
        .post(`${V1}/auth/refresh`, { refreshToken: res.body.refreshToken })
        .expect(200);
      await http
        .post(
          `${V1}/auth/logout`,
          { refreshToken: refreshed.body.refreshToken },
          { token: refreshed.body.accessToken },
        )
        .expect(204);
    });
  });
});
