import { EventEmitter } from 'node:events';
import { Logger } from '@nestjs/common';
import { vi } from 'vitest';
import {
  levelFor,
  pickRequestId,
  requestLogger,
  type RequestWithId,
} from './request-logger.js';

describe('pickRequestId', () => {
  it('keeps a plain id supplied by a proxy or the app', () => {
    expect(pickRequestId('abc-123_DEF.456')).toBe('abc-123_DEF.456');
  });

  it('replaces anything that could forge or break a log line', () => {
    for (const bad of [
      'short',
      'has space in it',
      'abc\nFAKE LOG LINE req=x',
      'x'.repeat(65),
      '<script>alert(1)</script>',
      '',
      undefined,
    ])
      expect(pickRequestId(bad)).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('levelFor', () => {
  it('logs success quietly, client errors as warnings and server errors as errors', () => {
    expect([200, 201, 304].map(levelFor)).toEqual(['log', 'log', 'log']);
    expect([400, 401, 403, 404, 429].map(levelFor)).toEqual(
      Array(5).fill('warn'),
    );
    expect([500, 503].map(levelFor)).toEqual(['error', 'error']);
  });
});

describe('requestLogger middleware', () => {
  const lines: { level: string; text: string }[] = [];
  beforeEach(() => {
    lines.length = 0;
    for (const level of ['log', 'warn', 'error'] as const)
      vi.spyOn(Logger.prototype, level).mockImplementation(((
        message: string,
      ) => {
        lines.push({ level, text: String(message) });
      }) as never);
  });
  afterEach(() => vi.restoreAllMocks());

  function run(options: {
    method?: string;
    path?: string;
    route?: string;
    status?: number;
    ip?: string;
    user?: string;
    header?: string;
  }) {
    const headers: Record<string, string> = {};
    const res = Object.assign(new EventEmitter(), {
      statusCode: options.status ?? 200,
      setHeader: (name: string, value: string) => {
        headers[name] = value;
      },
    });
    const req = {
      method: options.method ?? 'GET',
      path: options.path ?? '/api/v1/jobs/abc',
      ip: options.ip ?? '203.0.113.77',
      route: options.route ? { path: options.route } : undefined,
      user: options.user ? { id: options.user } : undefined,
      header: () => options.header,
    } as unknown as RequestWithId;
    let nextCalled = false;
    requestLogger()(req, res as never, () => {
      nextCalled = true;
    });
    res.emit('finish');
    return { req, headers, nextCalled };
  }

  it('writes one line per request: the route template, status, time, request id, user and a masked address', () => {
    const { headers, req, nextCalled } = run({
      route: '/api/v1/jobs/:id/bill',
      status: 200,
      user: 'user-uuid-1',
    });
    expect(nextCalled).toBe(true);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.level).toBe('log');
    expect(lines[0]!.text).toMatch(
      /^GET \/api\/v1\/jobs\/:id\/bill 200 \d+ms req=[0-9a-f-]{36} user=user-uuid-1 ip=203\.0\.113\.x$/,
    );
    expect(headers['X-Request-Id']).toBe(req.requestId);
    expect(lines[0]!.text).toContain(`req=${req.requestId}`);
  });

  it('never writes the real path, so ids and query strings stay out of the log', () => {
    run({
      path: '/api/v1/jobs/0197a0c0-0000-7000-8000-000000000000/bill?phone=9876543210',
      route: '/api/v1/jobs/:id/bill',
    });
    expect(lines[0]!.text).not.toMatch(/0197a0c0|9876543210|phone=/);
  });

  it('does not echo the text of a request that matched no route', () => {
    run({ path: '/wp-login.php?x=<script>', status: 404 });
    expect(lines[0]!.level).toBe('warn');
    expect(lines[0]!.text).toContain('(unmatched) 404');
    expect(lines[0]!.text).not.toMatch(/wp-login|script/);
  });

  it('reports the framework\x27s catch-all 404 route as unmatched too', () => {
    run({ route: '*path', status: 404 });
    expect(lines[0]!.text).toContain('(unmatched) 404');
    expect(lines[0]!.text).not.toContain('*path');
  });

  it('logs refused requests too, at warning level, and server errors as errors', () => {
    run({ route: '/api/v1/jobs/:id', status: 401 });
    run({ route: '/api/v1/jobs/:id', status: 403 });
    run({ route: '/api/v1/auth/otp/request', status: 429 });
    run({ route: '/api/v1/jobs', status: 500 });
    expect(lines.map((l) => l.level)).toEqual([
      'warn',
      'warn',
      'warn',
      'error',
    ]);
    expect(lines.map((l) => l.text.split(' ')[2])).toEqual([
      '401',
      '403',
      '429',
      '500',
    ]);
  });

  it('shows "-" when nobody is signed in, and keeps a caller-supplied id only if it is safe', () => {
    run({ route: '/api/v1/leads', status: 401, header: 'proxy-request-0001' });
    expect(lines[0]!.text).toContain('req=proxy-request-0001 user=-');
    run({ route: '/api/v1/leads', status: 401, header: 'bad id\nFAKE' });
    expect(lines[1]!.text).not.toContain('FAKE');
  });

  it('stays silent for the health probes', () => {
    run({ path: '/health', route: '/health' });
    run({ path: '/health/ready', route: '/health/ready' });
    expect(lines).toEqual([]);
  });
});
