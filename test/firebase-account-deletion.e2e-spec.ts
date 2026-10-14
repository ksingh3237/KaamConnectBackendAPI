// Account deletion proved with a fresh Firebase phone sign-in instead of an SMS code: Door A (DELETE /me) and
// Door B (a disabled person asks). The legacy `code` form is covered, unchanged, by account-deletion.e2e-spec.ts.

import { ConfigService } from '@nestjs/config';
import request from 'supertest';
import { seedReferenceData } from '../prisma/seed/reference-data.js';
import { api, createTestApp, freshIp, type TestApp } from './helpers/app.js';
import { resetDatabase } from './helpers/db.js';
import { nextPhone } from './helpers/factories.js';
import { V1 } from './helpers/fulfilment.js';
import { customerIn, postJob } from './helpers/marketplace.js';

const nowSec = () => Math.floor(Date.now() / 1000);

describe('account deletion with a Firebase phone sign-in (e2e)', () => {
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
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const deleteMe = (token: string, body: Record<string, unknown>) =>
    request(t.app.getHttpServer())
      .delete(`${V1}/me`)
      .set('X-Forwarded-For', freshIp())
      .set('Authorization', `Bearer ${token}`)
      .send(body);

  const userRow = (id: string) =>
    t.prisma.user.findUniqueOrThrow({ where: { id } });

  describe('Door A: DELETE /me', () => {
    it('deletes the account when the token proves the account’s own number, and ends the session', async () => {
      const me = await customerIn(t);
      const res = await deleteMe(me.accessToken, {
        firebaseIdToken: t.firebase.issue(me.phone),
        confirm: true,
      });
      expect(res.status, JSON.stringify(res.body)).toBe(204);

      const row = await userRow(me.userId);
      expect(row.deletedAt).not.toBeNull();
      expect(row.isActive).toBe(false);
      expect(row.phone).not.toBe(me.phone); // the number is freed
      await http.get(`${V1}/me`, { token: me.accessToken }).expect(403);
      await http
        .post(`${V1}/auth/refresh`, { refreshToken: me.refreshToken })
        .expect(401);
    });

    it('works for an account that was created by the Firebase sign-in itself', async () => {
      const phone = nextPhone();
      const login = await http
        .post(`${V1}/auth/firebase/verify`, {
          idToken: t.firebase.issue(phone),
        })
        .expect(200);
      await deleteMe(login.body.accessToken, {
        firebaseIdToken: t.firebase.issue(phone),
        confirm: true,
      }).expect(204);
      expect((await userRow(login.body.user.id)).deletedAt).not.toBeNull();
    });

    it('refuses a token for SOMEONE ELSE’s number (a stolen session is not enough): 403, nothing deleted', async () => {
      const me = await customerIn(t);
      const other = nextPhone();
      const res = await deleteMe(me.accessToken, {
        firebaseIdToken: t.firebase.issue(other),
        confirm: true,
      }).expect(403);
      expect(res.body.code).toBe('PHONE_MISMATCH');
      const row = await userRow(me.userId);
      expect(row.deletedAt).toBeNull();
      expect(row.phone).toBe(me.phone);
    });

    it('requires RECENT authentication: a token older than the window is refused, nothing deleted', async () => {
      const me = await customerIn(t);
      const res = await deleteMe(me.accessToken, {
        firebaseIdToken: t.firebase.issue(me.phone, {
          authTimeSec: nowSec() - 3000,
        }),
        confirm: true,
      }).expect(401);
      expect(res.body.code).toBe('FIREBASE_TOKEN_STALE');
      expect((await userRow(me.userId)).deletedAt).toBeNull();
    });

    it('refuses an invalid token, a non-phone sign-in and an unreachable Google, each without deleting', async () => {
      const me = await customerIn(t);
      const attempts: [Record<string, unknown>, number, string][] = [
        [
          { firebaseIdToken: `forged-${'f'.repeat(40)}` },
          401,
          'FIREBASE_TOKEN_INVALID',
        ],
        [
          {
            firebaseIdToken: t.firebase.issue(me.phone, {
              signInProvider: 'anonymous',
            }),
          },
          401,
          'FIREBASE_TOKEN_INVALID',
        ],
      ];
      for (const [body, status, code] of attempts) {
        const res = await deleteMe(me.accessToken, {
          ...body,
          confirm: true,
        }).expect(status);
        expect(res.body.code).toBe(code);
      }
      t.firebase.unavailableNext = true;
      await deleteMe(me.accessToken, {
        firebaseIdToken: t.firebase.issue(me.phone),
        confirm: true,
      }).expect(503);
      expect((await userRow(me.userId)).deletedAt).toBeNull();

      // and after all that, a good token still works (nothing was spent or locked)
      await deleteMe(me.accessToken, {
        firebaseIdToken: t.firebase.issue(me.phone),
        confirm: true,
      }).expect(204);
    });

    it('needs exactly one proof: neither, or both, is a 422 and changes nothing', async () => {
      const me = await customerIn(t);
      await deleteMe(me.accessToken, { confirm: true }).expect(422);

      await http.post(`${V1}/auth/otp/request`, { phone: me.phone });
      const code = t.sender.lastCode(me.phone);
      const both = await deleteMe(me.accessToken, {
        code,
        firebaseIdToken: t.firebase.issue(me.phone),
        confirm: true,
      }).expect(422);
      expect(JSON.stringify(both.body.details)).toContain('exactly one');

      // still needs the confirmation, and a plausible token
      await deleteMe(me.accessToken, {
        firebaseIdToken: t.firebase.issue(me.phone),
      }).expect(422);
      await deleteMe(me.accessToken, {
        firebaseIdToken: 'short',
        confirm: true,
      }).expect(422);
      expect(t.firebase.verified).toHaveLength(0);
      expect((await userRow(me.userId)).deletedAt).toBeNull();
    });

    it('an active job still blocks deletion, and that is decided before the token is even checked', async () => {
      const me = await customerIn(t);
      const job = await postJob(t, me);
      const res = await deleteMe(me.accessToken, {
        firebaseIdToken: t.firebase.issue(me.phone),
        confirm: true,
      }).expect(409);
      expect(res.body.code).toBe('ACTIVE_JOB_BLOCKS_DELETION');
      expect(JSON.stringify(res.body.details)).toContain(`job:${job.id}`);
      expect(t.firebase.verified).toHaveLength(0);
      expect((await userRow(me.userId)).deletedAt).toBeNull();
    });

    it('still needs a session: a token alone cannot delete anyone', async () => {
      const me = await customerIn(t);
      await http.delete(`${V1}/me`).expect(401);
      await request(t.app.getHttpServer())
        .delete(`${V1}/me`)
        .set('X-Forwarded-For', freshIp())
        .send({ firebaseIdToken: t.firebase.issue(me.phone), confirm: true })
        .expect(401);
      expect((await userRow(me.userId)).deletedAt).toBeNull();
    });

    it('with the legacy login switched off, the SMS-code form is refused (404) and the token form still works', async () => {
      const me = await customerIn(t);
      const config = t.app.get(ConfigService);
      const real = config.get.bind(config);
      vi.spyOn(config, 'get').mockImplementation(((
        key: string,
        opts?: unknown,
      ) =>
        key === 'LEGACY_OTP_ENABLED'
          ? false
          : real(key as never, opts as never)) as never);

      const viaCode = await deleteMe(me.accessToken, {
        code: '123456',
        confirm: true,
      }).expect(404);
      expect(viaCode.body.code).toBe('LEGACY_OTP_DISABLED');
      expect((await userRow(me.userId)).deletedAt).toBeNull();

      await deleteMe(me.accessToken, {
        firebaseIdToken: t.firebase.issue(me.phone),
        confirm: true,
      }).expect(204);
    });
  });

  describe('Door B: a disabled person asks for deletion', () => {
    const disabledUser = async () => {
      const me = await customerIn(t);
      await t.prisma.user.update({
        where: { id: me.userId },
        data: { isActive: false },
      });
      return me;
    };
    const ask = (body: Record<string, unknown>) =>
      http.post(`${V1}/auth/deletion-requests`, body);

    it('records the request from the token alone (the number comes from the token); deletes nothing', async () => {
      const me = await disabledUser();
      await ask({ firebaseIdToken: t.firebase.issue(me.phone) }).expect(202);
      const row = await userRow(me.userId);
      expect(row.deletionRequestedAt).not.toBeNull();
      expect(row.deletedAt).toBeNull();
    });

    it('also accepts the number alongside the token, and refuses one that does not match the token', async () => {
      const me = await disabledUser();
      await ask({
        phone: me.phone,
        firebaseIdToken: t.firebase.issue(me.phone),
      }).expect(202);
      expect((await userRow(me.userId)).deletionRequestedAt).not.toBeNull();

      const other = await disabledUser();
      const res = await ask({
        phone: other.phone,
        firebaseIdToken: t.firebase.issue(nextPhone()),
      }).expect(403);
      expect(res.body.code).toBe('PHONE_MISMATCH');
      expect((await userRow(other.userId)).deletionRequestedAt).toBeNull();
    });

    it('answers an active account and an unknown number exactly like a disabled one, and marks only the disabled one', async () => {
      const disabled = await disabledUser();
      const active = await customerIn(t);
      const unknown = nextPhone();
      const replies = [];
      for (const phone of [disabled.phone, active.phone, unknown]) {
        const res = await ask({ firebaseIdToken: t.firebase.issue(phone) });
        replies.push(JSON.stringify({ s: res.status, b: res.body }));
      }
      expect(new Set(replies).size).toBe(1);
      expect(replies[0]).toContain('202');
      expect(
        (await userRow(disabled.userId)).deletionRequestedAt,
      ).not.toBeNull();
      expect((await userRow(active.userId)).deletionRequestedAt).toBeNull();
    });

    it('needs a valid, fresh token: forged, stale and wrong-provider tokens record nothing', async () => {
      const me = await disabledUser();
      await ask({ firebaseIdToken: `forged-${'f'.repeat(40)}` }).expect(401);
      await ask({
        firebaseIdToken: t.firebase.issue(me.phone, {
          authTimeSec: nowSec() - 3000,
        }),
      }).expect(401);
      await ask({
        firebaseIdToken: t.firebase.issue(me.phone, {
          signInProvider: 'password',
        }),
      }).expect(401);
      expect((await userRow(me.userId)).deletionRequestedAt).toBeNull();
    });

    it('needs exactly one proof, and a phone with a code', async () => {
      const me = await disabledUser();
      await ask({}).expect(422);
      await ask({ phone: me.phone }).expect(422);
      await ask({ code: '123456' }).expect(422); // a code without a number
      await ask({
        phone: me.phone,
        code: '123456',
        firebaseIdToken: t.firebase.issue(me.phone),
      }).expect(422);
      expect((await userRow(me.userId)).deletionRequestedAt).toBeNull();
    });

    it('is throttled per address (5 per hour, as for the code form)', async () => {
      const ip = freshIp();
      for (let i = 0; i < 5; i += 1) {
        await http
          .post(
            `${V1}/auth/deletion-requests`,
            { firebaseIdToken: t.firebase.issue(nextPhone()) },
            { ip },
          )
          .expect(202);
      }
      await http
        .post(
          `${V1}/auth/deletion-requests`,
          { firebaseIdToken: t.firebase.issue(nextPhone()) },
          { ip },
        )
        .expect(429);
    });
  });
});
