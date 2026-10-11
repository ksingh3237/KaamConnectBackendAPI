import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import {
  assertDistinctFromDevDatabase,
  requireTestDatabaseUrl,
  TEST_STORAGE_DIR,
} from './helpers/test-env.js';

/** Brings the *_test database to the latest migration once per run (`migrate deploy`: apply-only, never resets). */
export default function globalSetup(): () => void {
  const testUrl = requireTestDatabaseUrl();
  assertDistinctFromDevDatabase(testUrl);
  execFileSync(
    process.execPath,
    ['node_modules/prisma/build/index.js', 'migrate', 'deploy'],
    {
      env: { ...process.env, DATABASE_URL: testUrl },
      stdio: 'inherit',
    },
  );
  rmSync(TEST_STORAGE_DIR, { recursive: true, force: true });

  // Teardown: remove the files uploaded during the run.
  return () => rmSync(TEST_STORAGE_DIR, { recursive: true, force: true });
}
