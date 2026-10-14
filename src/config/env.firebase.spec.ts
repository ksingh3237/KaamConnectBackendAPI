import { validateEnv } from './env.validation.js';

const SECRETS = {
  JWT_ACCESS_SECRET: 'j'.repeat(40),
  OTP_PEPPER: 'o'.repeat(40),
};
const DEV_URL = 'postgresql://u:p@localhost:5432/KaamConnect?schema=public';

const development = { ...SECRETS, DATABASE_URL: DEV_URL };

/** A production environment that is valid with the legacy SMS login on (as before this feature). */
const productionLegacy = {
  ...development,
  NODE_ENV: 'production',
  SMS_PROVIDER: 'msg91',
  WORKER_VERIFICATION_MODE: 'manual',
  OTP_DEV_BYPASS: 'false',
  STORAGE_PROVIDER: 's3',
  STORAGE_REGION: 'ap-south-1',
  STORAGE_BUCKET: 'kaamconnect-media',
  STORAGE_BUCKET_PRIVATE: 'kaamconnect-private',
  SOS_WEBHOOK_URL: 'https://safety.example.com/hooks/sos',
};

/** The intended production setting once Firebase is the login: legacy off, no SMS provider needed. */
const productionFirebase = {
  ...productionLegacy,
  SMS_PROVIDER: 'console', // the default; must NOT be an error when the legacy login is off
  LEGACY_OTP_ENABLED: 'false',
  FIREBASE_AUTH_ENABLED: 'true',
  FIREBASE_SERVICE_ACCOUNT_PATH: '/run/secrets/firebase.json',
};

describe('Firebase and legacy-OTP settings', () => {
  it('default to the existing behaviour: legacy login on, Firebase off, 5 minute freshness window', () => {
    const env = validateEnv(development);
    expect(env).toMatchObject({
      LEGACY_OTP_ENABLED: true,
      FIREBASE_AUTH_ENABLED: false,
      FIREBASE_AUTH_MAX_AGE_SEC: 300,
    });
    expect(env.FIREBASE_SERVICE_ACCOUNT_PATH).toBeUndefined();
    expect(env.FIREBASE_SERVICE_ACCOUNT_JSON_BASE64).toBeUndefined();
  });

  it('treats empty strings as unset (a blank line in .env)', () => {
    const env = validateEnv({
      ...development,
      FIREBASE_SERVICE_ACCOUNT_PATH: '',
      FIREBASE_SERVICE_ACCOUNT_JSON_BASE64: '',
    });
    expect(env.FIREBASE_SERVICE_ACCOUNT_PATH).toBeUndefined();
  });

  it('does not need credentials while Firebase sign-in is off, even if a path is present', () => {
    expect(() =>
      validateEnv({
        ...development,
        FIREBASE_SERVICE_ACCOUNT_PATH: '/somewhere/key.json',
      }),
    ).not.toThrow();
  });

  describe('when Firebase sign-in is on', () => {
    const on = { ...development, FIREBASE_AUTH_ENABLED: 'true' };

    it('requires credentials (fails closed at boot)', () => {
      expect(() => validateEnv(on)).toThrow(
        /FIREBASE_AUTH_ENABLED=true requires FIREBASE_SERVICE_ACCOUNT_PATH or FIREBASE_SERVICE_ACCOUNT_JSON_BASE64/,
      );
    });

    it('accepts exactly one credential source', () => {
      expect(() =>
        validateEnv({ ...on, FIREBASE_SERVICE_ACCOUNT_PATH: '/k.json' }),
      ).not.toThrow();
      expect(() =>
        validateEnv({ ...on, FIREBASE_SERVICE_ACCOUNT_JSON_BASE64: 'e30=' }),
      ).not.toThrow();
    });

    it('refuses two credential sources (ambiguous)', () => {
      expect(() =>
        validateEnv({
          ...on,
          FIREBASE_SERVICE_ACCOUNT_PATH: '/k.json',
          FIREBASE_SERVICE_ACCOUNT_JSON_BASE64: 'e30=',
        }),
      ).toThrow(/only one of FIREBASE_SERVICE_ACCOUNT_PATH/);
    });
  });

  it('bounds the freshness window (30 s to 15 min)', () => {
    for (const bad of ['29', '901', '0', 'abc']) {
      expect(() =>
        validateEnv({ ...development, FIREBASE_AUTH_MAX_AGE_SEC: bad }),
      ).toThrow(/FIREBASE_AUTH_MAX_AGE_SEC/);
    }
    expect(
      validateEnv({ ...development, FIREBASE_AUTH_MAX_AGE_SEC: '120' })
        .FIREBASE_AUTH_MAX_AGE_SEC,
    ).toBe(120);
  });

  it('refuses to switch the legacy login off when there is no other way in', () => {
    expect(() =>
      validateEnv({ ...development, LEGACY_OTP_ENABLED: 'false' }),
    ).toThrow(/LEGACY_OTP_ENABLED=false requires FIREBASE_AUTH_ENABLED=true/);
  });

  describe('in production', () => {
    it('the legacy login alone is exactly as strict as before (console SMS refused)', () => {
      expect(() => validateEnv(productionLegacy)).not.toThrow();
      expect(() =>
        validateEnv({ ...productionLegacy, SMS_PROVIDER: 'console' }),
      ).toThrow(/SMS_PROVIDER=console/);
    });

    it('Firebase with the legacy login OFF boots without any SMS provider (no MSG91 needed)', () => {
      const env = validateEnv(productionFirebase);
      expect(env).toMatchObject({
        LEGACY_OTP_ENABLED: false,
        FIREBASE_AUTH_ENABLED: true,
      });
    });

    it('Firebase with the legacy login still ON must still have a real SMS provider (the console one is refused)', () => {
      expect(() =>
        validateEnv({ ...productionFirebase, LEGACY_OTP_ENABLED: 'true' }),
      ).toThrow(/SMS_PROVIDER=console/);
    });

    it('legacy off without Firebase is refused: nobody could sign in', () => {
      expect(() =>
        validateEnv({ ...productionFirebase, FIREBASE_AUTH_ENABLED: 'false' }),
      ).toThrow(/requires FIREBASE_AUTH_ENABLED=true/);
    });

    it('Firebase on without credentials is refused', () => {
      const { FIREBASE_SERVICE_ACCOUNT_PATH: _drop, ...noCredentials } =
        productionFirebase;
      expect(() => validateEnv(noCredentials)).toThrow(
        /requires FIREBASE_SERVICE_ACCOUNT_PATH or/,
      );
    });

    it('the development OTP bypass stays forbidden even with the legacy login off', () => {
      expect(() =>
        validateEnv({ ...productionFirebase, OTP_DEV_BYPASS: 'true' }),
      ).toThrow(/OTP_DEV_BYPASS must be false in production/);
    });

    it('every other production guard still applies (worker verification, storage, SOS)', () => {
      expect(() =>
        validateEnv({
          ...productionFirebase,
          WORKER_VERIFICATION_MODE: 'auto',
        }),
      ).toThrow(/WORKER_VERIFICATION_MODE=auto/);
      expect(() =>
        validateEnv({ ...productionFirebase, STORAGE_PROVIDER: 'local' }),
      ).toThrow(/STORAGE_PROVIDER=local/);
      expect(() =>
        validateEnv({ ...productionFirebase, SOS_WEBHOOK_URL: '' }),
      ).toThrow(/SOS_WEBHOOK_URL is required/);
    });
  });
});
