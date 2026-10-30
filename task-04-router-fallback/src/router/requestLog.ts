/**
 * The `request_log` table: one row per accepted request, written at the *end* of the request so it
 * carries the outcome, the provider that actually served it and the reconciled token counts.
 *
 * This is the audit trail `scripts/inspect-db.mjs` prints, and it is what makes "which provider
 * served this, and did it fail over?" answerable after the fact.
 */
import type { Db } from '../db/database.js';

export type RequestOutcome =
  | 'ok'
  | 'failover'
  | 'rate_limited'
  | 'upstream_error'
  | 'upstream_timeout'
  | 'stream_failed'
  | 'invalid_request'
  | 'unauthorized';

export interface RequestLogEntry {
  requestId: string;
  tenantId: string;
  provider?: string;
  model?: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  outcome: RequestOutcome;
  failover?: boolean;
  latencyMs?: number;
  createdAt?: number;
}

export interface RequestLogRow {
  request_id: string;
  tenant_id: string;
  provider: string | null;
  model: string | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
  outcome: string;
  failover: number;
  latency_ms: number | null;
  created_at: number;
}

export interface RequestLog {
  record(entry: RequestLogEntry): void;
  recent(limit?: number): RequestLogRow[];
}

export function createRequestLog(db: Db, now: () => number = Date.now): RequestLog {
  const insert = db.prepare(
    `INSERT OR REPLACE INTO request_log
       (request_id, tenant_id, provider, model, prompt_tokens, completion_tokens, total_tokens, outcome, failover, latency_ms, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const recent = db.prepare('SELECT * FROM request_log ORDER BY created_at DESC, rowid DESC LIMIT ?');

  return {
    record(entry) {
      insert.run(
        entry.requestId,
        entry.tenantId,
        entry.provider ?? null,
        entry.model ?? null,
        entry.promptTokens ?? null,
        entry.completionTokens ?? null,
        entry.totalTokens ?? null,
        entry.outcome,
        entry.failover === true ? 1 : 0,
        entry.latencyMs ?? null,
        entry.createdAt ?? now()
      );
    },
    recent(limit = 50) {
      return recent.all<RequestLogRow>(limit);
    }
  };
}
