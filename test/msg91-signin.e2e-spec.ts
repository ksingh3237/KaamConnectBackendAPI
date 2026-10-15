import { seedReferenceData } from '../prisma/seed/reference-data.js';
import { api, createTestApp, freshIp, type TestApp } from './helpers/app.js';
import { resetDatabase } from './helpers/db.js';
import { nextPhone } from './helpers/factories.js';

const VERIFY = '/api/v1/auth/msg91/verify';
const ME = '/api/v1/me';

describe('MSG91 widget sign-in (e2e, real PostgreSQL, MSG91 replaced by a fake)', () => {
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
    t.msg91.down = false;
    t.msg91.calls = 0;
  });

  it('creates the account for the number MSG91 vouches for and starts a working session', async () => {
    const phone = nextPhone();
    const res = await http
      .post(VERIFY, { accessToken: t.msg91.issue(phone) })
      .expect(200);

    expect(res.body).toMatchObject({
      isNewUser: true,
      user: { phone, hasCustomerProfile: false, hasWorkerProfile: false },
    });
    expect(res.body.accessToken).toBeTruthy();
    expect(res.body.refreshToken).toBeTruthy();
    await http.get(ME, { token: res.body.accessToken as string }).expect(200);
  });

  it('signs an existing user in again without creating a second account', async () => {
    const phone = nextPhone();
    await http.post(VERIFY, { accessToken: t.msg91.issue(phone) }).expect(200);
    const second = await http
      .post(VERIFY, { accessToken: t.msg91.issue(phone) })
      .expect(200);

    expect(second.body.isNewUser).toBe(false);
    expect(await t.prisma.user.count({ where: { phone } })).toBe(1);
  });

  it('takes the number only from MSG91: a phone sent by the app is rejected, not trusted', async () => {
    const victim = nextPhone();
    const attacker = nextPhone();
    const res = await http
      .post(VERIFY, { accessToken: t.msg91.issue(attacker), phone: victim })
      .expect(422); // unknown field, whitelist validation
    expect(res.body).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(await t.prisma.user.count({ where: { phone: victim } })).toBe(0);
  });

  it('refuses a token MSG91 does not recognise, and creates nothing', async () => {
    const res = await http
      .post(VERIFY, { accessToken: 'x'.repeat(40) })
      .expect(401);
    expect(res.body).toMatchObject({ code: 'OTP_INVALID' });
    expect(await t.prisma.user.count()).toBe(0);
  });

  it('refuses a missing or malformed token with 422 before asking MSG91', async () => {
    await http.post(VERIFY, {}).expect(422);
    await http.post(VERIFY, { accessToken: 'short' }).expect(422);
    await http.post(VERIFY, { accessToken: 12345 }).expect(422);
    expect(t.msg91.calls).toBe(0);
  });

  it('reports MSG91 being unreachable as 503, not as a wrong code', async () => {
    t.msg91.down = true;
    const res = await http
      .post(VERIFY, { accessToken: 'x'.repeat(40) })
      .expect(503);
    expect(res.body).toMatchObject({ code: 'OTP_PROVIDER_UNAVAILABLE' });
  });

  it('does not sign in a disabled account', async () => {
    const phone = nextPhone();
    await http.post(VERIFY, { accessToken: t.msg91.issue(phone) }).expect(200);
    await t.prisma.user.update({ where: { phone }, data: { isActive: false } });

    const res = await http
      .post(VERIFY, { accessToken: t.msg91.issue(phone) })
      .expect(403);
    expect(res.body).toMatchObject({ code: 'ACCOUNT_DISABLED' });
  });

  it('is rate limited per client IP', async () => {
    const ip = freshIp();
    let limited = 0;
    for (let i = 0; i < 32; i += 1) {
      const res = await http.post(
        VERIFY,
        { accessToken: 'x'.repeat(40) },
        { ip },
      );
      if (res.status === 429) limited += 1;
    }
    expect(limited).toBeGreaterThan(0);
  });
});
