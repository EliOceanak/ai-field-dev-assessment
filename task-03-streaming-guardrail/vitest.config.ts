import { defineConfig } from 'vitest/config';

/**
 * Default (offline) suite. The mock upstream is an in-process HTTP server that
 * emits scripted SSE chunks, so latency, memory and split-boundary behaviour are
 * all testable deterministically without a model.
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', 'tests/live/**'],
    testTimeout: 20_000,
    hookTimeout: 20_000
  }
});
