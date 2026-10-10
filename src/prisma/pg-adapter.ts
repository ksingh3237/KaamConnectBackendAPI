import { PrismaPg } from '@prisma/adapter-pg';

/**
 * The single place that builds the Prisma driver adapter (app, seed script and tests all use it).
 *
 * Every connection is pinned to the UTC session time zone. Without this, Prisma's pg adapter
 * stores timestamps shifted by the database server's own zone (found on a server set to
 * Asia/Calcutta: rows were stored 5 h 30 min off, invisible in app-only round trips but wrong for
 * SQL `now()`, pgAdmin and every other tool). AWS RDS defaults to UTC, so this makes a laptop
 * behave exactly like production.
 *
 * Note for PgBouncer: it must be told to accept the startup parameter
 * (`ignore_startup_parameters = options`) or use session pooling.
 */
export function createPgAdapter(connectionString: string): PrismaPg {
  return new PrismaPg({ connectionString, options: '-c TimeZone=UTC' });
}
