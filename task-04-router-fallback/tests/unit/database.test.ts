/**
 * The SQLite layer: real on-disk file, real WAL, both drivers, idempotent migrations.
 *
 * The `:memory:` shortcut is deliberately avoided — `journal_mode` is always `memory` there, so a
 * `:memory:` test could never prove WAL, and two processes could never share it.
 */
import { existsSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/db/database.js';
import { EXPECTED_TABLES, SCHEMA_VERSION, applyMigrations, loadSchemaSql, splitSchema } from '../../src/db/migrations.js';
import { createTempDir, createTestDb, writeSentinelFile } from '../helpers/testDb.js';

const HERE = dirname(fileURLToPath(import.meta.url));

const cleanups: (() => void)[] = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

describe('database', () => {
  it('opens a real file, enables WAL and applies the busy timeout', () => {
    const test = createTestDb();
    cleanups.push(test.cleanup);

    expect(existsSync(test.path)).toBe(true);
    const pragmas = test.db.pragmas();
    expect(pragmas.journalMode).toBe('wal');
    expect(pragmas.synchronous).toBe(1); // NORMAL
    expect(pragmas.busyTimeoutMs).toBe(5_000);
    expect(pragmas.foreignKeys).toBe(1);
  });

  it('leaves a -wal sidecar behind, which is what proves WAL is really on', () => {
    const test = createTestDb();
    cleanups.push(test.cleanup);
    test.db.prepare('INSERT INTO tenants (tenant_id, limit_tokens, window_ms, created_at) VALUES (?, ?, ?, ?)').run('t_a', 1, 1, 1);
    expect(existsSync(`${test.path}-wal`) || existsSync(`${test.path}-shm`)).toBe(true);
  });

  it('applies migrations idempotently and records the schema version once', () => {
    const test = createTestDb();
    cleanups.push(test.cleanup);

    const second = applyMigrations(test.db);
    const third = applyMigrations(test.db);

    expect(second).toMatchObject({ applied: false, fromVersion: SCHEMA_VERSION, toVersion: SCHEMA_VERSION });
    expect(third.applied).toBe(false);
    expect(second.tables).toEqual([...EXPECTED_TABLES]);

    const rows = test.db.prepare('SELECT version FROM schema_version').all<{ version: number }>();
    expect(rows).toEqual([{ version: SCHEMA_VERSION }]);
  });

  it('creates the tables, the eviction index and the unique request-log key the limiter relies on', () => {
    const test = createTestDb();
    cleanups.push(test.cleanup);

    const indexes = test.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all<{ name: string }>()
      .map((row) => row.name);

    expect(indexes).toContain('idx_token_events_tenant_ts');
    expect(indexes).toContain('idx_token_events_reservation');

    const columns = test.db.prepare('PRAGMA table_info(token_events)').all<{ name: string }>().map((row) => row.name);
    expect(columns).toEqual([
      'id',
      'tenant_id',
      'window_ts',
      'tokens',
      'kind',
      'reservation_id',
      'request_id',
      'provider',
      'created_at'
    ]);
  });

  it('splits the schema so pragmas never run inside a transaction', () => {
    const { pragmas, ddl } = splitSchema(loadSchemaSql());
    expect(pragmas).toEqual([
      'PRAGMA journal_mode = WAL;',
      'PRAGMA synchronous = NORMAL;',
      'PRAGMA busy_timeout = 5000;',
      'PRAGMA foreign_keys = ON;'
    ]);
    expect(ddl).not.toMatch(/PRAGMA/i);
    expect(ddl).toContain('CREATE TABLE IF NOT EXISTS token_events');
  });

  it('fails with a readable error when the database path is unusable', () => {
    const dir = createTempDir();
    cleanups.push(() => undefined);
    const notADatabase = writeSentinelFile(dir, 'plain.txt');

    expect(() => openDatabase({ path: notADatabase })).toThrow(/Cannot open SQLite database at/);
    expect(() => openDatabase({ path: notADatabase })).toThrow(/driver "better"/);
    expect(() => openDatabase({ path: join(dir, 'missing', 'nested', 'router.db') })).not.toThrow();
  });

  it('rolls a transaction back when the body throws', () => {
    const test = createTestDb();
    cleanups.push(test.cleanup);

    expect(() =>
      test.db.transaction(() => {
        test.db.prepare('INSERT INTO tenants (tenant_id, limit_tokens, window_ms, created_at) VALUES (?, ?, ?, ?)').run('t_x', 1, 1, 1);
        throw new Error('boom');
      })
    ).toThrow('boom');

    expect(test.db.prepare('SELECT COUNT(*) AS n FROM tenants').get<{ n: number }>()?.n).toBe(0);
    expect(test.db.inTransaction).toBe(false);
  });

  it('nests transactions as savepoints so a helper cannot break the outer atomicity', () => {
    const test = createTestDb();
    cleanups.push(test.cleanup);

    test.db.transaction(() => {
      test.db.transaction(() => {
        test.db.prepare('INSERT INTO tenants (tenant_id, limit_tokens, window_ms, created_at) VALUES (?, ?, ?, ?)').run('t_a', 1, 1, 1);
      });
    });

    expect(test.db.prepare('SELECT COUNT(*) AS n FROM tenants').get<{ n: number }>()?.n).toBe(1);
  });
});

describe.each(['better', 'node'] as const)('database — driver parity (%s)', (driver) => {
  it('produces the same schema, the same pragmas and the same query results', () => {
    const test = createTestDb(driver);
    cleanups.push(test.cleanup);

    expect(test.db.driver).toBe(driver);
    expect(test.db.pragmas()).toMatchObject({ journalMode: 'wal', synchronous: 1, busyTimeoutMs: 5_000, foreignKeys: 1 });

    const tables = test.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all<{ name: string }>()
      .map((row) => row.name);
    expect(tables).toEqual([...EXPECTED_TABLES]);

    test.db.prepare('INSERT INTO token_events (tenant_id, window_ts, tokens, kind, reservation_id, request_id, provider, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run('t_a', 1_700_000_000_000, 42, 'reservation', 'res_1', 'req_1', null, 1_700_000_000_000);
    const row = test.db
      .prepare('SELECT tenant_id, tokens, kind FROM token_events WHERE reservation_id = ?')
      .get<{ tenant_id: string; tokens: number; kind: string }>('res_1');

    expect(row).toEqual({ tenant_id: 't_a', tokens: 42, kind: 'reservation' });
    expect(test.db.prepare('SELECT COALESCE(SUM(tokens), 0) AS used FROM token_events').get<{ used: number }>()?.used).toBe(42);
  });
});

/**
 * The `node` driver is Node's **experimental** built-in. `src/db/database.ts` filters exactly one
 * warning at the moment it deliberately loads that module (see the comment there); everything else
 * must still reach stderr. Asserted in a child process, because within one process the module is
 * cached after the first load and a warning would never be re-emitted.
 */
describe('the node:sqlite experimental warning', () => {
  it('loads the node driver quietly but still lets every other warning through', async () => {
    const dir = createTempDir();
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const dbPath = join(dir, 'warning-probe.db');

    const script = [
      "const { openDatabase } = await import('./src/db/database.ts');",
      `const db = openDatabase({ path: ${JSON.stringify(dbPath)}, driver: 'node' });`,
      "db.exec('CREATE TABLE IF NOT EXISTS probe (a)');",
      'db.close();',
      // A different experimental warning, emitted after the load: the filter must not swallow it.
      "process.emitWarning('SENTINEL_OTHER_WARNING', 'ExperimentalWarning');",
      "process.stdout.write('PROBE_OK\\n');"
    ].join('\n');

    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
        cwd: join(HERE, '..', '..'),
        stdio: ['ignore', 'pipe', 'pipe']
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
      child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, stdout, stderr }));
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('PROBE_OK');
    expect(result.stderr).not.toContain('SQLite is an experimental feature');
    expect(result.stderr).toContain('SENTINEL_OTHER_WARNING');
  }, 30_000);
});
