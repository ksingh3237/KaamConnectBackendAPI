/** The few facts about a verified Firebase ID token that sign-in needs. Nothing else is read or stored. */
export interface FirebaseClaims {
  /** Firebase's own id for the person. Not stored (the phone number is our identity). */
  uid: string;
  /** E.164, e.g. "+919876543210". Absent for sign-in methods that carry no phone number. */
  phoneNumber?: string;
  /** "phone" for Phone Authentication; anything else must not be accepted as proof of a phone number. */
  signInProvider?: string;
  /** When the person last completed the Firebase sign-in, in whole seconds since 1970. */
  authTimeSec: number;
}

/**
 * Checks a Firebase ID token's signature, issuer, audience and expiry and returns its claims.
 * An abstract class (not an interface) so it can be the DI token, like OtpSender. Production: FirebaseAdminVerifier.
 * Tests replace it, so no automated test ever talks to Google.
 */
export abstract class FirebaseTokenVerifier {
  /**
   * Throws AppException 401 FIREBASE_TOKEN_INVALID for a token that is malformed, forged, expired or revoked, and
   * 503 FIREBASE_UNAVAILABLE when the check itself could not be made (credentials, network).
   */
  abstract verify(idToken: string): Promise<FirebaseClaims>;
}
