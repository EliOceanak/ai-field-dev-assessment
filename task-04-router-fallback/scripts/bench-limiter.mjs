#!/usr/bin/env node
/**
 * `npm run bench` — admission throughput, and the correctness comparison that motivates the design.
 *
 * Two limiters over the same on-disk schema:
 *
 *   ATOMIC  the shipped one: evict + SUM + reserve inside one `BEGIN IMMEDIATE` transaction.
 *   NAIVE   the classic bug: SELECT in one transaction, `await` a tick, INSERT in another.
 *
 * Both are driven with the same burst (N concurrent 6 000-token requests against a 50 000 limit, so
 * the only correct answer is 8 admitted). The naive one over-admits — that is the regression
 * `tests/concurrency/limiter-atomicity.test.ts` exists to catch.
 *
 * It also prints admission throughput and the cost of the per-tenant mutex, because "exact" is only
 * useful if it is also fast enough.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { register } from 'tsx/esm/api';
import { createRequire } from 'node:module';

register();
const { openDatabase } = await import('../src/db/database.ts');
const { applyMigrations } = await import('../src/db/migrations.ts');
const { createTokenWindow } = await import('../src/ratelimit/tokenWindow.ts');
const { createMutex } = await import('../src/ratelimit/mutex.ts');

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const LIMIT = 50_000;
const TOKENS = 6_000;
const EXPECTED = Math.floor(LIMIT / TOKENS);
const dir = mkdtempSync(join(tmpdir(), 'task04-bench-'));

const line = (label) => `\n${label}\n${'-'.repeat(label.length)}`;
const tick = () => new Promise((resolve) => setImmediate(resolve));
const pad = (value, width) => String(value).padEnd(width);
const padLeft = (value, width) => String(value).padStart(width);

const atomicDb = openDatabase({ path: join(dir, 'atomic.db') });
applyMigrations(atomicDb);
const window = createTokenWindow({ db: atomicDb, windowMs: 60_000, limitTokens: LIMIT });
const mutex = createMutex();

console.log('Task 4 — limiter bench (on-disk SQLite, no network, no model)');
console.log(`database ${dir}   limit ${LIMIT} tokens / 60 s   request size ${TOKENS} tokens`);

// ---- throughput -------------------------------------------------------------------------------
console.log(line('1. admission throughput (sequential, one connection)'));
for (const rounds of [200, 2_000]) {
  const tenant = `t_seq_${rounds}`;
  const startedAt = process.hrtime.bigint();
  for (let index = 0; index < rounds; index += 1) window.admit(tenant, 10, `req_${index}`);
  const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
  console.log(
    `   ${padLeft(rounds, 6)} admissions in ${padLeft(elapsedMs.toFixed(1), 8)} ms → ${padLeft(((rounds / elapsedMs) * 1000).toFixed(0), 7)} admits/s (${((elapsedMs / rounds) * 1000).toFixed(0)} µs each, one transaction per admission)`
  );
}

// ---- burst: atomic vs naive -------------------------------------------------------------------
console.log(line(`2. burst: ${EXPECTED * 4} concurrent requests × ${TOKENS} tokens (only ${EXPECTED} may be admitted)`));

async function atomicBurst(tenant) {
  const results = await Promise.all(
    Array.from({ length: EXPECTED * 4 }, (_unused, index) =>
      mutex.runExclusive(tenant, () => window.admit(tenant, TOKENS, `req_${tenant}_${index}`))
    )
  );
  return results.filter((result) => result.ok).length;
}

async function atomicBurstNoMutex(tenant) {
  const results = await Promise.all(
    Array.from({ length: EXPECTED * 4 }, async (_unused, index) => {
      await tick();
      return window.admit(tenant, TOKENS, `req_${tenant}_${index}`);
    })
  );
  return results.filter((result) => result.ok).length;
}

// The naive limiter: its own file, its own table, and a real gap between check and insert.
const naivePath = join(dir, 'naive.db');
const naiveDb = new Database(naivePath);
naiveDb.pragma('journal_mode = WAL');
naiveDb.exec('CREATE TABLE token_events (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT NOT NULL, window_ts INTEGER NOT NULL, tokens INTEGER NOT NULL)');

async function naiveBurst(tenant) {
  const insert = naiveDb.prepare('INSERT INTO token_events (tenant_id, window_ts, tokens) VALUES (?, ?, ?)');
  const sum = naiveDb.prepare('SELECT COALESCE(SUM(tokens), 0) AS used FROM token_events WHERE tenant_id = ?');
  const results = await Promise.all(
    Array.from({ length: EXPECTED * 4 }, async (_unused, index) => {
      // Transaction 1: read the window.  (The gap between the two transactions is the bug.)
      naiveDb.exec('BEGIN IMMEDIATE');
      const used = sum.get(tenant).used;
      naiveDb.exec('COMMIT');
      await tick();
      if (used + TOKENS > LIMIT) return false;
      // Transaction 2: reserve, based on a value that may already be stale.
      naiveDb.exec('BEGIN IMMEDIATE');
      insert.run(tenant, Date.now(), TOKENS);
      naiveDb.exec('COMMIT');
      return true;
    })
  );
  return results.filter(Boolean).length;
}

const rounds = 5;
const rows = [];
for (let run = 0; run < rounds; run += 1) {
  rows.push({
    run: run + 1,
    atomic: await atomicBurst(`t_atomic_${run}`),
    atomicNoMutex: await atomicBurstNoMutex(`t_bare_${run}`),
    naive: await naiveBurst(`t_naive_${run}`)
  });
}

console.log(`   ${pad('run', 5)}${pad('atomic (mutex)', 16)}${pad('atomic (no mutex)', 18)}${pad('naive check-then-insert', 26)}`);
for (const row of rows) {
  console.log(
    `   ${pad(row.run, 5)}${pad(`${row.atomic}/${EXPECTED * 4}`, 16)}${pad(`${row.atomicNoMutex}/${EXPECTED * 4}`, 18)}${pad(`${row.naive}/${EXPECTED * 4}`, 26)}`
  );
}

const atomicTotals = rows.reduce((sum, row) => sum + row.atomic, 0);
const bareTotals = rows.reduce((sum, row) => sum + row.atomicNoMutex, 0);
const naiveTotals = rows.reduce((sum, row) => sum + row.naive, 0);
console.log('');
console.log(`   expected per run            : exactly ${EXPECTED}`);
console.log(`   atomic (mutex)   admitted   : ${atomicTotals} / ${rounds * EXPECTED}  ${atomicTotals === rounds * EXPECTED ? 'OK' : 'UNEXPECTED'}`);
console.log(`   atomic (no mutex) admitted  : ${bareTotals} / ${rounds * EXPECTED}  ${bareTotals === rounds * EXPECTED ? 'OK' : 'UNEXPECTED'}`);
console.log(`   naive admitted              : ${naiveTotals} / ${rounds * EXPECTED}  (${(naiveTotals / (rounds * EXPECTED)).toFixed(2)}× the limit — the bug the transaction prevents)`);

// ---- mutex cost -------------------------------------------------------------------------------
console.log(line('3. cost of the per-tenant mutex (2 000 sequential admissions)'));
for (const [label, useMutex] of [['without mutex', false], ['with mutex', true]]) {
  const tenant = `t_cost_${label.replace(/ /g, '_')}`;
  const startedAt = process.hrtime.bigint();
  for (let index = 0; index < 2_000; index += 1) {
    if (useMutex) await mutex.runExclusive(tenant, () => window.admit(tenant, 1, `req_${index}`));
    else window.admit(tenant, 1, `req_${index}`);
  }
  const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
  console.log(`   ${pad(label, 16)} ${padLeft(elapsedMs.toFixed(1), 8)} ms  (${((elapsedMs / 2_000) * 1000).toFixed(0)} µs per admission)`);
}

const ok = atomicTotals === rounds * EXPECTED && bareTotals === rounds * EXPECTED;
console.log(`\n${ok ? 'PASS' : 'FAIL'} — the atomic limiter admitted exactly ${EXPECTED} per burst; the naive one did not.`);

atomicDb.close();
naiveDb.close();
rmSync(dir, { recursive: true, force: true });
process.exit(ok ? 0 : 1);
