// Masked request logging, end to end: the real HTTP stack, the real guards and the real logger, with whatever
// the application writes to stdout/stderr captured and inspected. The point is what must NOT be there: phone
// numbers, tokens, codes, query values, real ids and full client addresses.

import { vi } from 'vitest';
import { seedReferenceData } from '../prisma/seed/reference-data.js';
import { api, createTestApp, type TestApp } from './helpers/app.js';
import { resetDatabase } from './helpers/db.js';
import { nextPhone } from './helpers/factories.js';
import { V1, assigned } from './helpers/fulfilment.js';
import { customerIn, verifiedWorkerIn } from './helpers/marketplace.js';

const ANSI = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g');

describe('masked request logging (e2e)', () => {
  let t: TestApp;
  let http: ReturnType<typeof api>;
  let captured = '';

  beforeAll(async () => {
    t = await createTestApp({ requestLogging: true });
    http = api(t.app);
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await resetDatabase(t.prisma);
    await seedReferenceData(t.prisma);
    captured = '';
    const grab = (chunk: unknown) => {
      captured += String(chunk);
      return true;
    };
    vi.spyOn(process.stdout, 'write').mockImplementation(grab as never);
    vi.spyOn(process.stderr, 'write').mockImplementation(grab as never);
  });
  afterEach(() => vi.restoreAllMocks());

  /** What was logged, without terminal colours, one line per entry. */
  const logged = () =>
    captured
      .replace(ANSI, '')
      .split('\n')
      .filter((line) => line.includes(' HTTP]') || line.includes('[HTTP]'));
  const lastLine = () => logged().at(-1) ?? '';

  it('writes one line per request with the route template, status, timing, request id and user', async () => {
    const customer = await customerIn(t);
    const worker = await verifiedWorkerIn(t);
    const { job } = await assigned(t, customer, worker);
    captured = '';

    const res = await http
      .get(`${V1}/jobs/${job.id}/bill`, { token: customer.accessToken })
      .expect(200);
    expect(logged()).toHaveLength(1);
    expect(lastLine()).toMatch(
      new RegExp(
        `GET ${V1.replace(/\//g, '\\/')}\\/jobs\\/:id\\/bill 200 \\d+ms req=${res.headers['x-request-id']} user=${customer.userId} ip=\\d+\\.\\d+\\.\\d+\\.x$`,
      ),
    );
    // The real job id never appears: the log shows the route, not the address.
    expect(captured).not.toContain(job.id);
  });

  it('uses a request id supplied by a proxy when it is plain, and replaces one that could forge log lines', async () => {
    const good = await http.get(`${V1}/service-categories`, { token: 'x' });
    expect(good.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);

    const supplied = await api(t.app)
      .get(`${V1}/leads`)
      .set('X-Request-Id', 'edge-proxy-0001')
      .set('X-Forwarded-For', '203.0.113.9');
    expect(supplied.headers['x-request-id']).toBe('edge-proxy-0001');
    expect(lastLine()).toContain('req=edge-proxy-0001');

    const forged = await api(t.app)
      .get(`${V1}/leads`)
      .set('X-Request-Id', 'abc-def-1234 user=admin FAKE LINE')
      .set('X-Forwarded-For', '203.0.113.9');
    expect(forged.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(captured).not.toContain('FAKE LINE');
  });

  it('logs the refusals a guard makes before any controller runs: 401, 403, 404 and 429', async () => {
    const customer = await customerIn(t);
    await http.get(`${V1}/leads`).expect(401);
    await http.get(`${V1}/leads`, { token: customer.accessToken }).expect(403);
    await http
      .get(`${V1}/no/such/route`, { token: customer.accessToken })
      .expect(404);
    const phone = nextPhone();
    for (let i = 0; i < 6; i++)
      await http.post(
        `${V1}/auth/otp/request`,
        { phone },
        { ip: '198.51.100.7' },
      );

    const lines = logged();
    const statuses = lines.map((l) => /\s(\d{3}) \d+ms/.exec(l)?.[1]);
    expect(statuses).toEqual(
      expect.arrayContaining(['401', '403', '404', '429']),
    );
    // The route nobody registered is logged as such, never echoed back.
    expect(lines.some((l) => l.includes('(unmatched) 404'))).toBe(true);
    expect(captured).not.toContain('/no/such/route');
    // Warnings, not info: refusals stand out.
    const refusals = lines.filter((l) => /\s(401|403|404|429)\s\d+ms/.test(l));
    expect(refusals.length).toBeGreaterThanOrEqual(4);
    expect(refusals.filter((l) => !/WARN/.test(l))).toEqual([]);
  });

  it('never writes phone numbers, tokens, codes, query values or the full client address', async () => {
    const phone = nextPhone();
    await http
      .post(`${V1}/auth/otp/request`, { phone }, { ip: '203.0.113.77' })
      .expect(202);
    const code = t.sender.lastCode(phone);
    const login = await http
      .post(`${V1}/auth/otp/verify`, { phone, code }, { ip: '203.0.113.77' })
      .expect(200);
    const customer = await customerIn(t);
    const worker = await verifiedWorkerIn(t);
    const made = await assigned(t, customer, worker);
    await http.post(
      `${V1}/jobs/${made.job.id}/arrival`,
      { code: made.code },
      { token: worker.accessToken, ip: '203.0.113.77' },
    );
    await http.get(
      `${V1}/workers?cursor=SECRET-CURSOR-VALUE&q=private-search`,
      {
        token: customer.accessToken,
        ip: '203.0.113.77',
      },
    );

    const text = captured.replace(ANSI, '');
    expect(text).toContain('HTTP]'); // something was logged at all
    const mustNotAppear = [
      phone, // the number that was sent in the body
      phone.replace('+91', ''), // the same number without the prefix
      code, // the one-time code that was sent
      login.body.accessToken, // the tokens that were issued
      login.body.refreshToken,
      customer.accessToken,
      worker.accessToken, // the Authorization header
      made.code, // the arrival code in the body
      'SECRET-CURSOR-VALUE', // query values
      'private-search',
      '203.0.113.77', // the full client address
    ];
    for (const secret of mustNotAppear)
      expect([secret.slice(0, 12), text.includes(secret)]).toEqual([
        secret.slice(0, 12),
        false,
      ]);
    // The masked address is there instead.
    expect(text).toContain('ip=203.0.113.x');
  });

  it('does not log the health probes', async () => {
    await http.get('/health').expect(200);
    expect(logged()).toEqual([]);
  });

  it('is off when asked (the e2e default), so a log line is a deliberate thing', async () => {
    const quiet = await createTestApp(); // requestLogging defaults to false here
    try {
      captured = '';
      await api(quiet.app).get(`${V1}/leads`).expect(401);
      expect(logged()).toEqual([]);
    } finally {
      await quiet.close();
    }
  });
});
