import 'dotenv/config';
import { defineConfig } from 'prisma/config';

// Prisma 7: the datasource URL lives here, not in schema.prisma. `prisma generate`
// does not need a reachable database, so a missing URL only fails commands that connect.
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
  datasource: {
    url: process.env.DATABASE_URL ?? '',
  },
});
