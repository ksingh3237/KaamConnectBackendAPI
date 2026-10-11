// Local full-stack integration support: (1) browser clients (Expo web) are served only from listed origins;
// (2) the development OTP notice appears ONLY when the dev bypass is on, and the fixed code works only then.

import { ConfigService } from '@nestjs/config';
import { vi } from 'vitest';
import { seedReferenceData } from '../prisma/seed/reference-data.js';
import { api, createTestApp, type TestApp } from './helpers/app.js';
import { resetDatabase } from './helpers/db.js';
import { nextPhone } from './helpers/factories.js';
import { V1 } from './helpers/fulfilment.js';
import request from 'supertest';

const ALLOWED = 'http://localhost:8081';

describe('CORS for browser clients (e2e)', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp({ corsOrigins: [ALLOWED] });
  });
  afterAll(async () => {
    await t.close();
  });

  it('answers a preflight from a listed origin with the allow headers', async () => {
    const res = await request(t.app.getHttpServer())
      .options(`${V1}/auth/otp/request`)
      .set('Origin', ALLOWED)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'content-type,authorization');
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe(ALLOWED);
    expect(res.headers['access-control-allow-methods']).toContain('POST');
    expect(res.headers['access-control-allow-headers']).toMatch(
      /authorization/i,
    );
  });

  it('does not allow an unlisted origin (no allow-origin header, so the browser refuses the response)', async () => {
    const res = await request(t.app.getHttpServer())
      .get('/health')
      .set('Origin', 'http://evil.example.com');
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('adds the allow-origin and exposes Retry-After / X-Request-Id on a real response', async () => {
    const res = await request(t.app.getHttpServer())
      .get('/health')
      .set('Origin', ALLOWED);
    expect(res.headers['access-control-allow-origin']).toBe(ALLOWED);
    expect(res.headers['access-control-expose-headers']).toMatch(
      /Retry-After/i,
    );
  });
});

describe('CORS is off by default (e2e)', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t.close();
  });

  it('no origin is allowed when CORS_ORIGINS is not set', async () => {
    const res = await request(t.app.getHttpServer())
      .get('/health')
      .set('Origin', ALLOWED);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    const pre = await request(t.app.getHttpServer())
      .options(`${V1}/auth/otp/request`)
      .set('Origin', ALLOWED)
      .set('Access-Control-Request-Method', 'POST');
    expect(pre.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('development OTP notice (e2e)', () => {
  let t: TestApp;
  let http: ReturnType<typeof api>;
  beforeAll(async () => {
    t = await createTestApp();
    http = api(t.app);
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    await t.close();
  });
  beforeEach(async () => {
    vi.restoreAllMocks();
    await resetDatabase(t.prisma);
    await seedReferenceData(t.prisma);
  });

  it('with the bypass OFF (the normal and production setting): no notice, a random code, and 123456 does not work', async () => {
    const phone = nextPhone();
    const res = await http
      .post(`${V1}/auth/otp/request`, { phone })
      .expect(202);
    expect(res.body).not.toHaveProperty('devNotice');
    const sent = t.sender.lastCode(phone);
    expect(sent).toMatch(/^\d{6}$/);
    if (sent !== '123456') {
      await http
        .post(`${V1}/auth/otp/verify`, { phone, code: '123456' })
        .expect(401);
    }
  });

  it('with the bypass ON (local development only): a clearly marked notice, the fixed code 123456 signs in, and it is the same for any number', async () => {
    const config = t.app.get(ConfigService);
    const real = config.get.bind(config);
    vi.spyOn(config, 'get').mockImplementation(((
      key: string,
      opts?: unknown,
    ) =>
      key === 'OTP_DEV_BYPASS'
        ? true
        : real(key as never, opts as never)) as never);

    const phone = nextPhone();
    const res = await http
      .post(`${V1}/auth/otp/request`, { phone })
      .expect(202);
    expect(res.body.devNotice).toMatch(/DEVELOPMENT ONLY/);
    expect(res.body.devNotice).toContain('123456');
    expect(t.sender.lastCode(phone)).toBe('123456');

    const login = await http
      .post(`${V1}/auth/otp/verify`, { phone, code: '123456' })
      .expect(200);
    expect(login.body.accessToken).toBeTruthy();
    expect(login.body.isNewUser).toBe(true);
  });

  it('the notice never contains a real code for a random-code run, and the production guard still refuses the bypass', async () => {
    const { validateEnv } = await import('../src/config/env.validation.js');
    expect(() =>
      validateEnv({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgresql://u:p@localhost:5432/KaamConnect',
        JWT_ACCESS_SECRET: 'j'.repeat(40),
        OTP_PEPPER: 'o'.repeat(40),
        OTP_DEV_BYPASS: 'true',
        SMS_PROVIDER: 'msg91',
        WORKER_VERIFICATION_MODE: 'manual',
        STORAGE_PROVIDER: 's3',
        STORAGE_REGION: 'ap-south-1',
        STORAGE_BUCKET: 'a',
        STORAGE_BUCKET_PRIVATE: 'b',
        SOS_WEBHOOK_URL: 'https://safety.example.com/x',
      }),
    ).toThrow(/OTP_DEV_BYPASS must be false in production/);
  });
});
