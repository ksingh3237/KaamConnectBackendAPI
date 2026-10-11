import 'dotenv/config';
import os from 'node:os';
import path from 'node:path';
import { databaseNameOf } from '../../src/config/env.validation.js';

/** Where tests keep uploaded files; created on demand and removed by global teardown. */
export const TEST_STORAGE_DIR = path.join(
  os.tmpdir(),
  'kaamconnect-test-storage',
);

/**
 * The only way tests learn which database to use. Refuses anything whose name does not end in
 * `_test`, so a typo in .env can never make a test suite truncate the development database.
 */
export function requireTestDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error(
      'TEST_DATABASE_URL is not set. Add it to .env (database name must end in _test); see .env.example.',
    );
  }
  const name = databaseNameOf(url);
  if (!name || !name.toLowerCase().endsWith('_test')) {
    throw new Error(
      `Refusing to run tests: TEST_DATABASE_URL points at "${name ?? '?'}", not a *_test database.`,
    );
  }
  return url;
}

/**
 * Call BEFORE the harness overrides DATABASE_URL: the developer's real DATABASE_URL (from .env)
 * must not be the same database as the test one.
 */
export function assertDistinctFromDevDatabase(testUrl: string): void {
  if (process.env.DATABASE_URL && process.env.DATABASE_URL === testUrl) {
    throw new Error(
      'Refusing to run tests: TEST_DATABASE_URL equals DATABASE_URL.',
    );
  }
}
