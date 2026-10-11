import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { maskIp } from './redact.js';

/** Header the app and any proxy in front of it can use to follow one request through the logs. */
export const REQUEST_ID_HEADER = 'x-request-id';

/** A caller-supplied id is only kept if it is plain and short, so it cannot forge log lines. */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{8,64}$/;

export type RequestWithId = Request & {
  requestId?: string;
  user?: { id?: string };
};

export function pickRequestId(supplied: string | undefined): string {
  return supplied && SAFE_REQUEST_ID.test(supplied) ? supplied : randomUUID();
}

/** The catch-all routes Express 5 / Nest use to answer a 404. */
const NOT_FOUND_ROUTES = ['*path', '*', '/*path'];

/** Probes would drown the log. */
const QUIET_PATHS = ['/health', '/health/ready'];

/** The level for a response: client errors are warnings, server errors are errors. */
export function levelFor(status: number): 'log' | 'warn' | 'error' {
  if (status >= 500) return 'error';
  if (status >= 400) return 'warn';
  return 'log';
}

/**
 * One line per finished request:
 *   `GET /api/v1/jobs/:id/bill 200 12ms req=<id> user=<id> ip=203.0.113.x`
 *
 * It is middleware and not an interceptor on purpose: guards run before interceptors, so an interceptor never
 * sees the requests that matter most for security (401 without a token, 403, 429 from the throttler, 404 for an
 * unknown route).
 *
 * What it records is deliberately small: the route TEMPLATE (never the real ids or the query string), the
 * status, the time, the request id, the user id (an opaque UUID), and the client address with its last part
 * blanked. It never touches the body, the headers (so no Authorization), cookies or query values.
 */
export function requestLogger() {
  const logger = new Logger('HTTP');
  return (req: RequestWithId, res: Response, next: NextFunction): void => {
    const started = process.hrtime.bigint();
    const requestId = pickRequestId(req.header(REQUEST_ID_HEADER));
    req.requestId = requestId;
    res.setHeader('X-Request-Id', requestId);

    res.on('finish', () => {
      if (QUIET_PATHS.includes(req.path)) return;
      const ms = Number(process.hrtime.bigint() - started) / 1_000_000;
      // The matched route pattern, e.g. /api/v1/jobs/:id; unmatched requests are not echoed back (an
      // attacker chooses that text).
      const route = (req.route as { path?: unknown } | undefined)?.path;
      // Nest answers a path no controller owns with a catch-all route; that is "unmatched" too.
      const where =
        typeof route === 'string' && !NOT_FOUND_ROUTES.includes(route)
          ? route
          : '(unmatched)';
      logger[levelFor(res.statusCode)](
        `${req.method} ${where} ${res.statusCode} ${ms.toFixed(0)}ms req=${requestId} user=${req.user?.id ?? '-'} ip=${maskIp(req.ip)}`,
      );
    });
    next();
  };
}
