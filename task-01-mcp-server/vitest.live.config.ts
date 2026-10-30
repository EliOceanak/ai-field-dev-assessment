import { defineConfig } from 'vitest/config';

/**
 * Opt-in live suite: talks to a real OpenAI-compatible server (llama.cpp by
 * default) and needs a tool-calling model. Run with:
 *
 *   RUN_LIVE_LLM=1 npm run test:live
 *
 * Without RUN_LIVE_LLM=1 the suites skip themselves (and the run still exits 0).
 */
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
