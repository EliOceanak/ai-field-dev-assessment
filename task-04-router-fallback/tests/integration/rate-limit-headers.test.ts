/**
 * The rate-limit wire contract: `429` + `Retry-After` + `X-RateLimit-*`, and a request that succeeds
 * again the moment the window rolls over.
 *
 * Time is injected (`ROUTER`'s `now` is the same clock the limiter uses), so rollover is asserted by
 * moving the clock, never by sleeping.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { estimateTokens } from '../../src/ratelimit/counter.js';
import { startMockProvider, type MockProvider, type MockProviderOptions } from '../helpers/mockProvider.js';
import { createTestDb, type TestDb } from '../helpers/testDb.js';
import { createClock } from '../helpers/clock.js';
import { OTHER_TENANT_KEY, postCompletion, simpleBody, startHarness, TEST_TENANT_KEY, type Harness } from '../helpers/gateway.js';

const WINDOW_MS = 60_000;
const LIMIT = 1_000;

const cleanups: (() => void)[] = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

interface Fixture {
  harness: Harness;
  provider: MockProvider;
  test: TestDb;
  clock: ReturnType<typeof createClock>;
}

async function fixture(env: Record<string, string> = {}, providerOptions: MockProviderOptions = {}): Promise<Fixture> {
  const provider = await startMockProvider({ behaviour: 'ok', ...providerOptions });
  cleanups.push(() => void provider.close());
  const test = createTestDb();
  cleanups.push(test.cleanup);
  const clock = createClock();
  const harness = await startHarness({
    primaryUrl: provider.url,
    secondaryUrl: provider.url,
    db: test.db,
    now: clock.now,
    env: { ROUTER_LIMIT_TOKENS: String(LIMIT), ROUTER_WINDOW_MS: String(WINDOW_MS), ...env }
  });
  cleanups.push(() => void harness.close());
  return { harness, provider, test, clock };
}

/** A body that estimates to exactly `tokens` — role + content + per-message overhead. */
function bodyOf(tokens: number): Record<string, unknown> {
  return { messages: [{ role: 'user', content: 'a'.repeat(Math.max(0, tokens - 5) * 4) }] };
}

/**
 * A provider that reports back exactly what the request reserved, so the window stays *full* after a
 * successful request (with a small `usage` the reservation would be reconciled down and the tenant
 * would immediately have headroom again — also correct, just not what these cases need).
 */
const FILLS_WINDOW: MockProviderOptions = { usage: { prompt_tokens: 1_000, completion_tokens: 0, total_tokens: 1_000 } };

