import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { configureApp } from '../../src/app.setup.js';
import { USER_RATE_LIMIT } from '../../src/common/throttle/user-throttler.guard.js';
import type { OtpChannel } from '../../src/generated/prisma/enums.js';
import { OtpSender } from '../../src/modules/auth/sms/otp-sender.js';
import {
  SafetyNotifier,
  type SosNotification,
} from '../../src/modules/safety/safety-notifier.js';
import { WORKER_VERIFICATION_MODE } from '../../src/modules/workers/worker-verification.service.js';
import { PrismaService } from '../../src/prisma/prisma.service.js';

export interface SentOtp {
  phone: string;
  code: string;
  channel: OtpChannel;
}

/** Stands in for the SMS provider: remembers what would have been sent. */
export class RecordingOtpSender extends OtpSender {
  sent: SentOtp[] = [];
  failNext = false;

  send(phone: string, code: string, channel: OtpChannel): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      return Promise.reject(new Error('provider down'));
    }
    this.sent.push({ phone, code, channel });
    return Promise.resolve();
  }

  lastCode(phone: string): string {
    const found = [...this.sent].reverse().find((s) => s.phone === phone);
    if (!found) throw new Error(`No OTP was sent to ${phone}`);
    return found.code;
  }
}

/** Stands in for the safety desk: remembers every SOS it was asked to deliver. */
export class RecordingSafetyNotifier extends SafetyNotifier {
  sent: SosNotification[] = [];
  fail = false;

  notify(notification: SosNotification): Promise<void> {
    if (this.fail) return Promise.reject(new Error('desk unreachable'));
    this.sent.push(notification);
    return Promise.resolve();
  }
}

let ipCounter = 0;
/** A fresh client IP per test, so per-IP rate limits never leak between tests (TRUST_PROXY=1). */
export function freshIp(): string {
  ipCounter += 1;
  return `10.${(ipCounter >> 16) & 255}.${(ipCounter >> 8) & 255}.${ipCounter & 255}`;
}

export interface TestApp {
  app: INestApplication;
  prisma: PrismaService;
  sender: RecordingOtpSender;
  safety: RecordingSafetyNotifier;
  close: () => Promise<void>;
}

/**
 * The real application (real HTTP config, real database); only the SMS provider is replaced.
 * `verificationMode` defaults to the production behaviour ('manual'); pass 'auto' to exercise the
 * development shortcut.
 */
export async function createTestApp(
  options: {
    verificationMode?: 'auto' | 'manual';
    /** Off by default: one log line per request would drown the test output. */
    requestLogging?: boolean;
    /** Lowers the per-user rate limit (requests per minute) for a spec that tests it. */
    userRateLimitPerMin?: number;
    /** Origins allowed to call the HTTP API from a browser (CORS) for a spec that tests it. */
    corsOrigins?: string[];
  } = {},
): Promise<TestApp> {
  const sender = new RecordingOtpSender();
  const safety = new RecordingSafetyNotifier();
  let builder = Test.createTestingModule({ imports: [AppModule] });
  if (options.userRateLimitPerMin !== undefined)
    builder = builder
      .overrideProvider(USER_RATE_LIMIT)
      .useValue({ limit: options.userRateLimitPerMin, windowMs: 60_000 });
  const moduleRef = await builder
    .overrideProvider(OtpSender)
    .useValue(sender)
    .overrideProvider(SafetyNotifier)
    .useValue(safety)
    .overrideProvider(WORKER_VERIFICATION_MODE)
    .useValue(options.verificationMode ?? 'manual')
    .compile();

  const app = moduleRef.createNestApplication();
  configureApp(app, {
    requestLogging: options.requestLogging ?? false,
    ...(options.corsOrigins ? { corsOrigins: options.corsOrigins } : {}),
  });
  // Listen once on an ephemeral port so supertest reuses it instead of re-listening per request.
  await app.listen(0, '127.0.0.1');
  return {
    app,
    prisma: app.get(PrismaService),
    sender,
    safety,
    close: () => app.close(),
  };
}

export interface CallOptions {
  ip?: string;
  token?: string;
}

/** Thin supertest wrapper: adds the client IP and bearer token headers. */
export function api(app: INestApplication) {
  const server = app.getHttpServer();
  const decorate = (req: request.Test, { ip, token }: CallOptions) => {
    req.set('X-Forwarded-For', ip ?? freshIp());
    if (token) req.set('Authorization', `Bearer ${token}`);
    return req;
  };
  return {
    get: (path: string, opts: CallOptions = {}) =>
      decorate(request(server).get(path), opts),
    post: (path: string, body: object = {}, opts: CallOptions = {}) =>
      decorate(request(server).post(path), opts).send(body),
    put: (path: string, body: object = {}, opts: CallOptions = {}) =>
      decorate(request(server).put(path), opts).send(body),
    delete: (path: string, opts: CallOptions = {}) =>
      decorate(request(server).delete(path), opts),
    patch: (path: string, body: object = {}, opts: CallOptions = {}) =>
      decorate(request(server).patch(path), opts).send(body),
  };
}
