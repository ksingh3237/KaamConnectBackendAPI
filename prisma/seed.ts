// `npm run db:seed` / `prisma db seed`: loads reference data into DATABASE_URL.
import 'dotenv/config';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { createPgAdapter } from '../src/prisma/pg-adapter.js';
import { seedReferenceData } from './seed/reference-data.js';

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set');
  }

  const prisma = new PrismaClient({
    adapter: createPgAdapter(connectionString),
  });
  try {
    const report = await seedReferenceData(prisma, {
      includeLegacyAreas: process.env.SEED_LEGACY_AREAS === 'true',
    });
    console.log('Reference data seeded:', JSON.stringify(report, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error('Seed failed:', error);
  process.exitCode = 1;
});
