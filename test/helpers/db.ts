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
  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`,
  );
}
