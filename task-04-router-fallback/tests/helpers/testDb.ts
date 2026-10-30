/**
 * A **real temporary SQLite file** per test — never `:memory:`.
 *
 * Two of the graded behaviours only exist on disk: WAL mode (`:memory:` is always journal_mode
 * `memory`) and the cross-process guarantee (`:memory:` is per-connection, so two processes could
 * never share it). The file lives in a fresh temp directory that is removed with its `-wal`/`-shm`
 * sidecars afterwards.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, type Db, type SqlValue, type SqliteDriver } from '../../src/db/database.js';
import { applyMigrations } from '../../src/db/migrations.js';

export interface TestDb {
  db: Db;
  /** Absolute path of the on-disk database. */
  path: string;
  dir: string;
  /** Closes the connection and deletes the directory (safe to call twice). */
  cleanup(): void;
}

export function createTempDir(prefix = 'task04-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function createTestDb(driver: SqliteDriver = 'better'): TestDb {
  const dir = createTempDir();
  const path = join(dir, 'router.db');
  const db = openDatabase({ path, driver });
  applyMigrations(db);

  let cleaned = false;
  return {
    db,
    path,
    dir,
    cleanup() {
      if (cleaned) return;
      cleaned = true;
      try {
        db.close();
      } catch {
        /* already closed by the test */
      }
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

/**
 * Wraps a `Db` so a test can observe *how* the limiter used it: the SQL prepared for one admission,
 * and whether the whole decision happened inside one transaction.
 */
export interface StatementExecution {
  sql: string;
  method: 'run' | 'get' | 'all';
  /** Whether the statement ran inside the limiter's write transaction. */
  inTransaction: boolean;
}

export interface SpyDb {
  db: Db;
  sql: string[];
  /** Every statement *executed*, in order — the admission sequence, observed. */
  executions: StatementExecution[];
  transactions: number;
  reset(): void;
}

export function spyOnDb(db: Db): SpyDb {
  const spy: SpyDb = {
    db: {
      ...db,
      get driver() {
        return db.driver;
      },
      get path() {
        return db.path;
      },
      get inTransaction() {
        return db.inTransaction;
      },
      exec: (sql) => db.exec(sql),
      prepare: (sql) => {
        spy.sql.push(sql);
        const statement = db.prepare(sql);
        const record = (method: StatementExecution['method']): void => {
          spy.executions.push({ sql, method, inTransaction: db.inTransaction });
        };
        return {
          run: (...params: SqlValue[]) => {
            record('run');
            return statement.run(...params);
          },
          get: <T>(...params: SqlValue[]) => {
            record('get');
            return statement.get<T>(...params);
          },
          all: <T>(...params: SqlValue[]) => {
            record('all');
            return statement.all<T>(...params);
          }
        };
      },
      transaction: <T>(fn: () => T): T => {
        spy.transactions += 1;
        return db.transaction(fn);
      },
      pragmas: () => db.pragmas(),
      close: () => db.close()
    },
    sql: [],
    executions: [],
    transactions: 0,
    reset() {
      spy.sql = [];
      spy.executions = [];
      spy.transactions = 0;
    }
  };
  return spy;
}

/** Writes a sentinel-bearing file (used to prove a bad path fails readably). */
export function writeSentinelFile(dir: string, name = 'not-a-db.txt'): string {
  const path = join(dir, name);
  writeFileSync(path, 'INTERNAL_STACK_TRACE_SENTINEL — this is not a SQLite database\n');
  return path;
}
