/**
 * The sliding window's arithmetic and its transaction shape.
 *
 * Every case runs against a **real temporary SQLite file** and, where it matters, against both
 * drivers (`better` and `node`) — the parity block at the bottom is what keeps the fallback driver
 * honest instead of aspirational.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createTokenWindow, type TokenWindow } from '../../src/ratelimit/tokenWindow.js';
import type { SqliteDriver } from '../../src/db/database.js';
import { createTestDb, spyOnDb, type SpyDb, type TestDb } from '../helpers/testDb.js';
import { createClock, type TestClock } from '../helpers/clock.js';

interface Fixture {
  window: TokenWindow;
  db: TestDb;
  clock: TestClock;
  spy: SpyDb;
}

const cleanups: (() => void)[] = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function fixture(options: { limitTokens?: number; windowMs?: number; driver?: SqliteDriver } = {}): Fixture {
  const db = createTestDb(options.driver ?? 'better');
  cleanups.push(db.cleanup);
  const clock = createClock();
  const spy = spyOnDb(db.db);
  const window = createTokenWindow({
    db: spy.db,
    windowMs: options.windowMs ?? 60_000,
    limitTokens: options.limitTokens ?? 1_000,
    now: clock.now
  });
  return { window, db, clock, spy };
}

describe('token window — boundaries and isolation', () => {
  it('admits the request that exactly reaches the limit and rejects the next token', () => {
    const { window } = fixture({ limitTokens: 1_000 });

    const first = window.admit('t_a', 600, 'req_1');
    const second = window.admit('t_a', 400, 'req_2');
    const third = window.admit('t_a', 1, 'req_3');

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(third.ok).toBe(false);
    if (third.ok) throw new Error('unreachable');
    expect(third.used).toBe(1_000);
    expect(third.limit).toBe(1_000);
    expect(third.oversized).toBe(false);
    expect(window.usage('t_a')).toMatchObject({ used: 1_000, remaining: 0, events: 2 });
  });

  it('admits a single request that consumes the whole window', () => {
    const { window } = fixture({ limitTokens: 500 });
    expect(window.admit('t_a', 500, 'req_1').ok).toBe(true);
    expect(window.admit('t_a', 0, 'req_2').ok).toBe(true); // a zero-token request always fits
    expect(window.admit('t_a', 1, 'req_3').ok).toBe(false);
  });

  it('isolates tenants from each other', () => {
    const { window } = fixture({ limitTokens: 100 });

    expect(window.admit('t_a', 100, 'req_a1').ok).toBe(true);
    expect(window.admit('t_a', 1, 'req_a2').ok).toBe(false);
    expect(window.admit('t_b', 100, 'req_b1').ok).toBe(true);

    expect(window.usage('t_a')).toMatchObject({ used: 100, remaining: 0 });
    expect(window.usage('t_b')).toMatchObject({ used: 100, remaining: 0 });
    expect(window.usage('t_c')).toMatchObject({ used: 0, remaining: 100 });
  });

  it('flags a request that could never fit in an empty window', () => {
    const { window } = fixture({ limitTokens: 100 });
    const denied = window.admit('t_a', 101, 'req_1');
    expect(denied.ok).toBe(false);
    if (denied.ok) throw new Error('unreachable');
    expect(denied.oversized).toBe(true);
  });

  it('rejects a negative or non-finite estimate instead of corrupting the window', () => {
    const { window } = fixture();
    expect(() => window.admit('t_a', -1, 'req_1')).toThrow(RangeError);
    expect(() => window.admit('t_a', Number.NaN, 'req_2')).toThrow(RangeError);
    expect(() => window.admit('t_a', Number.POSITIVE_INFINITY, 'req_3')).toThrow(RangeError);
  });
});

describe('token window — usage arithmetic', () => {
  it('reports used, remaining, events and the reset instant of the oldest event', () => {
    const { window, clock } = fixture({ limitTokens: 1_000, windowMs: 60_000 });
    window.admit('t_a', 100, 'req_1');
    clock.advance(10_000);
    window.admit('t_a', 250, 'req_2');

    const usage = window.usage('t_a');
    expect(usage).toEqual({
      tenantId: 't_a',
      limit: 1_000,
      used: 350,
      remaining: 650,
      resetAtMs: clock.current() - 10_000 + 60_000,
      windowMs: 60_000,
      events: 2
    });
  });

  it('reports a full window when nothing has been admitted', () => {
    const { window, clock } = fixture({ limitTokens: 1_000, windowMs: 60_000 });
    expect(window.usage('t_empty')).toMatchObject({ used: 0, remaining: 1_000, events: 0, resetAtMs: clock.current() + 60_000 });
  });

  it('counts down retryAfterMs as the oldest event ages out', () => {
    const { window, clock } = fixture({ limitTokens: 1_000, windowMs: 60_000 });
    window.admit('t_a', 1_000, 'req_1');

    const immediate = window.admit('t_a', 1, 'req_2');
    expect(immediate.ok).toBe(false);
    if (immediate.ok) throw new Error('unreachable');
    expect(immediate.retryAfterMs).toBe(60_000);

    clock.advance(20_000);
    const later = window.admit('t_a', 1, 'req_3');
    expect(later.ok).toBe(false);
    if (later.ok) throw new Error('unreachable');
    expect(later.retryAfterMs).toBe(40_000);

    clock.advance(40_000);
    expect(window.admit('t_a', 1, 'req_4').ok).toBe(true);
  });
});

describe('token window — reservation lifecycle', () => {
  it('replaces the reservation with the provider usage in the same window slot', () => {
    const { window, clock, spy } = fixture({ limitTokens: 1_000 });
    const admitted = window.admit('t_a', 400, 'req_1');
    if (!admitted.ok) throw new Error('expected admission');
    expect(window.usage('t_a').used).toBe(400);

    spy.reset();
    clock.advance(5_000);
    const result = window.reconcile(admitted.reservationId, 120, 'primary');

    expect(result).toEqual({ reconciled: true, estimated: 400, actual: 120, delta: -280 });
    const events = window.eventsInWindow('t_a');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'actual',
      tokens: 120,
      reservation_id: admitted.reservationId,
      request_id: 'req_1',
      provider: 'primary',
      window_ts: clock.current() - 5_000 // the original admission instant, not the reconcile instant
    });
    expect(window.usage('t_a')).toMatchObject({ used: 120, remaining: 880, events: 1 });
  });

  it('is idempotent: reconciling twice cannot double-spend', () => {
    const { window } = fixture({ limitTokens: 1_000 });
    const admitted = window.admit('t_a', 400, 'req_1');
    if (!admitted.ok) throw new Error('expected admission');

    expect(window.reconcile(admitted.reservationId, 400, 'primary').reconciled).toBe(true);
    expect(window.reconcile(admitted.reservationId, 400, 'primary').reconciled).toBe(false);

    expect(window.eventsInWindow('t_a')).toHaveLength(1);
    expect(window.usage('t_a').used).toBe(400);
  });

  it('ignores a reconcile for an unknown reservation', () => {
    const { window } = fixture();
    expect(window.reconcile('res_does_not_exist', 10)).toEqual({ reconciled: false, estimated: 0, actual: 10, delta: 0 });
    expect(window.usage('t_a').used).toBe(0);
  });

  it('releases a reservation when the request never reached a provider', () => {
    const { window } = fixture({ limitTokens: 1_000 });
    const admitted = window.admit('t_a', 900, 'req_1');
    if (!admitted.ok) throw new Error('expected admission');
    expect(window.usage('t_a').used).toBe(900);

    expect(window.release(admitted.reservationId)).toBe(true);
    expect(window.release(admitted.reservationId)).toBe(false);
    expect(window.usage('t_a').used).toBe(0);
    expect(window.admit('t_a', 1_000, 'req_2').ok).toBe(true);
  });

  it('keeps an unreconciled reservation counted (conservative) until the window rolls over', () => {
    const { window, clock } = fixture({ limitTokens: 1_000, windowMs: 60_000 });
    window.admit('t_a', 1_000, 'req_1');
    clock.advance(30_000);
    expect(window.usage('t_a').used).toBe(1_000);
    clock.advance(30_001);
    expect(window.usage('t_a').used).toBe(0);
  });
});

describe('token window — the admission is one transaction', () => {
  it('evicts, sums and reserves inside a single BEGIN IMMEDIATE transaction', () => {
    const { window, spy } = fixture({ limitTokens: 1_000 });
    spy.reset();

    window.admit('t_a', 100, 'req_1');

    expect(spy.transactions).toBe(1);

    const executed = spy.executions.map((entry) => entry.sql.replace(/\s+/g, ' ').trim());
    const evict = executed.findIndex((sql) => sql.startsWith('DELETE FROM token_events WHERE tenant_id = ? AND window_ts <='));
    const sum = executed.findIndex((sql) => sql.includes('COALESCE(SUM(tokens), 0) AS used'));
    const insert = executed.findIndex((sql) => sql.startsWith('INSERT INTO token_events'));

    expect(evict).toBeGreaterThanOrEqual(0);
    expect(sum).toBeGreaterThan(evict);
    expect(insert).toBeGreaterThan(sum);
    // …and every one of them ran while the write transaction was already open.
    expect(spy.executions.every((entry) => entry.inTransaction)).toBe(true);
  });

  it('does not write a reservation row when the request is denied', () => {
    const { window } = fixture({ limitTokens: 100 });
    window.admit('t_a', 100, 'req_1');
    window.admit('t_a', 1, 'req_2');
    expect(window.eventsInWindow('t_a')).toHaveLength(1);
  });
});

describe.each(['better', 'node'] as const)('token window — driver parity (%s)', (driver) => {
  it('behaves identically for admission, reconciliation and release', () => {
    const { window, clock } = fixture({ limitTokens: 1_000, windowMs: 60_000, driver });

    const first = window.admit('t_a', 700, 'req_1');
    const second = window.admit('t_a', 400, 'req_2');
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    if (!first.ok || second.ok) throw new Error('unreachable');
    expect(second).toMatchObject({ used: 700, limit: 1_000, retryAfterMs: 60_000 });

    expect(window.reconcile(first.reservationId, 250, 'primary')).toMatchObject({ reconciled: true, delta: -450 });
    expect(window.usage('t_a')).toMatchObject({ used: 250, remaining: 750, events: 1 });

    const third = window.admit('t_a', 750, 'req_3');
    expect(third.ok).toBe(true);
    if (!third.ok) throw new Error('unreachable');
    expect(window.release(third.reservationId)).toBe(true);
    expect(window.usage('t_a')).toMatchObject({ used: 250, events: 1 });

    clock.advance(60_001);
    expect(window.usage('t_a')).toMatchObject({ used: 0, events: 0 });
  });
});

describe('token window — retryAfterMs answers "when will THIS request fit?"', () => {
  it('walks the window until enough capacity has been freed', () => {
    const { window, clock } = fixture({ limitTokens: 5_000, windowMs: 60_000 });
    window.admit('t_a', 100, 'req_1'); // +0 s
    clock.advance(10_000);
    window.admit('t_a', 1_000, 'req_2'); // +10 s
    clock.advance(10_000);
    window.admit('t_a', 1_000, 'req_3'); // +20 s
    clock.advance(10_000); // now = +30 s, used = 2 100

    const denied = window.admit('t_a', 4_000, 'req_4');
    expect(denied.ok).toBe(false);
    if (denied.ok) throw new Error('unreachable');

    // The oldest event frees only 100 tokens at +60 s (2 100 − 100 + 4 000 = 6 000 > 5 000), so a
    // Retry-After based on the oldest event alone would send the client back too early, to be rejected
    // again. Enough capacity appears when the +10 s event expires: 2 100 − 1 100 + 4 000 = 5 000 ≤ 5 000
    // at +70 s.
    expect(denied.retryAfterMs).toBe(40_000);

    // …and retrying then really does succeed.
    clock.advance(40_000);
    expect(window.admit('t_a', 4_000, 'req_5').ok).toBe(true);
  });

  it('falls back to the last expiry when even a full window would not be enough', () => {
    const { window, clock } = fixture({ limitTokens: 1_000, windowMs: 60_000 });
    window.admit('t_a', 100, 'req_1');
    clock.advance(30_000);

    const denied = window.admit('t_a', 1_500, 'req_2');
    expect(denied.ok).toBe(false);
    if (denied.ok) throw new Error('unreachable');
    expect(denied.oversized).toBe(true);
    expect(denied.retryAfterMs).toBe(30_000); // the oldest expiry, which is also X-RateLimit-Reset
  });
});
