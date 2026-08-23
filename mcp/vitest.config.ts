import { defineConfig } from 'vitest/config';

// Hermetic suite: no network, no real timers — fakes are injected per test.
// `@devdigest/shared` appears only as `import type` (erased at transform time),
// so no path-alias plugin is needed at runtime.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
  },
});
