/**
 * "On-disk SQLite" means the limiter's state survives the process that wrote it.
 *
 * Each phase builds a **brand-new** `Db` (a new connection) and a brand-new `TokenWindow` module
 * instance over the same file — which is what a restart actually looks like. A `:memory:` database
 * would make every assertion here vacuously true, which is why the helpers never use one.
 */
import { existsSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db, type SqliteDriver } from '../../src/db/database.js';
import { applyMigrations } from '../../src/db/migrations.js';
import { createTokenWindow } from '../../src/ratelimit/tokenWindow.js';
import { createRequestLog } from '../../src/router/requestLog.js';
import { createTestDb, type TestDb } from '../helpers/testDb.js';
import { createClock } from '../helpers/clock.js';

const cleanups: (() => void)[] = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function windowOver(db: Db, clock: { now: () => number }, limitTokens = 50_000) {
  return createTokenWindow({ db, windowMs: 60_000, limitTokens, now: clock.now });
}

function reopen(path: string, driver: SqliteDriver = 'better'): Db {
  const db = openDatabase({ path, driver });
  applyMigrations(db);
  return db;
}

describe('persistence across a restart', () => {
  it('keeps the window state when the database is closed and reopened', () => {
    const test = createTestDb();
    cleanups.push(test.cleanup);
    const clock = createClock();

    const before = windowOver(test.db, clock);
    expect(before.admit('t_a', 30_000, 'req_1').ok).toBe(true);
    expect(before.admit('t_a', 15_000, 'req_2').ok).toBe(true);
    test.db.close();

    // A new connection *and* a new module instance: exactly what a restart gives you.
    const reopened = reopen(test.path);
    cleanups.push(() => reopened.close());
    const after = windowOver(reopened, clock);

    expect(after.usage('t_a')).toMatchObject({ used: 45_000, remaining: 5_000, events: 2 });
    expect(after.admit('t_a', 5_000, 'req_3').ok).toBe(true); // exactly the remainder
    expect(after.admit('t_a', 1, 'req_4').ok).toBe(false); // and not a token more
    expect(after.admit('t_other', 50_000, 'req_5').ok).toBe(true); // other tenants unaffected
  });

  it('survives a restart even when the second process uses the other driver', () => {
    const test = createTestDb('better');
    cleanups.push(test.cleanup);
    const clock = createClock();

    const before = windowOver(test.db, clock);
    expect(before.admit('t_a', 20_000, 'req_1').ok).toBe(true);
    test.db.close();

    const reopened = reopen(test.path, 'node');
    cleanups.push(() => reopened.close());
    expect(windowOver(reopened, clock).usage('t_a')).toMatchObject({ used: 20_000, remaining: 30_000 });
  });

  it('keeps reconciled usage and the request log across a restart', () => {
    const test = createTestDb();
    cleanups.push(test.cleanup);
    const clock = createClock();

    const window = windowOver(test.db, clock);
    const admitted = window.admit('t_a', 6_000, 'req_1');
    if (!admitted.ok) throw new Error('expected admission');
    window.reconcile(admitted.reservationId, 1_234, 'primary');
    createRequestLog(test.db, clock.now).record({
      requestId: 'req_1',
      tenantId: 't_a',
      provider: 'primary',
      model: 'qwen3.8-turbo',
      totalTokens: 1_234,
      outcome: 'ok',
      latencyMs: 12
    });
    test.db.close();

    const reopened = reopen(test.path);
    cleanups.push(() => reopened.close());

    const after = windowOver(reopened, clock);
    expect(after.usage('t_a')).toMatchObject({ used: 1_234, events: 1 });
    expect(after.eventsInWindow('t_a')[0]).toMatchObject({ kind: 'actual', tokens: 1_234, provider: 'primary' });

    const rows = createRequestLog(reopened).recent(5);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ request_id: 'req_1', tenant_id: 't_a', outcome: 'ok', total_tokens: 1_234 });
  });

  it('forgets nothing about the window boundary: a restart does not extend the window', () => {
    const test = createTestDb();
    cleanups.push(test.cleanup);
    const clock = createClock();

    expect(windowOver(test.db, clock).admit('t_a', 50_000, 'req_1').ok).toBe(true);
    clock.advance(30_000);
    test.db.close();

    const reopened = reopen(test.path);
    cleanups.push(() => reopened.close());
    const after = windowOver(reopened, clock);

    expect(after.usage('t_a').used).toBe(50_000);
    clock.advance(30_001); // 60 001 ms after the admission, across the restart
    expect(after.usage('t_a').used).toBe(0);
  });

  it('leaves the on-disk artefacts a reviewer can inspect', () => {
    const test: TestDb = createTestDb();
    cleanups.push(test.cleanup);
    expect(existsSync(test.path)).toBe(true);
    expect(existsSync(`${test.path}-wal`)).toBe(true);
  });
});
