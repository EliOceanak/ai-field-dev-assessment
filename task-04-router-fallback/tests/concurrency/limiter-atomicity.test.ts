/**
 * The decisive test for the limiter: **20 parallel requests × 6 000 estimated tokens against a
 * 50 000-token limit ⇒ exactly 8 admitted, 12 rejected.**
 *
 * 8 × 6 000 = 48 000 ≤ 50 000 and 9 × 6 000 = 54 000 > 50 000, so "exactly 8" is the only correct
 * answer. A check-then-insert implementation in two transactions admits more (each concurrent
 * request reads the same `used` and decides it fits); this suite fails loudly if that regression is
 * ever introduced, at two levels:
 *
 *  1. the limiter API, driven through the same per-tenant mutex the router uses;
 *  2. the real HTTP gateway, with a body that estimates to exactly 6 000 tokens.
 *
 * Both are repeated (5× and 3×) so a lucky interleaving cannot pass.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { estimateTokens } from '../../src/ratelimit/counter.js';
import { createMutex } from '../../src/ratelimit/mutex.js';
import { createTokenWindow, type TokenWindow } from '../../src/ratelimit/tokenWindow.js';
import { createTestDb, type TestDb } from '../helpers/testDb.js';
import { bodyWithEstimatedTokens, postCompletion, startHarness, TEST_TENANT_KEY } from '../helpers/gateway.js';
import { startMockProvider, type MockProvider } from '../helpers/mockProvider.js';

const PARALLEL = 20;
const TOKENS_EACH = 6_000;
const LIMIT = 50_000;
const EXPECTED_ADMITTED = 8;

const cleanups: (() => void)[] = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function setup(): { window: TokenWindow; test: TestDb } {
  const test = createTestDb();
  cleanups.push(test.cleanup);
  const window = createTokenWindow({ db: test.db, windowMs: 60_000, limitTokens: LIMIT });
  return { window, test };
}

describe('limiter atomicity — the limiter API', () => {
  it('admits exactly 8 of 20 parallel 6 000-token requests, five times in a row', async () => {
    const { window, test } = setup();
    const mutex = createMutex();

    for (let run = 0; run < 5; run += 1) {
      const tenant = `t_run_${run}`;
      const results = await Promise.all(
        Array.from({ length: PARALLEL }, (_unused, index) =>
          mutex.runExclusive(tenant, () => window.admit(tenant, TOKENS_EACH, `req_${run}_${index}`))
        )
      );

      const admitted = results.filter((result) => result.ok);
      const rejected = results.filter((result) => !result.ok);

      expect(admitted).toHaveLength(EXPECTED_ADMITTED);
      expect(rejected).toHaveLength(PARALLEL - EXPECTED_ADMITTED);

      // The reservation rows must add up to the admitted total, never more.
      const sum = test.db
        .prepare('SELECT COALESCE(SUM(tokens), 0) AS used FROM token_events WHERE tenant_id = ?')
        .get<{ used: number }>(tenant)?.used;
      expect(sum).toBe(EXPECTED_ADMITTED * TOKENS_EACH);
      expect(sum).toBeLessThanOrEqual(LIMIT);
      expect(window.usage(tenant).remaining).toBe(LIMIT - EXPECTED_ADMITTED * TOKENS_EACH);
    }
  });

  it('admits exactly 8 of 20 with no mutex at all (the transaction is the guarantee)', async () => {
    const { window } = setup();

    for (let run = 0; run < 5; run += 1) {
      const tenant = `t_bare_${run}`;
      const results = await Promise.all(
        Array.from({ length: PARALLEL }, async (_unused, index) => {
          // Yield first, so every admission is issued from the same macrotask wave.
          await new Promise((resolve) => setImmediate(resolve));
          return window.admit(tenant, TOKENS_EACH, `req_${run}_${index}`);
        })
      );
      expect(results.filter((result) => result.ok)).toHaveLength(EXPECTED_ADMITTED);
    }
  });

  it('never double-spends when the same reservation is reconciled twice', () => {
    const { window, test } = setup();
    const admitted = window.admit('t_a', TOKENS_EACH, 'req_1');
    if (!admitted.ok) throw new Error('expected admission');

    expect(window.reconcile(admitted.reservationId, 1_234, 'primary').reconciled).toBe(true);
    expect(window.reconcile(admitted.reservationId, 1_234, 'primary').reconciled).toBe(false);
    expect(window.reconcile(admitted.reservationId, 9_999, 'primary').reconciled).toBe(false);

    expect(test.db.prepare('SELECT COUNT(*) AS n FROM token_events').get<{ n: number }>()?.n).toBe(1);
    expect(window.usage('t_a').used).toBe(1_234);
  });
});

describe('limiter atomicity — through the real HTTP gateway', () => {
  it('answers exactly 8 × 200 and 12 × 429 for 20 parallel requests of 6 000 tokens', async () => {
    const config = loadConfig({});
    const body = bodyWithEstimatedTokens(TOKENS_EACH);
    expect(estimateTokens(body, config)).toBe(TOKENS_EACH); // the crafted body really is 6 000

    // A deliberately *slow* provider keeps the 8 reservations open while all 20 requests are
    // admitted, which is exactly the window a reservation exists for. (With an instant provider the
    // first requests would reconcile their 6 000-token reservation down to the provider's 33-token
    // `usage` before the last ones arrive — correct behaviour, but not the property under test.)
    const provider: MockProvider = await startMockProvider({ behaviour: 'ok', delayMs: 300 });
    cleanups.push(() => void provider.close());
    const test = createTestDb();
    cleanups.push(test.cleanup);

    const harness = await startHarness({
      primaryUrl: provider.url,
      secondaryUrl: provider.url,
      db: test.db,
      env: { ROUTER_LIMIT_TOKENS: String(LIMIT), ROUTER_WINDOW_MS: '60000' }
    });
    cleanups.push(() => void harness.close());

    for (let run = 0; run < 3; run += 1) {
      const key = `${TEST_TENANT_KEY}-${run}`;
      const responses = await Promise.all(
        Array.from({ length: PARALLEL }, () => postCompletion(harness.url, body, { key }))
      );
      const statuses = responses.map((response) => response.status);

      expect(statuses.filter((status) => status === 200)).toHaveLength(EXPECTED_ADMITTED);
      expect(statuses.filter((status) => status === 429)).toHaveLength(PARALLEL - EXPECTED_ADMITTED);

      const rejected = responses.filter((response) => response.status === 429);
      for (const response of rejected) {
        expect(response.headers.get('retry-after')).toMatch(/^\d+$/);
        expect(response.headers.get('x-ratelimit-limit-tokens')).toBe(String(LIMIT));
        expect(response.headers.get('x-ratelimit-remaining-tokens')).toBe('2000');
        const payload = (await response.json()) as { error: { code: string; request_id: string } };
        expect(payload.error.code).toBe('gateway_rate_limited');
        expect(payload.error.request_id).toMatch(/^req_/);
      }

      const served = responses.filter((response) => response.status === 200);
      for (const response of served) {
        expect(response.headers.get('x-gateway-provider')).toBe('primary');
        await response.text();
      }
    }

    expect(harness.metrics.snapshot().counters.admitted).toBe(3 * EXPECTED_ADMITTED);
    expect(harness.metrics.snapshot().counters.rate_limited).toBe(3 * (PARALLEL - EXPECTED_ADMITTED));
    // Only the admitted requests were ever forwarded upstream.
    expect(provider.callCount()).toBe(3 * EXPECTED_ADMITTED);
  });
});
