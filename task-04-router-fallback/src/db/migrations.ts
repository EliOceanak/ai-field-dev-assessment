/**
 * Idempotent schema application.
 *
 * `src/db/schema.sql` is the single source of truth; this module
 * loads it, applies the pragmas, then the DDL inside a transaction, and records the version so a
 * future migration can be additive. Running it twice is a no-op — asserted by
 * `tests/unit/database.test.ts`.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from './database.js';

const HERE = dirname(fileURLToPath(import.meta.url));

export const SCHEMA_VERSION = 1;

export const SCHEMA_PATH = resolve(HERE, 'schema.sql');

export function loadSchemaSql(path: string = SCHEMA_PATH): string {
  return readFileSync(path, 'utf8');
}

/** `PRAGMA` statements must not run inside a transaction, so they are lifted out of the DDL. */
export function splitSchema(sql: string): { pragmas: string[]; ddl: string } {
  const pragmas: string[] = [];
  const ddl: string[] = [];
  for (const line of sql.split('\n')) {
    if (/^\s*PRAGMA\b/i.test(line)) pragmas.push(line.trim().replace(/;?$/, ';'));
    else ddl.push(line);
  }
  return { pragmas, ddl: ddl.join('\n') };
}

export interface MigrationResult {
  applied: boolean;
  fromVersion: number;
  toVersion: number;
  tables: string[];
}

/**
 * Applies the DDL and bumps `schema_version`. The DDL itself is `IF NOT EXISTS`-guarded, so the
 * interesting part is the version row: exactly one row, exactly one value.
 */
export function applyMigrations(db: Db, sql: string = loadSchemaSql()): MigrationResult {
  const { pragmas, ddl } = splitSchema(sql);
  for (const pragma of pragmas) db.exec(pragma);

  return db.transaction(() => {
    db.exec(ddl);

    const row = db.prepare('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1').get<{ version: number }>();
    const fromVersion = row?.version ?? 0;

    if (row === undefined) db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(SCHEMA_VERSION);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all<{ name: string }>();

    return {
      applied: row === undefined,
      fromVersion,
      toVersion: SCHEMA_VERSION,
      tables: tables.map((table) => table.name)
    };
  });
}

/** The tables the schema guarantees. */
export const EXPECTED_TABLES = ['request_log', 'schema_version', 'tenants', 'token_events'] as const;

