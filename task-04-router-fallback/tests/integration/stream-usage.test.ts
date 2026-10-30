/**
 * Streamed completions must be charged what they actually cost.
 *
 * A provider only reports `usage` on a stream when the request asked for it
 * (`stream_options.include_usage`), and the OpenAI client default is *not* to ask. Without this the
 * gateway can only charge the admission estimate: measured against llama.cpp, a 447-token answer was
 * billed as 45 tokens.
 *
 * So the router asks on the client's behalf and then hides the frame again when the client did not
 * request it — the visible contract stays exactly what the client asked for, while the accounting is
 * exact.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { startMockProvider, type MockProvider } from '../helpers/mockProvider.js';
import { createTestDb, type TestDb } from '../helpers/testDb.js';
import { postCompletion, simpleBody, startHarness, type Harness } from '../helpers/gateway.js';

const REAL_USAGE = { prompt_tokens: 41, completion_tokens: 406, total_tokens: 447 };

const cleanups: (() => void)[] = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

async function scenario(env: Record<string, string> = {}): Promise<{ primary: MockProvider; harness: Harness; test: TestDb }> {
  const primary = await startMockProvider({ behaviour: 'ok-stream', usageMode: 'on-request', usage: REAL_USAGE });
  cleanups.push(() => void primary.close());
  const test = createTestDb();
  cleanups.push(test.cleanup);
  const harness = await startHarness({ primaryUrl: primary.url, secondaryUrl: primary.url, db: test.db, env });
  cleanups.push(() => void harness.close());
  return { primary, harness, test };
}

function chargedTokens(test: TestDb): number[] {
  return test.db
    .prepare('SELECT tokens FROM token_events ORDER BY id')
    .all<{ tokens: number }>()
    .map((row) => row.tokens);
}

describe('streamed usage accounting', () => {
  it('asks the provider for usage and reconciles the real token count', async () => {
    const { primary, harness, test } = await scenario();

    const response = await postCompletion(harness.url, simpleBody({ stream: true }));
    const body = await response.text();

    // 1. the gateway asked on the client's behalf (this is what makes the accounting exact)
    const upstream = JSON.parse(primary.calls[0]?.raw ?? '{}') as { stream_options?: Record<string, unknown> };
    expect(upstream.stream_options).toMatchObject({ include_usage: true });

    // 2. the client did not ask for usage, so it does not receive it
    expect(body).not.toContain('"usage"');
    expect(body).toContain('data: [DONE]');

    // 3. …and the tenant was charged the provider's real number, not the estimate
    expect(chargedTokens(test)).toEqual([REAL_USAGE.total_tokens]);
    expect(harness.metrics.snapshot().counters.usage_frames_stripped).toBe(1);
    expect(harness.gateway.requestLog.recent(1)[0]).toMatchObject({ total_tokens: REAL_USAGE.total_tokens, outcome: 'ok' });
  });

  it('forwards the usage frame verbatim when the client asks for it', async () => {
    const { harness, test } = await scenario();

    const response = await postCompletion(harness.url, simpleBody({ stream: true, stream_options: { include_usage: true } }));
    const body = await response.text();

    expect(body).toContain('"usage"');
    expect(body).toContain(String(REAL_USAGE.total_tokens));
    expect(chargedTokens(test)).toEqual([REAL_USAGE.total_tokens]);
    expect(harness.metrics.snapshot().counters.usage_frames_stripped).toBe(0);
  });

  it('leaves other stream_options fields the client sent untouched', async () => {
    const { primary, harness } = await scenario();

    await (
      await postCompletion(harness.url, simpleBody({ stream: true, stream_options: { include_usage: false, custom: 'kept' } }))
    ).text();

    const upstream = JSON.parse(primary.calls[0]?.raw ?? '{}') as { stream_options?: Record<string, unknown> };
    expect(upstream.stream_options).toEqual({ include_usage: true, custom: 'kept' });
  });

  it('does not touch a non-streaming request', async () => {
    const primary = await startMockProvider({ behaviour: 'ok', usage: REAL_USAGE });
    cleanups.push(() => void primary.close());
    const test = createTestDb();
    cleanups.push(test.cleanup);
    const harness = await startHarness({ primaryUrl: primary.url, secondaryUrl: primary.url, db: test.db });
    cleanups.push(() => void harness.close());

    const response = await postCompletion(harness.url, simpleBody());
    await response.text();

    const upstream = JSON.parse(primary.calls[0]?.raw ?? '{}') as Record<string, unknown>;
    expect(upstream.stream_options).toBeUndefined();
    expect(chargedTokens(test)).toEqual([REAL_USAGE.total_tokens]);
  });

  it('can be switched off, falling back to the reservation', async () => {
    const { primary, harness, test } = await scenario({
      ROUTER_INJECT_STREAM_USAGE: 'false',
      ROUTER_OUTPUT_RESERVE_TOKENS: '250',
      ROUTER_MAX_OUTPUT_RESERVE_TOKENS: '1000' // the harness zeroes the cap by default
    });

    const response = await postCompletion(harness.url, simpleBody({ stream: true }));
    await response.text();

    const upstream = JSON.parse(primary.calls[0]?.raw ?? '{}') as Record<string, unknown>;
    expect(upstream.stream_options).toBeUndefined();
    // No usage was reported, so the conservative reservation is kept instead of a made-up number.
    expect(chargedTokens(test)).toEqual([8 + 250]);
    expect(harness.metrics.snapshot().counters.usage_frames_stripped).toBe(0);
  });
});
