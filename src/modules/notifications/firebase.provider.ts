import { Logger, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getMessaging, type Messaging } from 'firebase-admin/messaging';
import type { EnvVars } from '../../config/env.validation.js';
import { safeReason } from './redact.js';

export const FIREBASE_MESSAGING = Symbol('FIREBASE_MESSAGING');

/**
 * The service-account JSON may be pasted as-is or base64-encoded (easier in a single-line secret store).
 * Returns null for anything that is not a JSON object.
 */
export function parseServiceAccount(
  raw: string,
): Record<string, unknown> | null {
  const text = raw.trim().startsWith('{')
    ? raw
    : Buffer.from(raw, 'base64').toString('utf8');
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Firebase Cloud Messaging, or null when no credentials are configured (push is then skipped, the inbox still works). */
export const firebaseMessagingProvider: Provider = {
  provide: FIREBASE_MESSAGING,
  inject: [ConfigService],
  useFactory: (config: ConfigService<EnvVars, true>): Messaging | null => {
    const logger = new Logger('Firebase');
    const raw = config.get('FIREBASE_SERVICE_ACCOUNT', { infer: true });
    if (!raw) {
      logger.warn(
        'FIREBASE_SERVICE_ACCOUNT is not set: push notifications are disabled (the in-app inbox still works)',
      );
      return null;
    }
    const account = parseServiceAccount(raw);
    if (!account) {
      logger.error(
        'FIREBASE_SERVICE_ACCOUNT is not valid JSON (or base64 of JSON): push notifications are disabled',
      );
      return null;
    }
    try {
      const app =
        getApps()[0] ??
        initializeApp({
          credential: cert(account as Parameters<typeof cert>[0]),
        });
      return getMessaging(app);
    } catch (error) {
      logger.error(`Firebase could not start: ${safeReason(error)}`);
      return null;
    }
  },
};
