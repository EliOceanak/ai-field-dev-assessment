/**
 * Cross-process worker: one OS process admitting tokens against a **shared on-disk database**.
 *
 * Spawned twice by `tests/concurrency/cross-process.test.ts` (with `node --import tsx`), it is the
 * only way to prove that the limiter's guarantee is SQLite's `BEGIN IMMEDIATE` and not an in-process
 * mutex: two event loops, two connections, one file.
 *
 * All workers wait for the same wall-clock `startAt` so their admission waves genuinely overlap, and
 * each attempt yields first so the interleaving is not an artefact of one process running to
 * completion before the other starts. The JSON summary goes to stdout (this is a script, not `src/`).
 */
import { openDatabase } from '../../src/db/database.js';
import { createTokenWindow } from '../../src/ratelimit/tokenWindow.js';

interface WorkerConfig {
  dbPath: string;
  driver: 'better' | 'node';
  tenant: string;
  attempts: number;
  tokens: number;
  limitTokens: number;
  windowMs: number;
  /** Epoch ms at which every worker starts admitting (a crude but effective barrier). */
  startAt: number;
}

const raw = process.argv[2];
if (raw === undefined) throw new Error('admit-worker requires a JSON config argument');
const config = JSON.parse(raw) as WorkerConfig;

const db = openDatabase({ path: config.dbPath, driver: config.driver });
const window = createTokenWindow({
  db,
  windowMs: config.windowMs,
  limitTokens: config.limitTokens
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  // Barrier: everyone starts inside the same millisecond, on different cores.
  const wait = config.startAt - Date.now();
  if (wait > 0) await sleep(wait);

  const reservations: string[] = [];
  let denied = 0;
  let oversized = 0;

  for (let index = 0; index < config.attempts; index += 1) {
    const result = window.admit(config.tenant, config.tokens, `req_pid${process.pid}_${index}`);
    if (result.ok) reservations.push(result.reservationId);
    else {
      denied += 1;
      if (result.oversized) oversized += 1;
    }
    await new Promise((resolve) => setImmediate(resolve));
  }

  const total = db
    .prepare('SELECT COALESCE(SUM(tokens), 0) AS used FROM token_events WHERE tenant_id = ?')
    .get<{ used: number }>(config.tenant)?.used;

  process.stdout.write(
    `${JSON.stringify({
      pid: process.pid,
      admitted: reservations.length,
      denied,
      oversized,
      totalTokensInDb: Number(total ?? 0),
      reservationIds: reservations
    })}\n`
  );
  db.close();
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exit(1);
});
