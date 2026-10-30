import { defineConfig } from 'vitest/config';

/**
 * Default (offline) suite: the mock downstream MCP server and the gateway both
 * run in-process on ephemeral ports. No network, no model, no fixed ports.
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', 'tests/live/**'],
    testTimeout: 20_000,
    hookTimeout: 20_000
  }
});
