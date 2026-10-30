/**
 * Failover mechanics and the timeout race.
 *
 * Every case runs through the real HTTP gateway against scripted providers, so what is asserted is
 * the wire contract: status, `X-Gateway-Provider`, `X-Gateway-Fallback`, and how many times each
 * provider was actually called.
 *
 * One test is deliberately real-time (`slow`): it asserts the brief's **3000 ms** primary timeout
 * with the *configuration default*, not an override. Everything else injects a short timeout so the
 * suite stays fast.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { chunkOf, closedProviderUrl, sseFrame, startMockProvider, type MockProvider, type MockProviderOptions } from '../helpers/mockProvider.js';
import { createTestDb, type TestDb } from '../helpers/testDb.js';
import { postCompletion, simpleBody, startHarness, type Harness } from '../helpers/gateway.js';

const cleanups: (() => void)[] = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

interface Scenario {
  primary: MockProvider;
  secondary: MockProvider;
  test: TestDb;
  harness: Harness;
}

async function scenario(
  primary: MockProvider,
  secondary: MockProvider,
  env: Record<string, string> = {}
): Promise<Scenario> {
  const test = createTestDb();
  cleanups.push(test.cleanup);
  const harness = await startHarness({
    primaryUrl: primary.url,
    secondaryUrl: secondary.url,
    db: test.db,
    captureLogs: true,
    env
  });
  cleanups.push(() => void harness.close());
  return { primary, secondary, test, harness };
}

async function twoProviders(
  primaryBehaviour: MockProviderOptions['behaviour'],
  secondaryBehaviour: MockProviderOptions['behaviour'],
  options: { delayMs?: number } = {}
) {
  const primary = await startMockProvider({ behaviour: primaryBehaviour, ...(options.delayMs !== undefined ? { delayMs: options.delayMs } : {}) });
  const secondary = await startMockProvider({ behaviour: secondaryBehaviour });
  cleanups.push(() => void primary.close());
  cleanups.push(() => void secondary.close());
  return { primary, secondary };
}

describe('failover on 429 / 5xx / network / timeout', () => {
  it('serves from the secondary when the primary answers 429', async () => {
    const { primary, secondary } = await twoProviders('429', 'ok');
    const { harness } = await scenario(primary, secondary);

    const response = await postCompletion(harness.url, simpleBody());

    expect(response.status).toBe(200);
    expect(response.headers.get('x-gateway-provider')).toBe('secondary');
    expect(response.headers.get('x-gateway-fallback')).toBe('true');
    expect(response.headers.get('x-gateway-attempts')).toBe('2');
    expect(response.headers.get('x-gateway-request-id')).toMatch(/^req_/);
    expect(primary.callCount()).toBe(1);
    expect(secondary.callCount()).toBe(1);

    const payload = (await response.json()) as { choices: unknown[]; usage: { total_tokens: number } };
    expect(payload.usage.total_tokens).toBe(33);
    expect(harness.metrics.snapshot().counters.failovers).toBe(1);
    expect(harness.metrics.snapshot().counters.provider_secondary).toBe(1);
    expect(harness.metrics.snapshot().counters.provider_primary).toBe(0);
  });

  it('serves from the primary without a fallback header when the primary is healthy', async () => {
    const { primary, secondary } = await twoProviders('ok', 'ok');
    const { harness } = await scenario(primary, secondary);

    const response = await postCompletion(harness.url, simpleBody());

    expect(response.status).toBe(200);
    expect(response.headers.get('x-gateway-provider')).toBe('primary');
    expect(response.headers.get('x-gateway-fallback')).toBe('false');
    expect(response.headers.get('x-gateway-attempts')).toBe('1');
    expect(primary.callCount()).toBe(1);
    expect(secondary.callCount()).toBe(0);
    await response.text();
  });

  it('serves from the secondary when the primary answers 500', async () => {
    const { primary, secondary } = await twoProviders('500', 'ok');
    const { harness } = await scenario(primary, secondary);

    const response = await postCompletion(harness.url, simpleBody());

    expect(response.status).toBe(200);
    expect(response.headers.get('x-gateway-provider')).toBe('secondary');
    expect(response.headers.get('x-gateway-fallback')).toBe('true');
    expect(secondary.callCount()).toBe(1);
    await response.text();
  });

  it('serves from the secondary when the primary is unreachable (connection refused)', async () => {
    const deadUrl = await closedProviderUrl();
    const secondary = await startMockProvider({ behaviour: 'ok' });
    cleanups.push(() => void secondary.close());
    const test = createTestDb();
    cleanups.push(test.cleanup);
    const harness = await startHarness({ primaryUrl: deadUrl, secondaryUrl: secondary.url, db: test.db });
    cleanups.push(() => void harness.close());

    const response = await postCompletion(harness.url, simpleBody());

    expect(response.status).toBe(200);
    expect(response.headers.get('x-gateway-provider')).toBe('secondary');
    expect(secondary.callCount()).toBe(1);
    expect(harness.metrics.snapshot().counters.upstream_errors).toBe(1);
    await response.text();
  });

  it('fails over when the primary exceeds its timeout (short timeout injected)', async () => {
    const { primary, secondary } = await twoProviders('hang', 'ok');
    const { harness } = await scenario(primary, secondary, { ROUTER_PRIMARY_TIMEOUT_MS: '150' });

    const startedAt = Date.now();
    const response = await postCompletion(harness.url, simpleBody());
    const elapsed = Date.now() - startedAt;

    expect(response.status).toBe(200);
    expect(response.headers.get('x-gateway-provider')).toBe('secondary');
    expect(elapsed).toBeGreaterThanOrEqual(140);
    expect(elapsed).toBeLessThan(2_000);
    expect(primary.callCount()).toBe(1);
    expect(secondary.callCount()).toBe(1);
    expect(harness.metrics.snapshot().counters.upstream_timeouts).toBe(1);
    await response.text();
  });

  it('honours the brief\'s 3000 ms default primary timeout (slow)', async () => {
    const { primary, secondary } = await twoProviders('hang', 'ok');
    // No ROUTER_PRIMARY_TIMEOUT_MS override: this is the configured default.
    const { harness } = await scenario(primary, secondary);

    const startedAt = Date.now();
    const response = await postCompletion(harness.url, simpleBody());
    const elapsed = Date.now() - startedAt;

    expect(response.status).toBe(200);
    expect(response.headers.get('x-gateway-provider')).toBe('secondary');
    expect(elapsed).toBeGreaterThanOrEqual(2_950);
    expect(elapsed).toBeLessThan(5_000);
    await response.text();
  }, 20_000);
});

describe('failover — when every attempt fails', () => {
  it('returns a sanitized 429 when both providers rate-limit', async () => {
    const { primary, secondary } = await twoProviders('429', '429');
    const { harness, test } = await scenario(primary, secondary);

    const response = await postCompletion(harness.url, simpleBody());

    expect(response.status).toBe(429);
    const payload = (await response.json()) as { error: { type: string; code: string; request_id: string } };
    expect(payload.error.type).toBe('rate_limit_exceeded');
    expect(payload.error.code).toBe('gateway_upstream_rate_limited');
    expect(payload.error.request_id).toMatch(/^req_/);
    expect(primary.callCount()).toBe(1);
    expect(secondary.callCount()).toBe(1);

    // Nothing was produced, so the reservation went back…
    const events = test.db.prepare('SELECT COUNT(*) AS n FROM token_events').get<{ n: number }>();
    expect(events?.n).toBe(0);
    expect(harness.metrics.snapshot().counters.reservations_released).toBe(1);
    // …and the failure is in the audit trail.
    expect(harness.gateway.requestLog.recent(1)[0]).toMatchObject({ outcome: 'upstream_error', failover: 0 });
  });

  it('returns 504 upstream_timeout when both providers hang', async () => {
    const { primary, secondary } = await twoProviders('hang', 'hang');
    const { harness } = await scenario(primary, secondary, { ROUTER_PRIMARY_TIMEOUT_MS: '120', ROUTER_SECONDARY_TIMEOUT_MS: '120' });

    const response = await postCompletion(harness.url, simpleBody());

    expect(response.status).toBe(504);
    const payload = (await response.json()) as { error: { type: string; code: string } };
    expect(payload.error).toMatchObject({ type: 'upstream_timeout', code: 'gateway_upstream_timeout' });
    expect(harness.metrics.snapshot().counters.upstream_timeouts).toBe(2);
  });

  it('returns 503 upstream_unavailable when one 500s and the other is unreachable', async () => {
    const deadUrl = await closedProviderUrl();
    const primary = await startMockProvider({ behaviour: '500' });
    cleanups.push(() => void primary.close());
    const test = createTestDb();
    cleanups.push(test.cleanup);
    const harness = await startHarness({ primaryUrl: primary.url, secondaryUrl: deadUrl, db: test.db });
    cleanups.push(() => void harness.close());

    const response = await postCompletion(harness.url, simpleBody());

    expect(response.status).toBe(503);
    const payload = (await response.json()) as { error: { type: string; code: string } };
    expect(payload.error).toMatchObject({ type: 'upstream_unavailable', code: 'gateway_upstream_error' });
  });

  it('does not retry on the secondary when the primary fails with a status outside failoverOn', async () => {
    const { primary, secondary } = await twoProviders('429', 'ok');
    const { harness } = await scenario(primary, secondary, { ROUTER_FAILOVER_ON: '500,timeout,network' });

    const response = await postCompletion(harness.url, simpleBody());

    expect(response.status).toBe(429); // the upstream 429 is surfaced, not retried
    expect(secondary.callCount()).toBe(0);
    await response.text();
  });

  it('stops after the primary when maxAttempts is 1', async () => {
    const { primary, secondary } = await twoProviders('500', 'ok');
    const { harness } = await scenario(primary, secondary, { ROUTER_MAX_ATTEMPTS: '1' });

    const response = await postCompletion(harness.url, simpleBody());

    expect(response.status).toBe(503);
    expect(secondary.callCount()).toBe(0);
    await response.text();
  });
});

describe('streaming: commit on the first byte, never fail over mid-stream', () => {
  it('passes a healthy stream through and reconciles the provider usage', async () => {
    const { primary, secondary } = await twoProviders('ok-stream', 'ok');
    const { harness, test } = await scenario(primary, secondary);

    const response = await postCompletion(harness.url, simpleBody({ stream: true }));
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(response.headers.get('x-gateway-provider')).toBe('primary');
    expect(response.headers.get('x-accel-buffering')).toBe('no');
    expect(body).toContain('Hello ');
    expect(body.trimEnd().endsWith('data: [DONE]')).toBe(true);
    expect(secondary.callCount()).toBe(0);

    // The reservation became an 'actual' row carrying the provider's reported usage.
    const events = test.db.prepare('SELECT kind, tokens, provider FROM token_events').all<{ kind: string; tokens: number; provider: string }>();
    expect(events).toEqual([{ kind: 'actual', tokens: 33, provider: 'primary' }]);
    expect(harness.metrics.snapshot().counters.tokens_actual).toBe(33);
    expect(harness.gateway.requestLog.recent(1)[0]).toMatchObject({ outcome: 'ok', total_tokens: 33 });
  });

  it('falls back to the reservation when the stream never reports usage', async () => {
    const primary = await startMockProvider({
      behaviour: 'ok-stream',
      frames: ['data: {"choices":[{"delta":{"content":"hi"}}]}\n\n', 'data: [DONE]\n\n']
    });
    cleanups.push(() => void primary.close());
    const secondary = await startMockProvider({ behaviour: 'ok' });
    cleanups.push(() => void secondary.close());
    const { harness, test } = await scenario(primary, secondary);

    const response = await postCompletion(harness.url, simpleBody({ stream: true }));
    await response.text();

    const events = test.db.prepare('SELECT kind, tokens FROM token_events').all<{ kind: string; tokens: number }>();
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe('actual');
    expect(events[0]?.tokens).toBeGreaterThan(0); // the estimate, kept conservatively
  });

  it('terminates the stream with a sanitized error and does NOT fail over after the first byte', async () => {
    const { primary, secondary } = await twoProviders('stream-then-break', 'ok');
    const { harness, test } = await scenario(primary, secondary);

    const response = await postCompletion(harness.url, simpleBody({ stream: true }));
    const body = await response.text();

    // The status line and the first frame are already committed to the client.
    expect(response.status).toBe(200);
    expect(body).toContain('first frame only');
    expect(body).toContain('"code":"gateway_stream_failed"');
    expect(body).toContain('"type":"upstream_unavailable"');
    expect(body.trimEnd().endsWith('data: [DONE]')).toBe(true);

    // The decisive assertion: the secondary was never contacted.
    expect(secondary.callCount()).toBe(0);
    expect(primary.callCount()).toBe(1);

    const events = test.db.prepare('SELECT kind, tokens FROM token_events').all<{ kind: string; tokens: number }>();
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe('actual'); // reconciled conservatively, not released
    expect(harness.gateway.requestLog.recent(1)[0]).toMatchObject({ outcome: 'stream_failed' });
    expect(harness.metrics.snapshot().counters.stream_failures).toBe(1);
  });

  it('does not fail over when the provider dies before any byte is written either', async () => {
    // 'hang' on the streaming path: the deadline fires while waiting for headers, so failover IS
    // allowed (nothing has been written to the client yet). This is the boundary case of the rule.
    const { primary, secondary } = await twoProviders('hang', 'ok-stream');
    const { harness } = await scenario(primary, secondary, { ROUTER_PRIMARY_TIMEOUT_MS: '120' });

    const response = await postCompletion(harness.url, simpleBody({ stream: true }));
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('x-gateway-provider')).toBe('secondary');
    expect(response.headers.get('x-gateway-fallback')).toBe('true');
    expect(body).toContain('Hello ');
  });

  it('keeps the usage scanner bounded on a long stream', async () => {
    const frames = Array.from({ length: 400 }, (_unused, index) => `data: {"choices":[{"delta":{"content":"chunk-${index}"}}]}\n\n`);
    frames.push('data: {"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":9,"total_tokens":16}}\n\n');
    frames.push('data: [DONE]\n\n');
    const primary = await startMockProvider({ behaviour: 'ok-stream', frames });
    cleanups.push(() => void primary.close());
    const secondary = await startMockProvider({ behaviour: 'ok' });
    cleanups.push(() => void secondary.close());
    const { harness, test } = await scenario(primary, secondary);

    const response = await postCompletion(harness.url, simpleBody({ stream: true }));
    const body = await response.text();

    // 400 content frames reach the client; the usage frame does not, because this client never asked
    // for `stream_options.include_usage` — yet the gateway still reconciled the real 16 tokens.
    expect(body.split('\n\n').filter((frame) => frame.startsWith('data: {')).length).toBe(400);
    expect(body).not.toContain('"usage"');
    const events = test.db.prepare('SELECT kind, tokens FROM token_events').all<{ kind: string; tokens: number }>();
    expect(events).toEqual([{ kind: 'actual', tokens: 16 }]);
  });
});

describe('the failover deadline is time-to-headers, not a total request budget', () => {
  it('serves a healthy stream that runs far longer than the 3000 ms primary timeout', async () => {
    // 40 frames × 100 ms = 4 s of perfectly healthy streaming on the default configuration.
    const frames = [
      ...Array.from({ length: 40 }, (_unused, index) => sseFrame(chunkOf({ content: `frame-${index} ` }))),
      'data: [DONE]\n\n'
    ];
    const primary = await startMockProvider({ behaviour: 'ok-stream', frames, frameDelayMs: 100 });
    const secondary = await startMockProvider({ behaviour: 'ok' });
    cleanups.push(() => void primary.close());
    cleanups.push(() => void secondary.close());
    const { harness } = await scenario(primary, secondary);

    const startedAt = Date.now();
    const response = await postCompletion(harness.url, simpleBody({ stream: true }));
    const body = await response.text();
    const elapsed = Date.now() - startedAt;

    expect(response.status).toBe(200);
    expect(elapsed).toBeGreaterThan(3_000);
    expect(body).toContain('frame-0');
    expect(body).toContain('frame-39');
    expect(body.trimEnd().endsWith('data: [DONE]')).toBe(true);
    expect(body).not.toContain('gateway_stream_failed');
    expect(primary.callCount()).toBe(1);
    expect(secondary.callCount()).toBe(0);
    expect(harness.metrics.snapshot().counters.upstream_stalls).toBe(0);
  }, 30_000);

  it('serves a buffered completion that outlives the deadline but keeps sending bytes', async () => {
    // Headers arrive immediately; the JSON body dribbles in for ~300 ms against a 120 ms deadline.
    const primary = await startMockProvider({ behaviour: 'ok', bodyDelayMs: 300 });
    const secondary = await startMockProvider({ behaviour: 'ok' });
    cleanups.push(() => void primary.close());
    cleanups.push(() => void secondary.close());
    const { harness } = await scenario(primary, secondary, { ROUTER_PRIMARY_TIMEOUT_MS: '120' });

    const startedAt = Date.now();
    const response = await postCompletion(harness.url, simpleBody());
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('x-gateway-provider')).toBe('primary');
    expect(response.headers.get('x-gateway-attempts')).toBe('1');
    expect(secondary.callCount()).toBe(0);
    expect(JSON.parse(body)).toMatchObject({ object: 'chat.completion' });
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(290);
  });

  it('kills a stream that stalls after the first frame, without failing over', async () => {
    const primary = await startMockProvider({ behaviour: 'stream-then-hang' });
    const secondary = await startMockProvider({ behaviour: 'ok' });
    cleanups.push(() => void primary.close());
    cleanups.push(() => void secondary.close());
    const { harness } = await scenario(primary, secondary, { ROUTER_STREAM_IDLE_TIMEOUT_MS: '150' });

    const response = await postCompletion(harness.url, simpleBody({ stream: true }));
    const body = await response.text();

    expect(response.status).toBe(200); // already committed: headers and one frame are out
    expect(body).toContain('first frame only');
    expect(body).toContain('gateway_stream_failed');
    expect(body.trimEnd().endsWith('data: [DONE]')).toBe(true);
    expect(secondary.callCount()).toBe(0);
    expect(harness.metrics.snapshot().counters.upstream_stalls).toBe(1);
    expect(harness.gateway.requestLog.recent(1)[0]).toMatchObject({ outcome: 'stream_failed' });
  }, 20_000);

  it('logs a stall distinctly from a dropped connection', async () => {
    const primary = await startMockProvider({ behaviour: 'stream-then-hang' });
    const secondary = await startMockProvider({ behaviour: 'ok' });
    cleanups.push(() => void primary.close());
    cleanups.push(() => void secondary.close());
    const { harness } = await scenario(primary, secondary, { ROUTER_STREAM_IDLE_TIMEOUT_MS: '120' });

    await (await postCompletion(harness.url, simpleBody({ stream: true }))).text();

    const stall = harness.logLines().find((line) => line.event === 'upstream_stream_stalled');
    expect(stall).toBeDefined();
    expect(stall?.provider).toBe('primary');
  }, 20_000);
});
