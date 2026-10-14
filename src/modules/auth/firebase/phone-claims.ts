import { AppException } from '../../../common/exceptions/app.exception.js';
import { INDIAN_MOBILE_E164 } from '../../../common/utils/phone.js';
import type { FirebaseClaims } from './firebase-verifier.js';

/** A token whose auth_time is this far in the future is not from a clock we should trust. */
const CLOCK_SKEW_SEC = 60;

const invalid = () =>
  new AppException(
    'FIREBASE_TOKEN_INVALID',
    401,
    'The phone verification could not be confirmed',
  );

/**
 * Turns verified Firebase claims into a phone number we may sign someone in with, or throws.
 * Accepted only when ALL hold: the person signed in with Phone Authentication (an email or anonymous Firebase user
 * proves no phone number), the token carries an Indian mobile number in E.164, and they verified it recently
 * (a Firebase ID token lives an hour, so without this an old copy could be replayed).
 */
export function phoneFromClaims(
  claims: FirebaseClaims,
  nowMs: number,
  maxAgeSec: number,
): string {
  if (claims.signInProvider !== 'phone') throw invalid();
  if (typeof claims.phoneNumber !== 'string' || claims.phoneNumber === '') {
    throw invalid();
  }
  // Strict: Firebase always sends E.164, so unlike user input there is nothing to normalise.
  if (!INDIAN_MOBILE_E164.test(claims.phoneNumber)) {
    throw new AppException(
      'PHONE_NOT_SUPPORTED',
      422,
      'Only Indian mobile numbers are supported',
    );
  }
  const ageSec = nowMs / 1000 - claims.authTimeSec;
  if (!Number.isFinite(ageSec) || ageSec < -CLOCK_SKEW_SEC) throw invalid();
  if (ageSec > maxAgeSec) {
    throw new AppException(
      'FIREBASE_TOKEN_STALE',
      401,
      'Please verify your phone number again',
    );
  }
  return claims.phoneNumber;
}
