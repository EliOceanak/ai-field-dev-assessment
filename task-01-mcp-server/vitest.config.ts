import { defineConfig } from 'vitest/config';

/**
 * Default (offline) suite. Every test here is hermetic: it spawns local
 * processes and mock servers on ephemeral ports, and never talks to a model.
 * Live tests live in `tests/live/**` and run through `vitest.live.config.ts`.
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', 'tests/live/**'],
    testTimeout: 20_000,
    hookTimeout: 20_000
  }
});
