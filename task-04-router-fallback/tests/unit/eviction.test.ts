/**
 * Eviction and rollover, driven entirely by an injected clock — no real sleeping anywhere.
 *
 * The window convention under test: an event contributes for exactly `windowMs`; at
 * `window_ts + windowMs` it is evicted, so capacity is restored at the reset instant the gateway
 * advertised in `Retry-After`.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createTokenWindow } from '../../src/ratelimit/tokenWindow.js';
import { createTestDb, type TestDb } from '../helpers/testDb.js';
import { createClock } from '../helpers/clock.js';

const cleanups: (() => void)[] = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function setup(options: { limitTokens?: number; windowMs?: number } = {}) {
  const test: TestDb = createTestDb();
  cleanups.push(test.cleanup);
  const clock = createClock();
  const window = createTokenWindow({
    db: test.db,
    windowMs: options.windowMs ?? 60_000,
    limitTokens: options.limitTokens ?? 1_000,
    now: clock.now
  });
  return { window, clock, db: test.db };
}

describe('eviction', () => {
  it('ages an event out at exactly windowMs and not a millisecond earlier', () => {
    const { window, clock } = setup({ limitTokens: 1_000, windowMs: 60_000 });
    window.admit('t_a', 1_000, 'req_1');

    clock.advance(59_999);
    expect(window.usage('t_a').used).toBe(1_000);
    expect(window.admit('t_a', 1, 'req_2').ok).toBe(false);

    clock.advance(1); // exactly windowMs after the admission
    expect(window.usage('t_a').used).toBe(0);
    expect(window.admit('t_a', 1_000, 'req_3').ok).toBe(true);
  });

  it('restores capacity progressively as individual events expire', () => {
    const { window, clock } = setup({ limitTokens: 1_000, windowMs: 60_000 });
    window.admit('t_a', 600, 'req_1');
    clock.advance(30_000);
    window.admit('t_a', 400, 'req_2');
    expect(window.admit('t_a', 1, 'req_3').ok).toBe(false);

    // The first event expires (60 s after its own admission) and frees 600 tokens…
    clock.advance(30_000);
    expect(window.usage('t_a')).toMatchObject({ used: 400, remaining: 600 });
    expect(window.admit('t_a', 600, 'req_4').ok).toBe(true);
    expect(window.admit('t_a', 1, 'req_5').ok).toBe(false);

    // At +90 s the second event has expired too, and only the 600 admitted at +60 s remain.
    clock.advance(30_000);
    expect(window.usage('t_a').used).toBe(600);
    expect(window.admit('t_a', 400, 'req_6').ok).toBe(true);

    // At +150 s the window is empty again.
    clock.advance(60_000);
    expect(window.usage('t_a').used).toBe(0);
  });

  it('evicts only the expired rows, never another tenant\'s or a fresh one', () => {
    const { window, clock, db } = setup({ limitTokens: 10_000, windowMs: 60_000 });
    window.admit('t_old', 100, 'req_old');
    window.admit('t_other', 100, 'req_other');

    clock.advance(45_000);
    window.admit('t_old', 100, 'req_old_2');
    window.admit('t_other', 100, 'req_other_2');

    clock.advance(15_000); // the first pair is now exactly windowMs old
    window.admit('t_old', 100, 'req_old_3');

    const rows = db
      .prepare('SELECT tenant_id, request_id FROM token_events ORDER BY id')
      .all<{ tenant_id: string; request_id: string }>();
    // Only t_old's admission path ran, so only t_old's expired row was removed.
    expect(rows.map((row) => row.request_id)).toEqual(['req_other', 'req_old_2', 'req_other_2', 'req_old_3']);
    expect(window.usage('t_old').used).toBe(200);
    expect(window.usage('t_other').used).toBe(100); // its +45 s row is live, its +0 s row is not
  });

  it('sweeps expired rows for every tenant and reports how many it removed', () => {
    const { window, clock } = setup({ limitTokens: 10_000, windowMs: 60_000 });
    window.admit('t_a', 10, 'req_a1');
    window.admit('t_b', 10, 'req_b1');
    expect(window.sweep()).toBe(0); // nothing is expired yet

    clock.advance(60_001);
    expect(window.sweep()).toBe(2); // t_a's row and t_b's row
    expect(window.sweep()).toBe(0); // idempotent
    expect(window.eventsInWindow('t_a')).toHaveLength(0);
    expect(window.eventsInWindow('t_b')).toHaveLength(0);
  });

  it('keeps the window bounded over many rollovers', () => {
    const { window, clock } = setup({ limitTokens: 10_000, windowMs: 1_000 });
    for (let i = 0; i < 50; i += 1) {
      window.admit('t_a', 10, `req_${i}`);
      clock.advance(500);
    }
    // 50 admissions at 500 ms intervals with a 1 s window: at most two are ever live.
    expect(window.eventsInWindow('t_a').length).toBeLessThanOrEqual(2);
    expect(window.usage('t_a').used).toBeLessThanOrEqual(20);
  });
});
