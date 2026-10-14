import { readFileSync } from 'node:fs';
import type { Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppException } from '../../../common/exceptions/app.exception.js';
import type { EnvVars } from '../../../config/env.validation.js';
import {
  FirebaseAdminVerifier,
  parseServiceAccount,
} from './firebase-admin-verifier.js';
import {
  FirebaseTokenVerifier,
  type FirebaseClaims,
} from './firebase-verifier.js';

/** Used when Firebase sign-in is switched off: every attempt gets a clear refusal and nothing is trusted. */
export class DisabledFirebaseVerifier extends FirebaseTokenVerifier {
  verify(): Promise<FirebaseClaims> {
    return Promise.reject(
      new AppException(
        'FIREBASE_AUTH_NOT_CONFIGURED',
        501,
        'Firebase phone sign-in is not enabled on this server',
      ),
    );
  }
}

/**
 * Chooses the verifier at startup. When FIREBASE_AUTH_ENABLED=true and the credentials cannot be read or are
 * malformed, this throws and the server does not start: failing closed beats a login that silently accepts or
 * refuses everyone.
 */
export const firebaseVerifierProvider: Provider = {
  provide: FirebaseTokenVerifier,
  inject: [ConfigService],
  useFactory: (config: ConfigService<EnvVars, true>): FirebaseTokenVerifier => {
    if (!config.get('FIREBASE_AUTH_ENABLED', { infer: true })) {
      return new DisabledFirebaseVerifier();
    }
    const path = config.get('FIREBASE_SERVICE_ACCOUNT_PATH', { infer: true });
    const encoded = config.get('FIREBASE_SERVICE_ACCOUNT_JSON_BASE64', {
      infer: true,
    });

    let raw: string;
    if (path) {
      try {
        raw = readFileSync(path, 'utf8');
      } catch {
        // The path is not a secret, but the OS error text is not needed either.
        throw new Error(
          `FIREBASE_SERVICE_ACCOUNT_PATH (${path}) could not be read`,
        );
      }
    } else if (encoded) {
      raw = Buffer.from(encoded, 'base64').toString('utf8');
    } else {
      // Config validation already refuses this; kept so the provider is safe on its own.
      throw new Error('Firebase sign-in is enabled but has no credentials');
    }
    return new FirebaseAdminVerifier(parseServiceAccount(raw));
  },
};
