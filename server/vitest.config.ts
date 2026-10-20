import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@devdigest/shared': path.resolve(__dirname, 'src/vendor/shared'),
      '@devdigest/reviewer-core': path.resolve(__dirname, '../reviewer-core/src'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    // One shared Postgres for all *.it.test.ts files, started lazily on the
    // first DB request (hermetic-only runs never touch Docker); each fixture is
    // a fresh database cloned from a migrated template. See test/global-setup.ts.
    globalSetup: ['./test/global-setup.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
