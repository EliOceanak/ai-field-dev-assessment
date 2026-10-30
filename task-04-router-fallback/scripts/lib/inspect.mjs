/**
 * Reads a router SQLite file and renders the three tables a reviewer cares about.
 *
 * Shared by `scripts/inspect-db.mjs` (its whole job) and `scripts/demo.mjs` (its final section), so
 * the demo transcript and the standalone inspector can never drift apart. Uses better-sqlite3 in
 * read-only mode; the database is also readable with the `sqlite3` CLI while the gateway holds it
 * open, because it runs in WAL mode.
 */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function pad(value, width) {
  return String(value ?? '-').padEnd(width);
}

function table(headers, rows) {
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => String(row[index] ?? '-').length), 1)
  );
  const line = (cells) => `  ${cells.map((cell, index) => pad(cell, widths[index])).join('  ')}`;
  return [line(headers), line(widths.map((width) => '-'.repeat(width))), ...rows.map(line)].join('\n');
}

/** Opens `path` read-only and returns the rendered sections plus the raw row sets. */
export function inspectDatabase(path, { now = Date.now() } = {}) {
  if (!existsSync(path)) {
    return { ok: false, path, sections: [`no database at ${path}`], data: {} };
  }

  const Database = require('better-sqlite3');
  const db = new Database(path, { readonly: true, fileMustExist: true });

  try {
    const pragmas = {
      journalMode: db.prepare('PRAGMA journal_mode').get().journal_mode,
      busyTimeoutMs: db.prepare('PRAGMA busy_timeout').get().timeout
    };
    const tenants = db
      .prepare('SELECT tenant_id, limit_tokens, window_ms, created_at FROM tenants ORDER BY tenant_id')
      .all();
    const events = db
      .prepare('SELECT tenant_id, kind, tokens, provider, window_ts, request_id FROM token_events ORDER BY id')
      .all();
    const live = db
      .prepare(
        `SELECT tenant_id, kind, COUNT(*) AS events, SUM(tokens) AS tokens
           FROM token_events WHERE window_ts > ? GROUP BY tenant_id, kind ORDER BY tenant_id, kind`
      )
      .all(now - 60_000);
    const totals = db
      .prepare("SELECT tenant_id, COALESCE(SUM(CASE WHEN kind = 'reservation' THEN tokens ELSE 0 END), 0) AS reserved, COALESCE(SUM(CASE WHEN kind = 'actual' THEN tokens ELSE 0 END), 0) AS actual FROM token_events GROUP BY tenant_id ORDER BY tenant_id")
      .all();
    const requests = db
      .prepare('SELECT request_id, tenant_id, provider, outcome, failover, total_tokens, latency_ms FROM request_log ORDER BY created_at DESC, rowid DESC LIMIT 10')
      .all();
    const counts = db
      .prepare('SELECT (SELECT COUNT(*) FROM token_events) AS events, (SELECT COUNT(*) FROM request_log) AS requests, (SELECT COUNT(*) FROM tenants) AS tenants')
      .get();

    const sections = [
      `journal_mode=${pragmas.journalMode} (persistent) · busy_timeout=${pragmas.busyTimeoutMs}ms (this read-only connection; the gateway sets the same value)`,
      '',
      `tenants (${counts.tenants})`,
      table(
        ['tenant_id', 'limit_tokens', 'window_ms', 'created_at'],
        tenants.map((row) => [row.tenant_id, row.limit_tokens, row.window_ms, row.created_at])
      ),
      '',
      `token_events (${counts.events}) — reservations are estimates, actual rows came from provider usage`,
      table(
        ['tenant_id', 'kind', 'tokens', 'provider', 'window_ts', 'request_id'],
        events.slice(0, 40).map((row) => [row.tenant_id, row.kind, row.tokens, row.provider, row.window_ts, row.request_id])
      ),
      ...(events.length > 40 ? [`  … ${events.length - 40} more row(s)`] : []),
      '',
      'live window (window_ts > now - 60 s)',
      table(
        ['tenant_id', 'kind', 'events', 'tokens'],
        live.map((row) => [row.tenant_id, row.kind, row.events, row.tokens])
      ),
      '',
      'token totals per tenant',
      table(
        ['tenant_id', 'reserved', 'actual'],
        totals.map((row) => [row.tenant_id, row.reserved, row.actual])
      ),
      '',
      `request_log (last ${requests.length} of ${counts.requests})`,
      table(
        ['request_id', 'tenant_id', 'provider', 'outcome', 'failover', 'total_tokens', 'latency_ms'],
        requests.map((row) => [row.request_id, row.tenant_id, row.provider, row.outcome, row.failover, row.total_tokens, row.latency_ms])
      )
    ];

    return { ok: true, path, sections, data: { tenants, events, live, totals, requests, counts } };
  } finally {
    db.close();
  }
}

/** The raw `sqlite3` dump shown at the end of the demo; `null` when the CLI is unavailable. */
export function sqlite3Dump(path, sql) {
  const { spawnSync } = require('node:child_process');
  const result = spawnSync('sqlite3', [path, sql], { encoding: 'utf8' });
  if (result.error || result.status !== 0) return null;
  return result.stdout.trimEnd();
}
