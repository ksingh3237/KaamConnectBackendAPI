import type { PrismaClient } from '../src/generated/prisma/client.js';
import { createTestPrisma, resetDatabase } from './helpers/db.js';
import { nextPhone } from './helpers/factories.js';

// Regression test for a bug found in Phase 3: on a Postgres server whose own time zone is not UTC
// (a developer laptop in India: Asia/Calcutta), Prisma's pg adapter stored every timestamp shifted
// by the server's offset. App-only round trips looked fine, but SQL `now()`, pgAdmin and any
// other tool saw wrong times. createPgAdapter() pins the session to UTC; this proves it holds.
describe('timestamps are stored as true instants, whatever the server time zone', () => {
  let prisma: PrismaClient;

  beforeAll(() => {
    prisma = createTestPrisma();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });
  beforeEach(async () => {
    await resetDatabase(prisma);
  });

  it('a time written by the app is the same instant when Postgres computes with it', async () => {
    const written = new Date();
    const row = await prisma.otpChallenge.create({
      data: {
        phone: nextPhone(),
        codeHash: 'x',
        expiresAt: new Date(written.getTime() + 300_000),
        createdAt: written,
      },
    });

    // The database's own idea of "how old is this row" must be about zero seconds, not +/- 5.5 hours.
    const [{ age_seconds }] = await prisma.$queryRaw<{ age_seconds: number }[]>`
      SELECT EXTRACT(EPOCH FROM (clock_timestamp() - created_at))::float8 AS age_seconds
      FROM otp_challenges WHERE id = ${row.id}::uuid`;
    expect(age_seconds).toBeGreaterThanOrEqual(0);
    expect(age_seconds).toBeLessThan(5);
  });

  it('a time produced by SQL now() is read back by the app as the same instant', async () => {
    const row = await prisma.otpChallenge.create({
      data: {
        phone: nextPhone(),
        codeHash: 'x',
        expiresAt: new Date(Date.now() + 300_000),
      },
    });
    await prisma.$executeRaw`UPDATE otp_challenges SET created_at = now() - interval '10 seconds' WHERE id = ${row.id}::uuid`;

    const read = await prisma.otpChallenge.findUniqueOrThrow({
      where: { id: row.id },
    });
    const ageMs = Date.now() - read.createdAt.getTime();
    expect(ageMs).toBeGreaterThanOrEqual(9_000);
    expect(ageMs).toBeLessThan(20_000);
  });

  it('every connection from the app pool runs in UTC', async () => {
    const [{ TimeZone }] = await prisma.$queryRaw<
      { TimeZone: string }[]
    >`SHOW TimeZone`;
    expect(TimeZone).toBe('UTC');
  });
});
