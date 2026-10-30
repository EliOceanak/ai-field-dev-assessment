import { defineConfig } from 'vitest/config';

/** Opt-in live suite (real MCP server / real model). Run: RUN_LIVE_LLM=1 npm run test:live */
export default defineConfig({
  test: {
    include: ['tests/live/**/*.live.test.ts'],
    testTimeout: 180_000,
    hookTimeout: 180_000,
    fileParallelism: false,
    /** Exit 0 rather than fail when a workspace has no live test files. */
    passWithNoTests: true
  }
});
