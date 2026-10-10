import { JwtService } from '@nestjs/jwt';
import { AuthCleanupService } from '../src/modules/auth/auth-cleanup.service.js';
import { sha256Hex } from '../src/modules/auth/token.service.js';
import { seedReferenceData } from '../prisma/seed/reference-data.js';
import { api, createTestApp, freshIp, type TestApp } from './helpers/app.js';
import { expireCooldown, loginAs } from './helpers/auth.js';
import { resetDatabase } from './helpers/db.js';
import { nextPhone } from './helpers/factories.js';

const V1 = '/api/v1';
const OTP_REQUEST = `${V1}/auth/otp/request`;
const OTP_VERIFY = `${V1}/auth/otp/verify`;
const REFRESH = `${V1}/auth/refresh`;
const LOGOUT = `${V1}/auth/logout`;

describe('authentication (e2e, real PostgreSQL)', () => {
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
    t.sender.failNext = false;
  });

  describe('requesting a code', () => {
    it('answers 202 with timings, delivers a 6-digit code, and stores only a keyed hash', async () => {
      const phone = nextPhone();
      const res = await http.post(OTP_REQUEST, { phone }).expect(202);

      expect(res.body).toEqual({ resendAfterSec: 30, expiresInSec: 300 });
      expect(t.sender.sent).toHaveLength(1);
      const { code } = t.sender.sent[0]!;
      expect(code).toMatch(/^\d{6}$/);

      const row = await t.prisma.otpChallenge.findFirstOrThrow({
        where: { phone },
      });
      expect(row.codeHash).toMatch(/^[0-9a-f]{64}$/);
      expect(row.codeHash).not.toContain(code);
      expect(row.codeHash).not.toBe(sha256Hex(code)); // keyed (pepper + phone), not a plain hash
      expect(row.attempts).toBe(0);
    });

    it('normalises the number the way the app types it ("98765 43210")', async () => {
      await http.post(OTP_REQUEST, { phone: '98765 43210' }).expect(202);
      expect(t.sender.sent[0]!.phone).toBe('+919876543210');
    });

    it('rejects invalid numbers and unknown fields with 422 and field details', async () => {
      const bad = await http.post(OTP_REQUEST, { phone: '12345' }).expect(422);
      expect(bad.body).toMatchObject({ code: 'VALIDATION_FAILED' });
      expect(bad.body.details[0]).toMatchObject({ field: 'phone' });

      await http
        .post(OTP_REQUEST, { phone: nextPhone(), isAdmin: true })
        .expect(422);
      await http.post(OTP_REQUEST, {}).expect(422);
      expect(t.sender.sent).toHaveLength(0);
    });

    it('answers the same for a registered and an unknown number (no account enumeration)', async () => {
      const known = nextPhone();
      await loginAs(t, known);
      await expireCooldown(t.prisma, known);
      t.sender.sent = [];

      const a = await http.post(OTP_REQUEST, { phone: known }).expect(202);
      const b = await http
        .post(OTP_REQUEST, { phone: nextPhone() })
        .expect(202);
      expect(a.body).toEqual(b.body);
    });

    it('does not offer WhatsApp yet and sends nothing', async () => {
      const phone = nextPhone();
      const res = await http
        .post(OTP_REQUEST, { phone, channel: 'WHATSAPP' })
        .expect(501);
      expect(res.body.code).toBe('CHANNEL_NOT_AVAILABLE');
      expect(t.sender.sent).toHaveLength(0);
      expect(await t.prisma.otpChallenge.count({ where: { phone } })).toBe(0);
    });

    it('enforces the resend cooldown and tells the client how long to wait', async () => {
      const phone = nextPhone();
      await http.post(OTP_REQUEST, { phone }).expect(202);
      const res = await http.post(OTP_REQUEST, { phone }).expect(429);

      expect(res.body.code).toBe('OTP_COOLDOWN');
      expect(res.body.retryAfterSec).toBeGreaterThan(0);
      expect(res.body.retryAfterSec).toBeLessThanOrEqual(30);
      expect(res.headers['retry-after']).toBe(String(res.body.retryAfterSec));
      expect(t.sender.sent).toHaveLength(1);
    });

    it('caps codes at 5 per phone per hour', async () => {
      const phone = nextPhone();
      const minutesAgo = (m: number) => new Date(Date.now() - m * 60 * 1000);
      await t.prisma.otpChallenge.createMany({
        data: [50, 40, 30, 20, 10].map((m) => ({
          phone,
          codeHash: 'x'.repeat(64),
          expiresAt: minutesAgo(m - 5),
          createdAt: minutesAgo(m),
        })),
      });

      const res = await http.post(OTP_REQUEST, { phone }).expect(429);
      expect(res.body.code).toBe('OTP_LIMIT');
      // Oldest request was 50 min ago, so the window frees up in about 10 minutes.
      expect(res.body.retryAfterSec).toBeGreaterThan(8 * 60);
      expect(res.body.retryAfterSec).toBeLessThanOrEqual(10 * 60 + 5);
      expect(t.sender.sent).toHaveLength(0);
    });

    it('lets only one of several simultaneous requests through (no cooldown bypass)', async () => {
      const phone = nextPhone();
      const results = await Promise.all(
        [1, 2, 3, 4].map(() => http.post(OTP_REQUEST, { phone })),
      );

      expect(results.map((r) => r.status).sort()).toEqual([202, 429, 429, 429]);
      expect(t.sender.sent).toHaveLength(1);
      expect(await t.prisma.otpChallenge.count({ where: { phone } })).toBe(1);
    });

    it('reports delivery failure as 502, keeps no dead code, and allows an immediate retry', async () => {
      const phone = nextPhone();
      t.sender.failNext = true;
      const res = await http.post(OTP_REQUEST, { phone }).expect(502);

      expect(res.body.code).toBe('OTP_SEND_FAILED');
      expect(await t.prisma.otpChallenge.count({ where: { phone } })).toBe(0);
      await http.post(OTP_REQUEST, { phone }).expect(202);
    });

    it('a new code replaces the previous one', async () => {
      const phone = nextPhone();
      await http.post(OTP_REQUEST, { phone }).expect(202);
      const first = t.sender.lastCode(phone);

      await expireCooldown(t.prisma, phone);
      await http.post(OTP_REQUEST, { phone }).expect(202);
      const second = t.sender.lastCode(phone);

      if (first !== second) {
        await http.post(OTP_VERIFY, { phone, code: first }).expect(401);
      }
      await http.post(OTP_VERIFY, { phone, code: second }).expect(200);
    });
  });

  describe('verifying a code', () => {
    it('creates the account on first login and returns tokens plus profile flags', async () => {
      const phone = nextPhone();
      await http.post(OTP_REQUEST, { phone }).expect(202);
      const res = await http
        .post(OTP_VERIFY, { phone, code: t.sender.lastCode(phone) })
        .expect(200);

      expect(res.body).toMatchObject({
        expiresIn: 900,
        isNewUser: true,
        user: {
          phone,
          language: 'en',
          hasCustomerProfile: false,
          hasWorkerProfile: false,
        },
      });
      expect(res.body.accessToken.split('.')).toHaveLength(3);
      expect(res.body.refreshToken).toMatch(/^[A-Za-z0-9_-]{43}$/);

      // Only the hash of the refresh token is stored.
      const stored = await t.prisma.refreshToken.findFirstOrThrow({
        where: { userId: res.body.user.id },
      });
      expect(stored.tokenHash).toBe(sha256Hex(res.body.refreshToken));
      expect(stored.tokenHash).not.toBe(res.body.refreshToken);
    });

    it('recognises a returning user (same id, isNewUser=false), however the number is typed', async () => {
      const first = await loginAs(t, '+919876543210');
      expect(first.isNewUser).toBe(true);

      await expireCooldown(t.prisma, '+919876543210');
      await http.post(OTP_REQUEST, { phone: '98765 43210' }).expect(202);
      const res = await http
        .post(OTP_VERIFY, {
          phone: '+91 98765-43210',
          code: t.sender.lastCode('+919876543210'),
        })
        .expect(200);

      expect(res.body.isNewUser).toBe(false);
      expect(res.body.user.id).toBe(first.userId);
      expect(await t.prisma.user.count()).toBe(1);
    });

    it('reflects existing profiles in the login response', async () => {
      const phone = nextPhone();
      const me = await loginAs(t, phone);
      await t.prisma.customerProfile.create({
        data: { userId: me.userId, fullName: 'Sunita Sharma' },
      });

      const again = await loginAs(t, phone);
      const res = await http
        .get(`${V1}/me`, { token: again.accessToken })
        .expect(200);
      expect(res.body.customer).toMatchObject({
        fullName: 'Sunita Sharma',
        commLanguage: 'hi',
        allowDirectCalls: true,
      });
      expect(res.body.worker).toBeNull();
    });

    it('rejects a wrong code with the same answer as an unknown or expired one', async () => {
      const phone = nextPhone();
      await http.post(OTP_REQUEST, { phone }).expect(202);
      const code = t.sender.lastCode(phone);
      const wrong = code === '000000' ? '111111' : '000000';

      const wrongRes = await http
        .post(OTP_VERIFY, { phone, code: wrong })
        .expect(401);
      const noChallenge = await http
        .post(OTP_VERIFY, { phone: nextPhone(), code })
        .expect(401);
      expect(wrongRes.body).toEqual(noChallenge.body);
      expect(wrongRes.body.code).toBe('OTP_INVALID');

      await t.prisma.otpChallenge.updateMany({
        where: { phone },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      const expired = await http.post(OTP_VERIFY, { phone, code }).expect(401);
      expect(expired.body).toEqual(wrongRes.body);
    });

    it('locks after 5 wrong attempts: even the right code is refused until a new one is requested', async () => {
      const phone = nextPhone();
      await http.post(OTP_REQUEST, { phone }).expect(202);
      const code = t.sender.lastCode(phone);
      const wrong = code === '000000' ? '111111' : '000000';

      for (let i = 0; i < 4; i += 1) {
        await http.post(OTP_VERIFY, { phone, code: wrong }).expect(401);
      }
      const fifth = await http
        .post(OTP_VERIFY, { phone, code: wrong })
        .expect(429);
      expect(fifth.body.code).toBe('OTP_LOCKED');

      const rightButLocked = await http
        .post(OTP_VERIFY, { phone, code })
        .expect(429);
      expect(rightButLocked.body.code).toBe('OTP_LOCKED');
      expect(await t.prisma.user.count()).toBe(0);

      await expireCooldown(t.prisma, phone);
      await http.post(OTP_REQUEST, { phone }).expect(202);
      await http
        .post(OTP_VERIFY, { phone, code: t.sender.lastCode(phone) })
        .expect(200);
    });

    it('cannot be guessed past the limit by parallel requests', async () => {
      const phone = nextPhone();
      await http.post(OTP_REQUEST, { phone }).expect(202);
      const code = t.sender.lastCode(phone);
      const wrong = code === '000000' ? '111111' : '000000';

      await Promise.all(
        Array.from({ length: 12 }, () =>
          http.post(OTP_VERIFY, { phone, code: wrong }),
        ),
      );

      const row = await t.prisma.otpChallenge.findFirstOrThrow({
        where: { phone },
      });
      expect(row.attempts).toBe(5);
    });

    it('is single use, including under a race: exactly one of two simultaneous submits wins', async () => {
      const phone = nextPhone();
      await http.post(OTP_REQUEST, { phone }).expect(202);
      const code = t.sender.lastCode(phone);

      const results = await Promise.all([
        http.post(OTP_VERIFY, { phone, code }),
        http.post(OTP_VERIFY, { phone, code }),
      ]);

      expect(results.map((r) => r.status).sort()).toEqual([200, 401]);
      expect(await t.prisma.user.count()).toBe(1);
      expect(await t.prisma.refreshToken.count()).toBe(1);
      await http.post(OTP_VERIFY, { phone, code }).expect(401);
    });

    it('validates the code format and rejects unexpected fields', async () => {
      const phone = nextPhone();
      for (const code of ['12345', '1234567', 'abcdef', '12 456', '']) {
        await http.post(OTP_VERIFY, { phone, code }).expect(422);
      }
      await http
        .post(OTP_VERIFY, { phone, code: '123456', role: 'admin' })
        .expect(422);
    });

    it('refuses a disabled account and does not start a session', async () => {
      const phone = nextPhone();
      await t.prisma.user.create({ data: { phone, isActive: false } });
      await http.post(OTP_REQUEST, { phone }).expect(202);

      const res = await http
        .post(OTP_VERIFY, { phone, code: t.sender.lastCode(phone) })
        .expect(403);
      expect(res.body.code).toBe('ACCOUNT_DISABLED');
      expect(await t.prisma.refreshToken.count()).toBe(0);
    });
  });

  describe('route protection', () => {
    it('lets public routes through without a token', async () => {
      await http.get('/health').expect(200);
      await http.post(OTP_REQUEST, { phone: nextPhone() }).expect(202);
    });

    it('requires a token on protected routes, including the catalog', async () => {
      for (const path of [
        `${V1}/me`,
        `${V1}/locations`,
        `${V1}/service-categories`,
      ]) {
        const res = await http.get(path).expect(401);
        expect(res.body).toMatchObject({
          statusCode: 401,
          code: 'UNAUTHENTICATED',
        });
      }
      const me = await loginAs(t, nextPhone());
      await http.get(`${V1}/locations`, { token: me.accessToken }).expect(200);
    });

    it('rejects malformed, forged, expired and unsigned tokens', async () => {
      const me = await loginAs(t, nextPhone());
      const jwt = t.app.get(JwtService);
      const get = (headers: Record<string, string>) =>
        http.get(`${V1}/me`).set(headers);

      await get({ Authorization: 'Bearer' }).expect(401);
      await get({ Authorization: 'Bearer not.a.jwt' }).expect(401);
      await get({ Authorization: `Basic ${me.accessToken}` }).expect(401);
      await get({ Authorization: me.accessToken }).expect(401);

      // Signed with a different secret.
      const forged = await jwt.signAsync(
        { sub: me.userId },
        { secret: 'attacker-secret-attacker-secret-attacker', expiresIn: 60 },
      );
      await get({ Authorization: `Bearer ${forged}` }).expect(401);

      // Correct secret, but already expired: the client should refresh, so the code differs.
      const expired = await jwt.signAsync(
        { sub: me.userId },
        { expiresIn: -10 },
      );
      const expiredRes = await get({
        Authorization: `Bearer ${expired}`,
      }).expect(401);
      expect(expiredRes.body.code).toBe('TOKEN_EXPIRED');

      // alg=none (classic bypass): must never be accepted.
      const b64 = (o: object) =>
        Buffer.from(JSON.stringify(o)).toString('base64url');
      const unsigned = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ sub: me.userId, exp: 4102444800 })}.`;
      await get({ Authorization: `Bearer ${unsigned}` }).expect(401);

      // Valid signature but the account was deleted.
      const ghost = await jwt.signAsync(
        { sub: '018f0000-0000-7000-8000-000000000000' },
        { expiresIn: 60 },
      );
      await get({ Authorization: `Bearer ${ghost}` }).expect(401);

      await get({ Authorization: `Bearer ${me.accessToken}` }).expect(200);
    });

    it('signs HS256 tokens that carry only the subject, a unique id and an expiry', async () => {
      const me = await loginAs(t, nextPhone());
      const [header, payload] = me.accessToken
        .split('.')
        .slice(0, 2) // header and payload; the third part is the binary signature
        .map((p) => JSON.parse(Buffer.from(p!, 'base64url').toString()));
      expect(header).toMatchObject({ alg: 'HS256' });
      expect(Object.keys(payload).sort()).toEqual(['exp', 'iat', 'jti', 'sub']);
      expect(payload.sub).toBe(me.userId);
      expect(payload.exp - payload.iat).toBe(900);
    });
  });

  describe('refresh tokens', () => {
    it('rotates: returns a new pair and spends the old token', async () => {
      const me = await loginAs(t, nextPhone());
      const res = await http
        .post(REFRESH, { refreshToken: me.refreshToken })
        .expect(200);

      expect(res.body.refreshToken).not.toBe(me.refreshToken);
      expect(res.body.accessToken).not.toBe(me.accessToken);
      expect(res.body.expiresIn).toBe(900);
      await http.get(`${V1}/me`, { token: res.body.accessToken }).expect(200);
    });

    it('treats a replayed token as theft: refuses it and revokes the whole login', async () => {
      const me = await loginAs(t, nextPhone());
      const rotated = await http
        .post(REFRESH, { refreshToken: me.refreshToken })
        .expect(200);

      const replay = await http
        .post(REFRESH, { refreshToken: me.refreshToken })
        .expect(401);
      expect(replay.body.code).toBe('REFRESH_REUSED');

      // The legitimate, newer token from the same login is now dead too.
      const afterTheft = await http
        .post(REFRESH, { refreshToken: rotated.body.refreshToken })
        .expect(401);
      expect(afterTheft.body.code).toBe('REFRESH_REUSED');
      expect(
        await t.prisma.refreshToken.count({ where: { revokedAt: null } }),
      ).toBe(0);
    });

    it('lets only one of two simultaneous refreshes win and then revokes the login', async () => {
      const me = await loginAs(t, nextPhone());
      const results = await Promise.all([
        http.post(REFRESH, { refreshToken: me.refreshToken }),
        http.post(REFRESH, { refreshToken: me.refreshToken }),
      ]);

      expect(results.map((r) => r.status).sort()).toEqual([200, 401]);
      expect(
        await t.prisma.refreshToken.count({ where: { revokedAt: null } }),
      ).toBe(0);
    });

    it('rejects unknown, expired and malformed tokens', async () => {
      const me = await loginAs(t, nextPhone());

      const unknown = await http
        .post(REFRESH, { refreshToken: 'A'.repeat(43) })
        .expect(401);
      expect(unknown.body.code).toBe('REFRESH_INVALID');

      await t.prisma.refreshToken.updateMany({
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      const expired = await http
        .post(REFRESH, { refreshToken: me.refreshToken })
        .expect(401);
      expect(expired.body.code).toBe('REFRESH_INVALID');

      await http.post(REFRESH, { refreshToken: 'short' }).expect(422);
      await http.post(REFRESH, {}).expect(422);
    });

    it('stops working for a disabled account and ends that login', async () => {
      const me = await loginAs(t, nextPhone());
      await t.prisma.user.update({
        where: { id: me.userId },
        data: { isActive: false },
      });

      const res = await http
        .post(REFRESH, { refreshToken: me.refreshToken })
        .expect(403);
      expect(res.body.code).toBe('ACCOUNT_DISABLED');
      expect(
        await t.prisma.refreshToken.count({ where: { revokedAt: null } }),
      ).toBe(0);
    });

    it('keeps separate logins (devices) independent', async () => {
      const phone = nextPhone();
      const phoneA = await loginAs(t, phone);
      const phoneB = await loginAs(t, phone);

      await http
        .post(
          LOGOUT,
          { refreshToken: phoneA.refreshToken },
          { token: phoneA.accessToken },
        )
        .expect(204);
      await http
        .post(REFRESH, { refreshToken: phoneB.refreshToken })
        .expect(200);
    });
  });

  describe('logout', () => {
    it('ends the login: its refresh token no longer works', async () => {
      const me = await loginAs(t, nextPhone());
      await http
        .post(
          LOGOUT,
          { refreshToken: me.refreshToken },
          { token: me.accessToken },
        )
        .expect(204);

      await http.post(REFRESH, { refreshToken: me.refreshToken }).expect(401);
      expect(
        await t.prisma.refreshToken.count({ where: { revokedAt: null } }),
      ).toBe(0);
    });

    it("is idempotent and ignores tokens that are not the caller's", async () => {
      const alice = await loginAs(t, nextPhone());
      const bob = await loginAs(t, nextPhone());

      await http
        .post(
          LOGOUT,
          { refreshToken: bob.refreshToken },
          { token: alice.accessToken },
        )
        .expect(204);
      await http.post(REFRESH, { refreshToken: bob.refreshToken }).expect(200); // Bob unaffected

      await http
        .post(
          LOGOUT,
          { refreshToken: alice.refreshToken },
          { token: alice.accessToken },
        )
        .expect(204);
      await http
        .post(
          LOGOUT,
          { refreshToken: alice.refreshToken },
          { token: alice.accessToken },
        )
        .expect(204);
      await http
        .post(
          LOGOUT,
          { refreshToken: 'Z'.repeat(43) },
          { token: alice.accessToken },
        )
        .expect(204);
    });

    it('requires authentication', async () => {
      const me = await loginAs(t, nextPhone());
      await http.post(LOGOUT, { refreshToken: me.refreshToken }).expect(401);
    });
  });

  describe('GET/PATCH /me', () => {
    it('returns the caller only', async () => {
      const phone = nextPhone();
      const me = await loginAs(t, phone);
      const res = await http
        .get(`${V1}/me`, { token: me.accessToken })
        .expect(200);
      expect(res.body).toEqual({
        id: me.userId,
        phone,
        language: 'en',
        customer: null,
        worker: null,
      });
    });

    it('updates the language and nothing else', async () => {
      const me = await loginAs(t, nextPhone());
      const res = await http
        .patch(`${V1}/me`, { language: 'pa' }, { token: me.accessToken })
        .expect(200);
      expect(res.body.language).toBe('pa');
      expect(
        (await t.prisma.user.findUniqueOrThrow({ where: { id: me.userId } }))
          .language,
      ).toBe('pa');
    });

    it('rejects unsupported languages and tries to change protected fields', async () => {
      const me = await loginAs(t, nextPhone());
      await http
        .patch(`${V1}/me`, { language: 'fr' }, { token: me.accessToken })
        .expect(422);
      await http.patch(`${V1}/me`, {}, { token: me.accessToken }).expect(422);

      const attack = await http
        .patch(
          `${V1}/me`,
          {
            language: 'hi',
            isAdmin: true,
            phone: '+919999999999',
            isActive: false,
          },
          { token: me.accessToken },
        )
        .expect(422);
      expect(
        attack.body.details.map((d: { field: string }) => d.field).sort(),
      ).toEqual(['isActive', 'isAdmin', 'phone']);

      const row = await t.prisma.user.findUniqueOrThrow({
        where: { id: me.userId },
      });
      expect([row.isAdmin, row.isActive, row.language]).toEqual([
        false,
        true,
        'en',
      ]);
    });
  });

  describe('rate limiting', () => {
    it('limits code requests to 20 per hour per client IP, independently per IP', async () => {
      const ip = freshIp();
      for (let i = 0; i < 20; i += 1) {
        await http
          .post(OTP_REQUEST, { phone: nextPhone() }, { ip })
          .expect(202);
      }
      const blocked = await http
        .post(OTP_REQUEST, { phone: nextPhone() }, { ip })
        .expect(429);
      expect(blocked.body.code).toBe('TOO_MANY_REQUESTS');

      await http
        .post(OTP_REQUEST, { phone: nextPhone() }, { ip: freshIp() })
        .expect(202);
    });

    it('limits code checks to 30 per 15 minutes per client IP', async () => {
      const ip = freshIp();
      const phone = nextPhone();
      for (let i = 0; i < 30; i += 1) {
        await http
          .post(OTP_VERIFY, { phone, code: '000000' }, { ip })
          .expect(401);
      }
      await http
        .post(OTP_VERIFY, { phone, code: '000000' }, { ip })
        .expect(429);
    });
  });

  describe('housekeeping', () => {
    it('purges stale codes and tokens but keeps recent ones', async () => {
      const day = 24 * 60 * 60 * 1000;
      const me = await loginAs(t, nextPhone()); // fresh token + fresh challenge
      const user = me.userId;
      const old = (days: number) => new Date(Date.now() - days * day);
      const row = (n: string) => ({
        userId: user,
        familyId: user,
        tokenHash: n.padEnd(64, '0'),
        expiresAt: old(-5),
      });

      await t.prisma.otpChallenge.create({
        data: {
          phone: nextPhone(),
          codeHash: 'x',
          expiresAt: old(2),
          createdAt: old(2),
        },
      });
      await t.prisma.refreshToken.createMany({
        data: [
          { ...row('expired-long-ago'), expiresAt: old(40) },
          { ...row('revoked-long-ago'), revokedAt: old(40) },
          { ...row('revoked-recently'), revokedAt: old(1) },
        ],
      });

      const result = await t.app.get(AuthCleanupService).purge();

      expect(result).toEqual({ otpChallenges: 1, refreshTokens: 2 });
      expect(await t.prisma.otpChallenge.count()).toBe(1); // the fresh login challenge
      expect(await t.prisma.refreshToken.count()).toBe(2); // login token + recently revoked
    });
  });
});
