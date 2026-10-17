import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { configureApp } from '../../src/app.setup.js';
import { USER_RATE_LIMIT } from '../../src/common/throttle/user-throttler.guard.js';
import type { OtpChannel } from '../../src/generated/prisma/enums.js';
import { AppException } from '../../src/common/exceptions/app.exception.js';
import { FIREBASE_MESSAGING } from '../../src/modules/notifications/firebase.provider.js';
import { Msg91TokenVerifier } from '../../src/modules/auth/msg91/msg91-token-verifier.js';
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

/**
 * Stands in for MSG91's token check. `issue(phone)` mints a token that verifies to that number; anything else is
 * refused the way the real verifier refuses (OTP_INVALID), so tests cannot pass with a made-up token.
 */
export class FakeMsg91Verifier extends Msg91TokenVerifier {
  private readonly issued = new Map<string, string>();
  down = false;
  calls = 0;

  issue(phone: string): string {
    const token = `fake-msg91-token-${this.issued.size}-${phone.slice(-4)}-xxxxxxxx`;
    this.issued.set(token, phone);
    return token;
  }

  verify(accessToken: string): Promise<string> {
    this.calls += 1;
    if (this.down)
      return Promise.reject(
        new AppException('OTP_PROVIDER_UNAVAILABLE', 503, 'down'),
      );
    const phone = this.issued.get(accessToken);
    if (!phone)
      return Promise.reject(new AppException('OTP_INVALID', 401, 'invalid'));
    return Promise.resolve(phone);
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

/** What the fake Firebase was asked to send, and how it should answer. */
export interface SentMulticast {
  tokens: string[];
  notification: { title: string; body: string };
  data: Record<string, string>;
}

/**
 * Stands in for Firebase Cloud Messaging so no test can ever reach the real service. By default every token
 * succeeds; `replies` maps a token to an FCM error code, and `throwNext` makes the whole call fail.
 */
export class RecordingMessaging {
  sent: SentMulticast[] = [];
  replies = new Map<string, string>();
  throwNext: Error | null = null;

  sendEachForMulticast(message: SentMulticast) {
    if (this.throwNext) {
      const error = this.throwNext;
      this.throwNext = null;
      return Promise.reject(error);
    }
    this.sent.push(message);
    const responses = message.tokens.map((token) => {
      const code = this.replies.get(token);
      return code
        ? { success: false, error: { code } }
        : { success: true, messageId: 'm-' + token.slice(0, 6) };
    });
    return Promise.resolve({
      responses,
      successCount: responses.filter((r) => r.success).length,
      failureCount: responses.filter((r) => !r.success).length,
    });
  }

  reset(): void {
    this.sent = [];
    this.replies.clear();
    this.throwNext = null;
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
  msg91: FakeMsg91Verifier;
  safety: RecordingSafetyNotifier;
  messaging: RecordingMessaging;
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
  const msg91 = new FakeMsg91Verifier();
  const messaging = new RecordingMessaging();
  let builder = Test.createTestingModule({ imports: [AppModule] });
  if (options.userRateLimitPerMin !== undefined)
    builder = builder
      .overrideProvider(USER_RATE_LIMIT)
      .useValue({ limit: options.userRateLimitPerMin, windowMs: 60_000 });
  const moduleRef = await builder
    .overrideProvider(OtpSender)
    .useValue(sender)
    .overrideProvider(Msg91TokenVerifier)
    .useValue(msg91)
    .overrideProvider(SafetyNotifier)
    .useValue(safety)
    .overrideProvider(FIREBASE_MESSAGING)
    .useValue(messaging)
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
    msg91,
    safety,
    messaging,
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
