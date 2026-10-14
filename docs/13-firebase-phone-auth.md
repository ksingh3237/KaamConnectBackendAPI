# 13. Firebase phone sign-in

The app proves a phone number with **Firebase Phone Authentication** (Google sends the SMS). The app then sends the resulting
Firebase ID token to this API, which verifies it and starts **its own** session. Everything after that is unchanged: HS256 access
token (15 min), rotating refresh tokens, `users` table keyed by phone number, Prisma schema, no migration.

```
 app                          Firebase / Google                 this API
  | signInWithPhoneNumber(+91...) ->|                               |
  |<------------- SMS code ---------|                               |
  | confirm(code) ----------------->|                               |
  |<-- Firebase ID token -----------|                               |
  | POST /auth/firebase/verify { idToken } ------------------------>|  verify signature/issuer/audience/expiry
  |                                                                 |  provider == phone, Indian number, auth_time recent
  |<----------- { accessToken, refreshToken, user, isNewUser } -----|  find-or-create user by phone, createSession
  | signs out of Firebase (our session is what the app uses)        |
```

## What the server accepts

`POST /auth/firebase/verify { idToken }` (public, 30 per 15 min per IP) succeeds only when **all** hold:

| Check | Refusal |
|---|---|
| Signature, issuer, audience and expiry are valid (Firebase Admin SDK) | `401 FIREBASE_TOKEN_INVALID` |
| `firebase.sign_in_provider == "phone"` (an email or anonymous Firebase user proves no number) | `401 FIREBASE_TOKEN_INVALID` |
| The token carries `phone_number`, an Indian mobile in E.164 (`+91[6-9]xxxxxxxxx`) | `401` (missing) / `422 PHONE_NOT_SUPPORTED` |
| `auth_time` is no older than `FIREBASE_AUTH_MAX_AGE_SEC` (default 300) and not in the future | `401 FIREBASE_TOKEN_STALE` / `FIREBASE_TOKEN_INVALID` |
| The account is active | `403 ACCOUNT_DISABLED` |

A Firebase ID token lives an hour; the `auth_time` rule is what stops an old copy being replayed. The phone number is taken **from
the token only**; a `phone` field in the body is rejected (`422`). The Firebase token and Firebase's uid are **not stored**: the
phone number stays our identity, exactly as with the SMS login, so a user created by either route is the same user.
If Google cannot be reached the answer is `503 FIREBASE_UNAVAILABLE` (not 401), nothing is created, and a retry works.

## Account deletion

`DELETE /me` and `POST /auth/deletion-requests` accept **either** the SMS `code` **or** a `firebaseIdToken` (exactly one, else `422`).
For `DELETE /me` the token must be a *fresh* phone sign-in (same `FIREBASE_AUTH_MAX_AGE_SEC` rule) for **the account's own number**
(`403 PHONE_MISMATCH` otherwise), so a stolen session alone still cannot delete an account. An active job is still refused first
(`409`), before the proof is checked, so a person with a job in progress does not waste a verification.
For the disabled-account request the number comes from the token; the reply is the same for every number.

## Configuration

| Variable | Meaning |
|---|---|
| `FIREBASE_AUTH_ENABLED` | `false` (default): the route answers `501 FIREBASE_AUTH_NOT_CONFIGURED`. `true`: credentials are required and the server **refuses to start** if they are missing, ambiguous, unreadable or malformed |
| `FIREBASE_SERVICE_ACCOUNT_PATH` | Absolute path of the service-account JSON (developer machine, or a secret mounted as a file) |
| `FIREBASE_SERVICE_ACCOUNT_JSON_BASE64` | The same JSON base64-encoded (hosts that only inject environment secrets). Set **one** of the two, not both |
| `FIREBASE_AUTH_MAX_AGE_SEC` | Freshness window, 30-900, default 300 |
| `LEGACY_OTP_ENABLED` | `true` (default): the original SMS-code login and the `code` form of deletion work as before. `false`: they answer `404 LEGACY_OTP_DISABLED`, and the OTP sender is replaced by one that can never send or print a code |

Start-up rules (`src/config/env.validation.ts`, covered by `src/config/env.firebase.spec.ts`):

* `LEGACY_OTP_ENABLED=false` requires `FIREBASE_AUTH_ENABLED=true` (otherwise nobody could sign in) - in every environment.
* In **production**, `SMS_PROVIDER=console` is refused only while the legacy login is on. With `LEGACY_OTP_ENABLED=false` **no SMS
  provider (MSG91) is needed** for the Firebase flow. All other production guards are unchanged (dev OTP bypass off,
  `WORKER_VERIFICATION_MODE=manual`, S3 storage, `SOS_WEBHOOK_URL`).
