import { PrismaClient } from '../../src/generated/prisma/client.js';
import { createPgAdapter } from '../../src/prisma/pg-adapter.js';
import { requireTestDatabaseUrl } from './test-env.js';

export function createTestPrisma(): PrismaClient {
  return new PrismaClient({
    adapter: createPgAdapter(requireTestDatabaseUrl()),
  });
}

/**
 * Empties every table (including reference data) and restarts sequences. Double-checks the live
 * connection is a *_test database before issuing TRUNCATE.
 */
export async function resetDatabase(prisma: PrismaClient): Promise<void> {
  const [{ current_database }] = await prisma.$queryRaw<
    { current_database: string }[]
  >`SELECT current_database()`;
  if (!current_database.toLowerCase().endsWith('_test')) {
    throw new Error(
      `Refusing to TRUNCATE "${current_database}": not a *_test database`,
    );
  }

  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  if (tables.length === 0) return;

  const list = tables.map((t) => `"public"."${t.tablename}"`).join(', ');
  // Notifications are written after the request that caused them has answered (they never delay or fail a booking),
  // so the previous test's last insert can still be running. If Postgres picks the TRUNCATE as the deadlock victim
  // (40P01), the insert has finished by the time it is retried.
  for (let attempt = 1; ; attempt += 1) {
    try {
      await prisma.$executeRawUnsafe(
        `TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`,
      );
      return;
    } catch (error) {
      if (attempt >= 5 || !String(error).includes('40P01')) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50 * attempt));
    }
  }
}