describe('rate-limit headers and window rollover', () => {
  it('advertises the window on a successful response', async () => {
    const { harness, clock } = await fixture();

    const response = await postCompletion(harness.url, bodyOf(400));
    await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('x-ratelimit-limit-tokens')).toBe(String(LIMIT));
    // The provider reported 33 tokens of usage, so the reservation was reconciled down: 1000 − 33.
    expect(response.headers.get('x-ratelimit-remaining-tokens')).toBe('967');
    expect(response.headers.get('x-ratelimit-reset')).toBe(String(Math.ceil((clock.current() + WINDOW_MS) / 1000)));
    expect(response.headers.get('retry-after')).toBeNull();
  });

  it('rejects with 429, Retry-After and the full rate-limit header set', async () => {
    const { harness, clock } = await fixture({}, FILLS_WINDOW);

    const first = await postCompletion(harness.url, bodyOf(1_000));
    await first.text();
    expect(first.status).toBe(200);

    clock.advance(10_000);
    const rejected = await postCompletion(harness.url, bodyOf(1));
    const payload = (await rejected.json()) as { error: { message: string; type: string; code: string; request_id: string } };

    expect(rejected.status).toBe(429);
    expect(rejected.headers.get('retry-after')).toBe('50'); // 60 s window − 10 s elapsed
    expect(rejected.headers.get('x-ratelimit-limit-tokens')).toBe(String(LIMIT));
    expect(rejected.headers.get('x-ratelimit-remaining-tokens')).toBe('0');
    expect(rejected.headers.get('x-ratelimit-reset')).toBe(String(Math.ceil((clock.current() + 50_000) / 1000)));
    expect(payload.error).toMatchObject({
      message: 'Rate limit exceeded for this tenant key',
      type: 'rate_limit_exceeded',
      code: 'gateway_rate_limited'
    });
    expect(payload.error.request_id).toMatch(/^req_/);
  });

  it('never advertises a Retry-After below one second', async () => {
    const { harness, clock } = await fixture({}, FILLS_WINDOW);

    await (await postCompletion(harness.url, bodyOf(1_000))).text();
    clock.advance(WINDOW_MS - 1); // 1 ms of window left
    const rejected = await postCompletion(harness.url, bodyOf(1));
    await rejected.text();

    expect(rejected.status).toBe(429);
    expect(rejected.headers.get('retry-after')).toBe('1');
  });

  it('serves the next request as soon as the window rolls over', async () => {
    const { harness, clock, provider } = await fixture({}, FILLS_WINDOW);

    expect((await postCompletion(harness.url, bodyOf(1_000))).status).toBe(200);
    expect((await postCompletion(harness.url, bodyOf(1_000))).status).toBe(429);

    clock.advance(WINDOW_MS + 1);
    const after = await postCompletion(harness.url, bodyOf(1_000));
    await after.text();

    expect(after.status).toBe(200);
    expect(after.headers.get('x-ratelimit-remaining-tokens')).toBe('0');
    expect(provider.callCount()).toBe(2); // only the two admitted requests were forwarded
  });

  it('applies the limit per tenant key', async () => {
    const { harness } = await fixture({}, FILLS_WINDOW);

    expect((await postCompletion(harness.url, bodyOf(1_000), { key: TEST_TENANT_KEY })).status).toBe(200);
    expect((await postCompletion(harness.url, bodyOf(1_000), { key: TEST_TENANT_KEY })).status).toBe(429);

    const other = await postCompletion(harness.url, bodyOf(1_000), { key: OTHER_TENANT_KEY });
    await other.text();
    expect(other.status).toBe(200);
    expect(other.headers.get('x-ratelimit-remaining-tokens')).toBe('0');
  });

  it('accepts the tenant key from x-tenant-key and x-api-key as well as Bearer', async () => {
    const { harness } = await fixture();

    const viaHeader = await fetch(`${harness.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-tenant-key': TEST_TENANT_KEY },
      body: JSON.stringify(simpleBody())
    });
    await viaHeader.text();
    expect(viaHeader.status).toBe(200);

    const viaApiKey = await fetch(`${harness.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': TEST_TENANT_KEY },
      body: JSON.stringify(simpleBody())
    });
    await viaApiKey.text();
    expect(viaApiKey.status).toBe(200);

    // Both spellings resolve to the same tenant, so the window is shared.
    const rows = harness.db.prepare('SELECT tenant_id, COUNT(*) AS n FROM token_events GROUP BY tenant_id').all<{ n: number }>();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.n).toBe(2);
  });
});

