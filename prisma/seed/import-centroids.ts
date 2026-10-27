// `npm run db:centroids -- --template > areas.csv`   writes every area with empty lat/lng to fill in
// `npm run db:centroids -- areas.csv`                 dry run: checks the file and says what would change
// `npm run db:centroids -- areas.csv --apply`         fills the centroids that are still missing
// Values must come from someone who knows the places or from a geocoding export (docs Q-18), never from memory.
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { PrismaClient } from '../../src/generated/prisma/client.js';
import { createPgAdapter } from '../../src/prisma/pg-adapter.js';
import {
  centroidTemplate,
  parseCentroidCsv,
} from '../../src/modules/matching/centroid-csv.js';
import { CITIES } from '../data/locations.js';
import { applyCentroids } from './centroids.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--template')) {
    process.stdout.write(centroidTemplate(CITIES));
    return;
  }
  const file = args.find((a) => !a.startsWith('--'));
  if (!file)
    throw new Error('Usage: db:centroids -- <file.csv> [--apply] | --template');
  const parsed = parseCentroidCsv(readFileSync(file, 'utf8'));
  for (const error of parsed.errors) console.error(error);
  if (parsed.errors.length > 0)
    throw new Error(
      `${parsed.errors.length} problem(s) in ${file}; nothing was changed.`,
    );

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is not set');
  const prisma = new PrismaClient({
    adapter: createPgAdapter(connectionString),
  });
  try {
    const apply = args.includes('--apply');
    const report = await applyCentroids(prisma, parsed.rows, { apply });
    console.log(apply ? 'Applied:' : 'Dry run (add --apply to write):');
    console.log(
      JSON.stringify(
        {
          filled: report.filled.length,
          unchanged: report.unchanged,
          keptBecauseAlreadySet: report.kept,
          unknownToTheDatabase: report.unknown,
        },
        null,
        2,
      ),
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
