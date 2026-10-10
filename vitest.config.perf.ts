import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

// On-demand benchmark (`npm run test:perf`), deliberately NOT part of `test:e2e`: it bulk-loads tens
// of thousands of rows into the *_test database and prints timings.
export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    root: './',
    include: ['test/perf/**/*.perf-spec.ts'],
    fileParallelism: false,
    globalSetup: ['./test/global-setup.ts'],
    setupFiles: ['./test/setup-env.ts'],
    testTimeout: 300_000,
    hookTimeout: 300_000,
  },
});
