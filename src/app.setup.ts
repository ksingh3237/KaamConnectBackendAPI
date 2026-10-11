import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter.js';
import { MaskingLogger } from './common/logging/masking-logger.js';
import { requestLogger } from './common/logging/request-logger.js';
import { createValidationPipe } from './common/pipes/validation.pipe.js';
import type { EnvVars } from './config/env.validation.js';
import {
  RealtimeIoAdapter,
  parseOrigins,
} from './modules/realtime/realtime-io.adapter.js';

export const API_PREFIX = 'api/v1';

export interface ConfigureOptions {
  /** Overrides CORS_ORIGINS (tests). */
  corsOrigins?: string[];
  /** One masked log line per finished request. On for the real server; the e2e suite turns it off to keep its output readable. */
  requestLogging?: boolean;
}

/** Shared by main.ts and the e2e tests so tests run against the real HTTP configuration. */
export function configureApp(
  app: INestApplication,
  options: ConfigureOptions = {},
): void {
  const config = app.get<ConfigService<EnvVars, true>>(ConfigService);

  // Every log line, from any service or from Nest itself, is masked on its way out (phones, tokens).
  app.useLogger(new MaskingLogger());

  // Behind a load balancer the socket peer is the balancer; trust its X-Forwarded-For so rate
  // limits apply per real client. 0 (default) = no proxy, header ignored (cannot be spoofed).
  const hops = config.get('TRUST_PROXY', { infer: true });
  if (hops > 0) {
    (app as NestExpressApplication).set('trust proxy', hops);
  }

  // After `trust proxy` (so the client address is the real one) and before everything that can refuse a request.
  if (options.requestLogging ?? true) app.use(requestLogger());
  app.use(helmet());
  // Browser clients (Expo web) are only served when their exact origin is listed; the default is none.
  const corsOrigins =
    options.corsOrigins ??
    parseOrigins(config.get('CORS_ORIGINS', { infer: true }));
  if (corsOrigins.length > 0) {
    app.enableCors({
      origin: corsOrigins,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Authorization', 'Content-Type', 'X-Request-Id'],
      exposedHeaders: ['X-Request-Id', 'Retry-After'],
      credentials: false,
      maxAge: 600,
    });
  }
  app.setGlobalPrefix(API_PREFIX, { exclude: ['health', 'health/ready'] });
  app.useGlobalPipes(createValidationPipe());
  app.useGlobalFilters(new AllExceptionsFilter());
  app.useWebSocketAdapter(
    new RealtimeIoAdapter(
      app,
      parseOrigins(config.get('REALTIME_CORS_ORIGINS', { infer: true })),
    ),
  );
  app.enableShutdownHooks();
}
