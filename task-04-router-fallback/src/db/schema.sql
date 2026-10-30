-- Task 4 schema — applied idempotently on every boot by src/db/migrations.ts.
--
-- Everything the limiter needs to be *exact* lives in these two tables:
--   token_events   one row per admission (a reservation) or per reconciled provider usage
--   tenants        per-key limit geometry (the brief's 50 000 tokens / 60 s is the default row)
--
-- The `(tenant_id, window_ts)` index is what makes eviction an index range scan instead of a
-- full table scan, so the sliding window stays O(expired rows) under load.

PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 5000;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS tenants (
  tenant_id    TEXT PRIMARY KEY,
  limit_tokens INTEGER NOT NULL,
  window_ms    INTEGER NOT NULL,
  created_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS token_events (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id      TEXT NOT NULL,
  window_ts      INTEGER NOT NULL,          -- epoch ms; the sliding-window key
  tokens         INTEGER NOT NULL,          -- estimate while reserved, actual after reconcile
  kind           TEXT NOT NULL,             -- 'reservation' | 'actual'
  reservation_id TEXT,                      -- links a reconciled 'actual' row to its reservation
  request_id     TEXT NOT NULL,
  provider       TEXT,
  created_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_token_events_tenant_ts ON token_events (tenant_id, window_ts);
CREATE INDEX IF NOT EXISTS idx_token_events_reservation ON token_events (reservation_id);

CREATE TABLE IF NOT EXISTS request_log (
  request_id        TEXT PRIMARY KEY,
  tenant_id         TEXT NOT NULL,
  provider          TEXT,
  model             TEXT,
  prompt_tokens     INTEGER,
  completion_tokens INTEGER,
  total_tokens      INTEGER,
  outcome           TEXT NOT NULL,           -- 'ok' | 'rate_limited' | 'failover' | 'upstream_error' | …
  failover          INTEGER NOT NULL DEFAULT 0,
  latency_ms        INTEGER,
  created_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_request_log_tenant_created ON request_log (tenant_id, created_at);