describe('health, stats and metrics endpoints', () => {
  it('reports liveness, driver and journal mode on /healthz', async () => {
    const { harness } = await fixture();
    const payload = (await (await fetch(`${harness.url}/healthz`)).json()) as Record<string, unknown>;

    expect(payload).toMatchObject({
      status: 'ok',
      driver: 'better',
      journalMode: 'wal',
      windowMs: WINDOW_MS,
      limitTokens: LIMIT
    });
    // Hosts only — never the full provider URL.
    expect(JSON.stringify(payload)).not.toContain('/v1');
  });

  it('exposes counters and the recent request log on /stats', async () => {
    const { harness } = await fixture();
    await (await postCompletion(harness.url, bodyOf(1_000))).text();
    await (await postCompletion(harness.url, bodyOf(1_000))).text();

    const payload = (await (await fetch(`${harness.url}/stats`)).json()) as {
      counters: Record<string, number>;
      config: Record<string, unknown>;
      recentRequests: { outcome: string }[];
    };

    expect(payload.counters).toMatchObject({ requests: 2, admitted: 1, rate_limited: 1, provider_primary: 1 });
    expect(payload.config).toMatchObject({ limitTokens: LIMIT, windowMs: WINDOW_MS, maxAttempts: 2 });
    expect(payload.recentRequests.map((row) => row.outcome)).toContain('rate_limited');
  });

  it('exposes Prometheus text on /metrics', async () => {
    const { harness } = await fixture();
    await (await postCompletion(harness.url, bodyOf(1_000))).text();

    const response = await fetch(`${harness.url}/metrics`);
    const text = await response.text();

    expect(response.headers.get('content-type')).toContain('text/plain');
    expect(text).toContain('# TYPE gateway_admitted_total counter');
    expect(text).toMatch(/gateway_admitted_total 1\n/);
    expect(text).toMatch(/gateway_requests_total 1\n/);
    expect(text).toMatch(/gateway_uptime_milliseconds \d+/);
  });
});

describe('Retry-After and the output reserve', () => {
  it('advertises a Retry-After that actually works, not the oldest expiry', async () => {
    // `omitUsage` keeps the reservation (nothing to reconcile against), so the window fills with the
    // *estimated* sizes and the arithmetic is deterministic.
    const { harness, clock } = await fixture({ ROUTER_LIMIT_TOKENS: '5000' }, { omitUsage: true });
    const key = 'retry-after-tenant';

    await (await postCompletion(harness.url, bodyOf(100), { key })).text();
    clock.advance(10_000);
    await (await postCompletion(harness.url, bodyOf(1_000), { key })).text();
    clock.advance(10_000);
    await (await postCompletion(harness.url, bodyOf(1_000), { key })).text();
    clock.advance(10_000); // +30 s, 2 100 of 5 000 used

    const denied = await postCompletion(harness.url, bodyOf(4_000), { key });
    await denied.text();
    expect(denied.status).toBe(429);
    // The oldest event frees 100 tokens at +60 s (2 100 − 100 + 4 000 = 6 000 > 5 000) — answering
    // "30" here is what made a well-behaved client come back and get rejected again.
    expect(denied.headers.get('retry-after')).toBe('40');

    // The instant the old header would have named is genuinely too early…
    clock.advance(10_000); // +40 s
    const tooEarly = await postCompletion(harness.url, bodyOf(4_000), { key });
    await tooEarly.text();
    expect(tooEarly.status).toBe(429);

    // …and the instant we advertised is not.
    clock.advance(30_000); // +70 s
    const onTime = await postCompletion(harness.url, bodyOf(4_000), { key });
    await onTime.text();
    expect(onTime.status).toBe(200);
  });

  it('reserves the declared output budget, so a request cannot spend the window on input alone', async () => {
    const body = { ...simpleBody(), max_tokens: 400 };
    const inputTokens = estimateTokens(body, loadConfig({}));
    const reserveEnv = { ROUTER_OUTPUT_RESERVE_TOKENS: '400', ROUTER_MAX_OUTPUT_RESERVE_TOKENS: '1000' };

    // One token short of input + max_tokens → rejected before any provider is contacted.
    const tight = await fixture({ ...reserveEnv, ROUTER_LIMIT_TOKENS: String(inputTokens + 399) });
    const rejected = await postCompletion(tight.harness.url, body);
    await rejected.text();
    expect(rejected.status).toBe(429);
    expect(tight.provider.callCount()).toBe(0);

    // Exactly input + max_tokens → admitted.
    const exact = await fixture({ ...reserveEnv, ROUTER_LIMIT_TOKENS: String(inputTokens + 400) });
    const accepted = await postCompletion(exact.harness.url, body);
    await accepted.text();
    expect(accepted.status).toBe(200);
  });
});
