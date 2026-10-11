import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    // Measured with `npm run test:cov`. The unit and e2e runs write separate JSON reports (coverage/unit, coverage/e2e) that
    // scripts/coverage-check.mjs merges and checks against the thresholds documented in
    // docs/05-security-testing.md. The generated Prisma client, the specs and the bootstrap file are not counted.
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/generated/**', 'src/**/*.spec.ts', 'src/main.ts'],
      reporter: ['json', 'text-summary'],
      reportsDirectory: 'coverage/unit',
    },
    root: './',
    include: ['src/**/*.spec.ts'],
  },
});
