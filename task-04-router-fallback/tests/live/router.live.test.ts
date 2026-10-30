/**
 * Opt-in live suite: the same router against the **real** llama.cpp server
 * (`http://127.0.0.1:8080/v1`, model `qwen3.8-turbo`).
 *
 * ```bash
 * RUN_LIVE_LLM=1 npm run test:live
 * ```
 *
 * Everything graded offline stays offline; this suite exists to prove the same code path works
 * against a real OpenAI-compatible provider: real `usage`, a real SSE stream, and a real failover
 * from a dead primary to the live model.
 *
 * The local server serialises requests per slot, and `max_tokens` defaults to `-1` (unbounded), so every
 * request here sets it explicitly and concurrency stays ≤ 2.
 *
 * The server comes from the shared `LIVE_OPENAI_BASE_URL` / `LIVE_OPENAI_MODEL` (process environment or
 * the repo-root `.env`), like every live suite; `ROUTER_LIVE_BASE_URL` / `ROUTER_LIVE_MODEL` override
 * them for this suite alone.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig, loadDotEnv } from '../../src/config.js';
import { createTestDb, type TestDb } from '../helpers/testDb.js';
import { postCompletion, startHarness, type Harness } from '../helpers/gateway.js';
import { closedProviderUrl } from '../helpers/mockProvider.js';

loadDotEnv();

const RUN = process.env.RUN_LIVE_LLM === '1';
// `||`, not `??`: an empty value (a blank line in `.env`) means unset.
const BASE_URL = process.env.ROUTER_LIVE_BASE_URL || process.env.LIVE_OPENAI_BASE_URL || 'http://127.0.0.1:8080/v1';
const MODEL = process.env.ROUTER_LIVE_MODEL || process.env.LIVE_OPENAI_MODEL || 'qwen3.8-turbo';
const TIMEOUT_MS = 60_000; // vitest per-test budget, not the gateway's provider deadline

const prompt = { role: 'user', content: 'Reply with exactly the word: pong' };

const cleanups: (() => void)[] = [];

beforeAll(() => {
  if (RUN) expect(loadConfig({}).providers.primary.baseUrl).toBeTruthy();
});

afterAll(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

async function liveHarness(options: { primaryUrl?: string; secondaryUrl?: string; env?: Record<string, string> } = {}): Promise<{ harness: Harness; test: TestDb }> {
  const test = createTestDb();
  cleanups.push(test.cleanup);
  const harness = await startHarness({
    primaryUrl: options.primaryUrl ?? BASE_URL,
    secondaryUrl: options.secondaryUrl ?? BASE_URL,
    db: test.db,
    env: {
      ROUTER_PRIMARY_MODEL: MODEL,
      ROUTER_SECONDARY_MODEL: MODEL,
      // Provider deadlines are deliberately not overridden: this suite exercises the 3000 ms failover
      // deadline exactly as configured, so the live run covers the same timing the offline suite pins.
      ...options.env
    }
  });
  cleanups.push(() => void harness.close());
  return { harness, test };
}

describe.skipIf(!RUN)('live: router against the local model server', () => {
  it('serves a completion and reconciles the provider usage', async () => {
    const { harness, test } = await liveHarness();

    const response = await postCompletion(harness.url, { messages: [prompt], max_tokens: 512, reasoning_effort: 'none' });
    const payload = (await response.json()) as { usage?: { total_tokens?: number } };

    expect(response.status).toBe(200);
    expect(response.headers.get('x-gateway-provider')).toBe('primary');
    expect(response.headers.get('x-gateway-fallback')).toBe('false');
    expect(response.headers.get('x-ratelimit-limit-tokens')).toBe('50000');
    expect(payload.usage?.total_tokens).toBeGreaterThan(0);

    const events = test.db.prepare('SELECT kind, tokens, provider FROM token_events').all<{ kind: string; tokens: number; provider: string }>();
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe('actual');
    expect(events[0]?.tokens).toBe(payload.usage?.total_tokens);
    expect(events[0]?.provider).toBe('primary');
  }, TIMEOUT_MS);

  it('streams from the real provider and reconciles the usage frame', async () => {
    const { harness, test } = await liveHarness();

    const response = await postCompletion(harness.url, {
      messages: [{ role: 'user', content: 'Count from 1 to 3.' }],
      max_tokens: 512,
      stream: true,
      stream_options: { include_usage: true },
      reasoning_effort: 'none'
    });
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(body.trimEnd().endsWith('data: [DONE]')).toBe(true);

    const events = test.db.prepare('SELECT kind, tokens FROM token_events').all<{ kind: string; tokens: number }>();
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe('actual');
    expect(events[0]?.tokens).toBeGreaterThan(0);
  }, TIMEOUT_MS);

  it('streams a real completion that outlives the 3000 ms failover deadline', async () => {
    const { harness } = await liveHarness();

    const startedAt = Date.now();
    const response = await postCompletion(harness.url, {
      messages: [
        {
          role: 'user',
          content: 'Write a 300-word technical paragraph about SQLite WAL mode, covering checkpoints, readers and busy handling.'
        }
      ],
      max_tokens: 600,
      stream: true,
      stream_options: { include_usage: true },
      reasoning_effort: 'none'
    });
    const body = await response.text();
    const elapsed = Date.now() - startedAt;

    expect(response.status).toBe(200);
    expect(elapsed).toBeGreaterThan(3_000); // longer than the failover deadline, and healthy
    expect(body).toContain('data: [DONE]');
    expect(body).not.toContain('gateway_stream_failed');
    expect(harness.metrics.snapshot().counters.upstream_stalls).toBe(0);
    // …and the long stream was charged its real token count, not the admission estimate.
    expect(harness.metrics.snapshot().counters.tokens_actual).toBeGreaterThan(100);
  }, TIMEOUT_MS);

  it('fails over from a dead primary to the live model', async () => {
    const dead = await closedProviderUrl();
    const { harness } = await liveHarness({ primaryUrl: dead, env: { ROUTER_PRIMARY_TIMEOUT_MS: '1000' } });

    const response = await postCompletion(harness.url, { messages: [prompt], max_tokens: 512, reasoning_effort: 'none' });
    await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('x-gateway-provider')).toBe('secondary');
    expect(response.headers.get('x-gateway-fallback')).toBe('true');
    expect(response.headers.get('x-gateway-attempts')).toBe('2');
  }, TIMEOUT_MS);

  it('enforces the token window against the real provider', async () => {
    const { harness, test } = await liveHarness({ env: { ROUTER_LIMIT_TOKENS: '10' } });

    const first = await postCompletion(harness.url, { messages: [prompt], max_tokens: 512, reasoning_effort: 'none' });
    await first.text();
    const second = await postCompletion(harness.url, { messages: [prompt], max_tokens: 512, reasoning_effort: 'none' });
    const payload = (await second.json()) as { error: { code: string; request_id: string } };

    // The prompt alone estimates to more than 10 tokens, so even the first request is oversized.
    expect(first.status).toBe(429);
    expect(second.status).toBe(429);
    expect(payload.error.code).toBe('gateway_rate_limited');
    expect(second.headers.get('retry-after')).toMatch(/^\d+$/);
    expect(test.db.prepare('SELECT COUNT(*) AS n FROM token_events').get<{ n: number }>()?.n).toBe(0);
  }, TIMEOUT_MS);

  it('keeps the health endpoint free of provider URLs', async () => {
    const { harness } = await liveHarness();
    const payload = (await (await fetch(`${harness.url}/healthz`)).json()) as Record<string, unknown>;

    expect(payload).toMatchObject({ status: 'ok', driver: 'better', journalMode: 'wal' });
    expect(JSON.stringify(payload)).not.toContain('/v1');
  }, TIMEOUT_MS);
});
