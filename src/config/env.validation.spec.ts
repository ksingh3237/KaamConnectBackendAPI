import { databaseNameOf, validateEnv } from './env.validation.js';

const DEV_URL = 'postgresql://u:p@localhost:5432/KaamConnect?schema=public';
const TEST_URL =
  'postgresql://u:p@localhost:5432/KaamConnect_test?schema=public';

const SECRETS = {
  JWT_ACCESS_SECRET: 'j'.repeat(40),
  OTP_PEPPER: 'o'.repeat(40),
};

const S3 = {
  STORAGE_PROVIDER: 's3',
  STORAGE_REGION: 'ap-south-1',
  STORAGE_BUCKET: 'kaamconnect-media',
  STORAGE_BUCKET_PRIVATE: 'kaamconnect-private',
};

const productionEnv = {
  ...SECRETS,
  ...S3,
  NODE_ENV: 'production',
  DATABASE_URL: DEV_URL,
  SMS_PROVIDER: 'msg91',
  WORKER_VERIFICATION_MODE: 'manual',
  OTP_DEV_BYPASS: 'false',
  SOS_WEBHOOK_URL: 'https://safety.example.com/hooks/sos',
};

describe('validateEnv', () => {
  describe('MSG91 widget sign-in', () => {
    const dev = { ...SECRETS, DATABASE_URL: DEV_URL };

    it('is off by default and needs no authkey', () => {
      expect(validateEnv(dev).MSG91_WIDGET_ENABLED).toBe(false);
    });

    it('refuses to be switched on without the server-side authkey', () => {
      expect(() =>
        validateEnv({ ...dev, MSG91_WIDGET_ENABLED: 'true' }),
      ).toThrow(/MSG91_AUTHKEY is required/);
      expect(
        validateEnv({
          ...dev,
          MSG91_WIDGET_ENABLED: 'true',
          MSG91_AUTHKEY: 'k'.repeat(20),
        }).MSG91_WIDGET_ENABLED,
      ).toBe(true);
    });
  });

  it('applies safe defaults when only DATABASE_URL is given', () => {
    const env = validateEnv({ ...SECRETS, DATABASE_URL: DEV_URL });
    expect(env).toMatchObject({
      NODE_ENV: 'development',
      PORT: 3000,
      OTP_DEV_BYPASS: false,
      SMS_PROVIDER: 'console',
      WORKER_VERIFICATION_MODE: 'manual',
      JOB_OPEN_TTL_HOURS: 24,
      DIRECT_ACCEPT_TTL_MIN: 10,
      AVG_SPEED_KMH: 20,
      COMMISSION_BENCHMARK_RATE: 0.2,
    });
    expect(env.REDIS_URL).toBeUndefined();
  });

  it('parses strings from .env into typed values', () => {
    const env = validateEnv({
      ...SECRETS,
      DATABASE_URL: DEV_URL,
      PORT: '4100',
      OTP_DEV_BYPASS: 'true',
      COMMISSION_BENCHMARK_RATE: '0.25',
      REDIS_URL: '',
      WORKER_VERIFICATION_MODE: 'auto',
    });
    expect(env.PORT).toBe(4100);
    expect(env.OTP_DEV_BYPASS).toBe(true);
    expect(env.COMMISSION_BENCHMARK_RATE).toBe(0.25);
    expect(env.REDIS_URL).toBeUndefined();
    expect(env.WORKER_VERIFICATION_MODE).toBe('auto');
  });

  it('fails when DATABASE_URL is missing or not a postgres URL', () => {
    expect(() => validateEnv({ ...SECRETS })).toThrow(/DATABASE_URL/);
    expect(() =>
      validateEnv({ ...SECRETS, DATABASE_URL: 'mysql://x/y' }),
    ).toThrow(/DATABASE_URL/);
  });

  it('reports every invalid variable in one error', () => {
    expect(() =>
      validateEnv({
        ...SECRETS,
        DATABASE_URL: DEV_URL,
        PORT: 'abc',
        SMS_PROVIDER: 'carrier-pigeon',
        COMMISSION_BENCHMARK_RATE: '2',
      }),
    ).toThrow(
      /PORT[\s\S]*SMS_PROVIDER[\s\S]*COMMISSION_BENCHMARK_RATE|PORT[\s\S]*COMMISSION_BENCHMARK_RATE[\s\S]*SMS_PROVIDER/,
    );
  });

  describe('authentication settings', () => {
    it('requires both secrets', () => {
      expect(() => validateEnv({ DATABASE_URL: DEV_URL })).toThrow(
        /JWT_ACCESS_SECRET[\s\S]*OTP_PEPPER/,
      );
    });

    it('rejects short secrets', () => {
      expect(() =>
        validateEnv({
          ...SECRETS,
          DATABASE_URL: DEV_URL,
          JWT_ACCESS_SECRET: 'short',
        }),
      ).toThrow(/JWT_ACCESS_SECRET must be at least 32/);
      expect(() =>
        validateEnv({ ...SECRETS, DATABASE_URL: DEV_URL, OTP_PEPPER: 'short' }),
      ).toThrow(/OTP_PEPPER must be at least 32/);
    });

    it('rejects using one key for both purposes', () => {
      const same = 'k'.repeat(40);
      expect(() =>
        validateEnv({
          DATABASE_URL: DEV_URL,
          JWT_ACCESS_SECRET: same,
          OTP_PEPPER: same,
        }),
      ).toThrow(/must be different keys/);
    });

    it('applies safe defaults', () => {
      expect(validateEnv({ ...SECRETS, DATABASE_URL: DEV_URL })).toMatchObject({
        JWT_ACCESS_TTL_SEC: 900,
        REFRESH_TTL_DAYS: 30,
        OTP_TTL_SEC: 300,
        OTP_RESEND_SEC: 30,
        OTP_MAX_ATTEMPTS: 5,
        OTP_MAX_REQUESTS_PER_HOUR: 5,
        TRUST_PROXY: 0,
      });
    });

    it('keeps access tokens short-lived (60 s to 1 h)', () => {
      expect(() =>
        validateEnv({
          ...SECRETS,
          DATABASE_URL: DEV_URL,
          JWT_ACCESS_TTL_SEC: '86400',
        }),
      ).toThrow(/JWT_ACCESS_TTL_SEC/);
    });
  });

  describe('production guards for dev-only switches', () => {
    it('accepts a correct production configuration', () => {
      expect(() => validateEnv(productionEnv)).not.toThrow();
    });

    it('refuses OTP_DEV_BYPASS=true', () => {
      expect(() =>
        validateEnv({ ...productionEnv, OTP_DEV_BYPASS: 'true' }),
      ).toThrow(/OTP_DEV_BYPASS/);
    });

    it('refuses the console SMS sender (it logs OTPs)', () => {
      expect(() =>
        validateEnv({ ...productionEnv, SMS_PROVIDER: 'console' }),
      ).toThrow(/SMS_PROVIDER=console/);
    });

    it('refuses simulated worker approval', () => {
      expect(() =>
        validateEnv({ ...productionEnv, WORKER_VERIFICATION_MODE: 'auto' }),
      ).toThrow(/WORKER_VERIFICATION_MODE=auto/);
    });

    it('defaults to the safe manual mode when unset', () => {
      const { WORKER_VERIFICATION_MODE: _omit, ...withoutMode } = productionEnv;
      expect(validateEnv(withoutMode).WORKER_VERIFICATION_MODE).toBe('manual');
    });

    it('still allows the dev-only switches outside production', () => {
      expect(() =>
        validateEnv({
          ...SECRETS,
          NODE_ENV: 'development',
          DATABASE_URL: DEV_URL,
          OTP_DEV_BYPASS: 'true',
          SMS_PROVIDER: 'console',
          WORKER_VERIFICATION_MODE: 'auto',
        }),
      ).not.toThrow();
    });
  });

  describe('file storage', () => {
    const base = { ...SECRETS, DATABASE_URL: DEV_URL };

    it('defaults to the local development provider', () => {
      expect(validateEnv(base).STORAGE_PROVIDER).toBe('local');
    });

    it('requires an https SOS channel in production, so an alert always reaches a person', () => {
      const { SOS_WEBHOOK_URL: _omit, ...without } = productionEnv;
      expect(() => validateEnv(without)).toThrow(/SOS_WEBHOOK_URL is required/);
      expect(() =>
        validateEnv({
          ...productionEnv,
          SOS_WEBHOOK_URL: 'http://plain.example.com',
        }),
      ).toThrow(/SOS_WEBHOOK_URL must be https/);
    });

    it('lets development run without an SOS channel, and rejects a malformed one anywhere', () => {
      expect(
        validateEnv({ ...SECRETS, DATABASE_URL: DEV_URL }).SOS_WEBHOOK_URL,
      ).toBeUndefined();
      expect(() =>
        validateEnv({
          ...SECRETS,
          DATABASE_URL: DEV_URL,
          SOS_WEBHOOK_URL: 'not a url',
        }),
      ).toThrow(/SOS_WEBHOOK_URL must be an http/);
    });

    it('refuses local storage in production', () => {
      expect(() =>
        validateEnv({ ...productionEnv, STORAGE_PROVIDER: 'local' }),
      ).toThrow(/STORAGE_PROVIDER=local/);
    });

    it('requires region and both buckets for s3', () => {
      expect(() => validateEnv({ ...base, STORAGE_PROVIDER: 's3' })).toThrow(
        /STORAGE_REGION[\s\S]*STORAGE_BUCKET is[\s\S]*STORAGE_BUCKET_PRIVATE/,
      );
    });

    it('keeps Aadhaar images in a different bucket from ordinary media', () => {
      expect(() =>
        validateEnv({
          ...base,
          ...S3,
          STORAGE_BUCKET_PRIVATE: S3.STORAGE_BUCKET,
        }),
      ).toThrow(/must be different buckets/);
    });

    it('needs the access key and secret together, or neither (IAM role)', () => {
      expect(() =>
        validateEnv({ ...base, ...S3, STORAGE_ACCESS_KEY: 'AKIA' }),
      ).toThrow(/set together/);
      expect(() => validateEnv({ ...base, ...S3 })).not.toThrow();
      expect(() =>
        validateEnv({
          ...base,
          ...S3,
          STORAGE_ACCESS_KEY: 'a',
          STORAGE_SECRET_KEY: 'b',
        }),
      ).not.toThrow();
    });

    it('rejects a base URL that carries a path', () => {
      expect(() =>
        validateEnv({ ...base, PUBLIC_BASE_URL: 'http://localhost:3000/api' }),
      ).toThrow(/PUBLIC_BASE_URL/);
      expect(
        validateEnv({ ...base, PUBLIC_BASE_URL: 'https://api.kaamconnect.in' })
          .PUBLIC_BASE_URL,
      ).toBe('https://api.kaamconnect.in');
    });
  });

  describe('browser origins (CORS_ORIGINS)', () => {
    const base = { ...SECRETS, DATABASE_URL: DEV_URL };

    it('is off by default: no browser origin is allowed', () => {
      expect(validateEnv(base).CORS_ORIGINS).toBeUndefined();
      expect(
        validateEnv({ ...base, CORS_ORIGINS: '' }).CORS_ORIGINS,
      ).toBeUndefined();
    });

    it('accepts exact origins, with ports, separated by commas', () => {
      const env = validateEnv({
        ...base,
        CORS_ORIGINS: 'http://localhost:8081, https://app.example.com',
      });
      expect(env.CORS_ORIGINS).toBe(
        'http://localhost:8081, https://app.example.com',
      );
    });

    it.each([
      '*',
      'http://*.example.com',
      'https://example.com/app',
      'localhost:8081',
      'ftp://example.com',
    ])('refuses %s (no wildcards, no paths, http(s) only)', (bad) => {
      expect(() => validateEnv({ ...base, CORS_ORIGINS: bad })).toThrow(
        /CORS_ORIGINS entry/,
      );
    });

    it('is allowed in production only as an explicit list, and a wildcard is still refused there', () => {
      expect(() =>
        validateEnv({
          ...productionEnv,
          CORS_ORIGINS: 'https://app.example.com',
        }),
      ).not.toThrow();
      expect(() =>
        validateEnv({ ...productionEnv, CORS_ORIGINS: '*' }),
      ).toThrow(/CORS_ORIGINS entry/);
    });
  });

  describe('test database safety', () => {
    it('accepts a *_test database', () => {
      expect(
        validateEnv({
          ...SECRETS,
          DATABASE_URL: DEV_URL,
          TEST_DATABASE_URL: TEST_URL,
        }).TEST_DATABASE_URL,
      ).toBe(TEST_URL);
    });

    it('rejects a TEST_DATABASE_URL that is not named *_test', () => {
      expect(() =>
        validateEnv({
          ...SECRETS,
          DATABASE_URL: DEV_URL,
          TEST_DATABASE_URL: DEV_URL,
        }),
      ).toThrow(/_test/);
    });

    it('allows them to be equal only under NODE_ENV=test (the test harness does this)', () => {
      const url = 'postgresql://u:p@localhost:5432/KaamConnect_test';
      expect(() =>
        validateEnv({
          ...SECRETS,
          NODE_ENV: 'test',
          DATABASE_URL: url,
          TEST_DATABASE_URL: url,
        }),
      ).not.toThrow();
    });

    it('rejects the dev database as the test database', () => {
      const url = 'postgresql://u:p@localhost:5432/KaamConnect_test';
      expect(() =>
        validateEnv({ ...SECRETS, DATABASE_URL: url, TEST_DATABASE_URL: url }),
      ).toThrow(/must differ/);
    });
  });
});

describe('databaseNameOf', () => {
  it('keeps the exact case and ignores query strings', () => {
    expect(databaseNameOf(DEV_URL)).toBe('KaamConnect');
    expect(databaseNameOf(TEST_URL)).toBe('KaamConnect_test');
  });

  it('returns undefined for garbage', () => {
    expect(databaseNameOf('not a url')).toBeUndefined();
    expect(databaseNameOf('postgresql://u:p@localhost:5432')).toBeUndefined();
  });
});