* `OTP_DEV_BYPASS` (fixed code `123456`) stays refused in production whatever else is set, and still works in development.

**Intended production setting:** `FIREBASE_AUTH_ENABLED=true`, a credentials source, `LEGACY_OTP_ENABLED=false`.
**Local development (unchanged):** leave `FIREBASE_AUTH_ENABLED=false`; `npm run dev:local` keeps the fixed-code OTP.

## The service-account key (backend-only secret)

* The JSON is a **private key**. It never goes in the repository, the mobile app, a Docker image, a log or a chat.
* Git protection: `.gitignore` excludes `firebase-service-account.json` and `*-firebase-adminsdk-*.json` and `.env*`.
  Keep the file **outside** the repository anyway (on the developer machine: `..\KaamConnect-secrets\`).
* Production: prefer the host's secret store (AWS Secrets Manager / SSM Parameter Store / the platform's secrets) and inject it as
  `FIREBASE_SERVICE_ACCOUNT_JSON_BASE64` or as a mounted file referenced by `FIREBASE_SERVICE_ACCOUNT_PATH`. Give the service
  account only what token verification needs (the Admin SDK verifies tokens locally with Google's public keys; it needs no extra
  role for that).
* Errors and logs never contain the key: a malformed file produces "not valid JSON" / `missing "private_key"` and nothing else;
  Firebase tokens are JWTs and are already redacted by the log masker.
* **If the key is ever exposed** (committed, pasted, emailed): Firebase console > Project settings > Service accounts > manage in
  Google Cloud > the account's *Keys* > delete the key and create a new one, then update the secret store.

## Tests

* Unit: claim policy (`phone-claims.spec.ts`), Admin SDK error mapping and credential parsing (`firebase-admin-verifier.spec.ts`),
  fail-closed provider (`firebase-verifier.provider.spec.ts`), the OTP sender switch (`otp-sender.provider.spec.ts`), the
  one-proof rule (`deletion-proof.spec.ts`), environment rules (`env.firebase.spec.ts`).
* e2e on the real test database, with Google replaced by `FakeFirebaseVerifier` (`test/helpers/app.ts`):
  `test/firebase-auth.e2e-spec.ts` (login, returning user across both routes, session/refresh, stale/forged/wrong-provider/
  non-Indian tokens, disabled account, 503, rate limit, legacy OTP and dev bypass still working, `LEGACY_OTP_ENABLED=false`) and
  `test/firebase-account-deletion.e2e-spec.ts` (both deletion doors).
* No automated test calls Google. A real SMS can only be checked on a device (see the mobile repo's `FIREBASE-SETUP.md`).
* Mutation-checked: each rule above was broken on purpose and a test failed (15 mutations, all caught).

## Firebase console settings the code cannot do for you

1. **Authentication > Sign-in method > Phone: enable.**
2. **Authentication > Settings > SMS region policy: allow only India (+91).** Phone auth is a target for SMS-pumping fraud.
3. **App Check** with Play Integrity (Android) and App Attest / DeviceCheck (iOS), enforced for Authentication.
4. **Phone numbers for testing** (Authentication > Phone): add fictional numbers with fixed codes for development and CI-free manual
   tests. They send no SMS and cost nothing.
5. **Quota/billing:** the free plan allows only a small number of verification SMS per day; production needs the Blaze (pay as you go)
   plan. Check the current limits in the console before launch.
6. **Restrict the client API keys** (Google Cloud console > APIs & Services > Credentials): the Android key to package
   `com.kaamconnect.app` + the app's SHA-1; the iOS key to bundle id `com.kaamconnect.app`; limit both to the APIs the app uses
   (Identity Toolkit, Firebase installations, etc.). The `google-services.json` / `GoogleService-Info.plist` files are committed,
   so these restrictions are what protects the keys.

## Known limits

* Inside the freshness window a stolen Firebase token could be replayed (TLS protects it in transit; the window is 5 minutes and
  can be lowered). Marking tokens single-use would need a table (a migration), which was not approved.
* No Firebase uid is stored. If the product later wants to survive a phone-number change, that needs a column and approval.
* `checkRevoked` is off (saves a Google round trip per login); disabling a user is done through `users.is_active`.
