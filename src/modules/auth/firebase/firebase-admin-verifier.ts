import { Logger } from '@nestjs/common';
import { cert, getApp, initializeApp, type App } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { AppException } from '../../../common/exceptions/app.exception.js';
import {
  FirebaseTokenVerifier,
  type FirebaseClaims,
} from './firebase-verifier.js';

/** A named app, so this never collides with a default Firebase app if one is ever added. */
const APP_NAME = 'kaamconnect-auth';

/** Admin SDK error codes that mean "this token is not acceptable" (the person's problem, not ours). */
const BAD_TOKEN_CODES = new Set([
  'auth/argument-error',
  'auth/invalid-id-token',
  'auth/id-token-expired',
  'auth/id-token-revoked',
]);

export interface ServiceAccountJson {
  project_id: string;
  client_email: string;
  private_key: string;
}

/**
 * Reads and checks the service-account JSON. Throws a message that names the problem but NEVER includes any of the
 * file's content, so a malformed secret cannot end up in a log.
 */
export function parseServiceAccount(raw: string): ServiceAccountJson {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      'The Firebase service-account credentials are not valid JSON',
    );
  }
  const record = (parsed ?? {}) as Record<string, unknown>;
  for (const key of ['project_id', 'client_email', 'private_key']) {
    if (typeof record[key] !== 'string' || record[key] === '') {
      throw new Error(
        `The Firebase service-account credentials are missing "${key}"`,
      );
    }
  }
  return {
    project_id: record.project_id as string,
    client_email: record.client_email as string,
    private_key: record.private_key as string,
  };
}

/** Verifies tokens with the Firebase Admin SDK. The credentials never leave this process. */
export class FirebaseAdminVerifier extends FirebaseTokenVerifier {
  private readonly logger = new Logger(FirebaseAdminVerifier.name);
  private readonly app: App;

  constructor(credentials: ServiceAccountJson) {
    super();
    let existing: App | undefined;
    try {
      existing = getApp(APP_NAME);
    } catch {
      existing = undefined;
    }
    this.app =
      existing ??
      initializeApp(
        {
          credential: cert({
            projectId: credentials.project_id,
            clientEmail: credentials.client_email,
            privateKey: credentials.private_key,
          }),
        },
        APP_NAME,
      );
  }

  async verify(idToken: string): Promise<FirebaseClaims> {
    try {
      // checkRevoked stays off: it costs a Firebase round trip per login, and the freshness window plus our own
      // account switch (users.is_active) already bound what a leaked token can do.
      const decoded = await getAuth(this.app).verifyIdToken(idToken, false);
      return {
        uid: decoded.uid,
        phoneNumber: decoded.phone_number,
        signInProvider: decoded.firebase?.sign_in_provider,
        authTimeSec: decoded.auth_time,
      };
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (typeof code === 'string' && BAD_TOKEN_CODES.has(code)) {
        throw new AppException(
          'FIREBASE_TOKEN_INVALID',
          401,
          'The phone verification could not be confirmed',
        );
      }
      // Log the SDK's code only: its message can quote parts of the token.
      this.logger.error(
        `Firebase token check failed (${typeof code === 'string' ? code : 'unknown error'})`,
      );
      throw new AppException(
        'FIREBASE_UNAVAILABLE',
        503,
        'Phone verification is temporarily unavailable; please try again',
      );
    }
  }
}
