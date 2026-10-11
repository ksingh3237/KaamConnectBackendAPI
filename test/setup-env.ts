// Runs before any test module is imported. ConfigModule.forRoot() validates process.env at
// import time, so the environment must be ready first (ES imports are hoisted above test code).
//
// From here on the application's DATABASE_URL *is* the test database, so nothing a test does
// through the app can reach the development database.
import {
  assertDistinctFromDevDatabase,
  requireTestDatabaseUrl,
  TEST_STORAGE_DIR,
} from './helpers/test-env.js';

const testUrl = requireTestDatabaseUrl();
assertDistinctFromDevDatabase(testUrl);
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = testUrl;

// Fixed, test-only secrets: tests never depend on (or leak) the developer's real ones.
process.env.JWT_ACCESS_SECRET =
  'test-only-jwt-secret-0123456789abcdef0123456789';
process.env.OTP_PEPPER = 'test-only-otp-pepper-0123456789abcdef0123456789';
process.env.OTP_DEV_BYPASS = 'false';
process.env.SMS_PROVIDER = 'console';
// Lets each test present its own client IP (X-Forwarded-For) so per-IP rate limits stay isolated.
process.env.TRUST_PROXY = '1';
// Files go to a throwaway folder, never the developer's .local-storage. Manual verification is the
// production behaviour; suites that need auto mode override it explicitly.
process.env.STORAGE_PROVIDER = 'local';
process.env.STORAGE_LOCAL_DIR = TEST_STORAGE_DIR;
delete process.env.PUBLIC_BASE_URL;
process.env.WORKER_VERIFICATION_MODE = 'manual';
