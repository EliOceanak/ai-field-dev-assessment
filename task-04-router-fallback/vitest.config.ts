import { defineConfig } from 'vitest/config';

/**
 * Default (offline) suite: scripted mock providers in-process, an ephemeral
 * SQLite file per test. Deterministic — the clock and the fetch implementation
 * are injectable, so window rollover and timeout races need no real sleeping.
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', 'tests/live/**'],
    testTimeout: 30_000,
    hookTimeout: 30_000
  }
});
