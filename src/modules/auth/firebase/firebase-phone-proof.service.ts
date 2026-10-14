import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { EnvVars } from '../../../config/env.validation.js';
import { FirebaseTokenVerifier } from './firebase-verifier.js';
import { phoneFromClaims } from './phone-claims.js';

/**
 * "This person just proved they hold this phone number", established from a Firebase ID token.
 * The one place the verifier and the freshness rule are combined, shared by login and account deletion.
 */
@Injectable()
export class FirebasePhoneProof {
  constructor(
    private readonly verifier: FirebaseTokenVerifier,
    private readonly config: ConfigService<EnvVars, true>,
  ) {}

  /** The E.164 number the token proves, or an AppException (401 / 422 / 501 / 503). */
  async verifiedPhone(idToken: string): Promise<string> {
    const claims = await this.verifier.verify(idToken);
    return phoneFromClaims(
      claims,
      Date.now(),
      this.config.get('FIREBASE_AUTH_MAX_AGE_SEC', { infer: true }),
    );
  }
}
