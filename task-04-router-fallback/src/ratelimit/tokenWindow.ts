/**
 * The sliding-window token limiter — the correctness core of Task 4.
 *
 * **Why one transaction.** The classic limiter bug is check-then-insert in two transactions:
 * two concurrent requests both read `used = 42 000`, both decide `42 000 + 6 000 <= 50 000`, and
 * both insert — 54 000 tokens admitted against a 50 000 limit. Here the eviction, the `SUM` and the
 * reservation `INSERT` all happen inside a single `BEGIN IMMEDIATE` transaction, so SQLite's write
 * lock serialises the decision. That is a *cross-process* guarantee, which is exactly what
 * `tests/concurrency/cross-process.test.ts` proves.
 *
 * **Why an estimate.** The decision must be made before the provider is called, so `admit()` takes
 * an estimated token count and writes a `reservation` row. When the provider reports `usage`, the
 * router calls `reconcile(reservationId, actual)` which swaps the reservation for an `actual` row
 * *in the same window slot*. If the request never produced a completion, `release()` deletes the
 * reservation. An outcome we never learn about stays as a conservative estimate until `sweep()`
 * evicts it with the rest of the window.
 *
 * A denied admission commits the (idempotent) eviction instead of rolling it back: rolling back would
 * throw away useful work, and nothing else was written. The guarantee — check + evict + insert are one
 * atomic step — is unchanged.
 */
import { randomUUID } from 'node:crypto';
import type { Db } from '../db/database.js';

export interface TenantRow {
  tenant_id: string;
  limit_tokens: number;
  window_ms: number;
  created_at: number;
}

export interface TokenEventRow {
  id: number;
  tenant_id: string;
  window_ts: number;
  tokens: number;
  kind: 'reservation' | 'actual';
  reservation_id: string | null;
  request_id: string;
  provider: string | null;
  created_at: number;
}

export type Admission =
  | { ok: true; reservationId: string; tokens: number; used: number; limit: number }
  | { ok: false; retryAfterMs: number; used: number; limit: number; oversized: boolean };

export interface WindowUsage {
  tenantId: string;
  limit: number;
  used: number;
  remaining: number;
  /** Epoch ms at which the oldest in-window event expires and capacity is actually released. */
  resetAtMs: number;
  windowMs: number;
  events: number;
}

export interface ReconcileResult {
  reconciled: boolean;
  estimated: number;
  actual: number;
  delta: number;
}

export interface TokenWindowOptions {
  db: Db;
  windowMs: number;
  limitTokens: number;
  /** Injectable clock — the eviction tests move it by hand. */
  now?: () => number;
}

export interface TokenWindow {
  admit(tenantId: string, estimatedTokens: number, requestId: string): Admission;
  reconcile(reservationId: string, actualTokens: number, provider?: string): ReconcileResult;
  release(reservationId: string): boolean;
  sweep(): number;
  usage(tenantId: string): WindowUsage;
  eventsInWindow(tenantId: string): TokenEventRow[];
  tenant(tenantId: string): TenantRow | undefined;
  /** Runs `fn` inside one `BEGIN IMMEDIATE` transaction (the router's `request_log` write). */
  transaction<T>(fn: () => T): T;
}

function requireNonNegativeInteger(value: number, what: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${what} must be a finite, non-negative number (got ${String(value)})`);
  }
  return Math.floor(value);
}

/**
 * Milliseconds until `estimate` more tokens fit in this tenant's window.
 *
 * Walks the live window in expiry order accumulating what each event will free, and returns the
 * expiry of the event at which `used - freed + estimate <= limit`. An `oversized` request (bigger than
 * the whole window) can never fit, so it gets the oldest expiry, which is also what
 * `X-RateLimit-Reset` advertises.
 */
function timeUntilFits(
  events: readonly { window_ts: number; tokens: number }[],
  nowMs: number,
  windowMs: number,
  used: number,
  estimate: number,
  limit: number,
  fallbackExpiryMs: number
): number {
  if (estimate > limit) return Math.max(0, fallbackExpiryMs - nowMs);

  let freed = 0;
  for (const event of events) {
    freed += event.tokens;
    if (used - freed + estimate <= limit) return Math.max(0, event.window_ts + windowMs - nowMs);
  }
  // Every live event expiring is still not enough: report the last expiry rather than 0.
  return Math.max(0, fallbackExpiryMs - nowMs);
}

export function createTokenWindow(options: TokenWindowOptions): TokenWindow {
  const { db } = options;
  const now = options.now ?? Date.now;
  const defaultWindowMs = options.windowMs;
  const defaultLimit = options.limitTokens;

  const statements = {
    upsertTenant: db.prepare(
      'INSERT OR IGNORE INTO tenants (tenant_id, limit_tokens, window_ms, created_at) VALUES (?, ?, ?, ?)'
    ),
    selectTenant: db.prepare('SELECT tenant_id, limit_tokens, window_ms, created_at FROM tenants WHERE tenant_id = ?'),
    selectTenants: db.prepare('SELECT tenant_id, limit_tokens, window_ms, created_at FROM tenants'),
    evictTenant: db.prepare('DELETE FROM token_events WHERE tenant_id = ? AND window_ts <= ?'),
    sumWindow: db.prepare(
      'SELECT COALESCE(SUM(tokens), 0) AS used, COUNT(*) AS events FROM token_events WHERE tenant_id = ? AND window_ts > ?'
    ),
    oldestInWindow: db.prepare('SELECT MIN(window_ts) AS oldest FROM token_events WHERE tenant_id = ? AND window_ts > ?'),
    windowEvents: db.prepare(
      'SELECT window_ts, tokens FROM token_events WHERE tenant_id = ? AND window_ts > ? ORDER BY window_ts, id'
    ),
    insertEvent: db.prepare(
      'INSERT INTO token_events (tenant_id, window_ts, tokens, kind, reservation_id, request_id, provider, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ),
    selectReservation: db.prepare("SELECT * FROM token_events WHERE reservation_id = ? AND kind = 'reservation' LIMIT 1"),
    deleteById: db.prepare('DELETE FROM token_events WHERE id = ?'),
    deleteReservation: db.prepare("DELETE FROM token_events WHERE reservation_id = ? AND kind = 'reservation'"),
    eventsInWindow: db.prepare(
      'SELECT * FROM token_events WHERE tenant_id = ? AND window_ts > ? ORDER BY window_ts, id'
    )
  };

  const readTenant = (tenantId: string): TenantRow | undefined => statements.selectTenant.get<TenantRow>(tenantId);

  const ensureTenant = (tenantId: string): TenantRow => {
    const existing = readTenant(tenantId);
    if (existing !== undefined) return existing;
    statements.upsertTenant.run(tenantId, defaultLimit, defaultWindowMs, now());
    const created = readTenant(tenantId);
    if (created === undefined) throw new Error(`tenant row for "${tenantId}" disappeared during admission`);
    return created;
  };


  const usedSince = (tenantId: string, cutoff: number): { used: number; events: number } => {
    const row = statements.sumWindow.get<{ used: number | null; events: number }>(tenantId, cutoff);
    return { used: Number(row?.used ?? 0), events: Number(row?.events ?? 0) };
  };

  const window: TokenWindow = {
    /**
     * The admission transaction. Order inside the transaction is load-bearing:
     * evict (indexed) → sum the live window → decide → reserve.
     *
     * Window convention: an event contributes for exactly `windowMs` milliseconds — at
     * `window_ts + windowMs` it is evicted (`window_ts <= now - windowMs`), so a tenant that spent
     * its whole budget can be admitted again at exactly the reset instant (`retryAfterMs === 0`).
     */
    admit(tenantId: string, estimatedTokens: number, requestId: string): Admission {
      const estimate = requireNonNegativeInteger(estimatedTokens, 'estimatedTokens');
      const at = now();

      return db.transaction(() => {
        const tenant = ensureTenant(tenantId);
        const cutoff = at - tenant.window_ms;

        // 1. eviction — an index range scan on (tenant_id, window_ts), not a table scan
        statements.evictTenant.run(tenantId, cutoff);

        // 2. the live window
        const { used } = usedSince(tenantId, cutoff);

        // 3. the decision
        if (used + estimate > tenant.limit_tokens) {
          return {
            ok: false,
            // `Retry-After` must answer "when will *this* request fit?", not "when does the window
            // start freeing?": a client that honours an answer derived from the oldest event may
            // come back and be rejected again. So walk the window in expiry order and stop at the
            // event that frees enough capacity.
            retryAfterMs: timeUntilFits(
              statements.windowEvents.all<{ window_ts: number; tokens: number }>(tenantId, cutoff),
              at,
              tenant.window_ms,
              used,
              estimate,
              tenant.limit_tokens,
              (statements.oldestInWindow.get<{ oldest: number | null }>(tenantId, cutoff)?.oldest ?? at) + tenant.window_ms
            ),
            used,
            limit: tenant.limit_tokens,
            oversized: estimate > tenant.limit_tokens
          } satisfies Admission;
        }

        // 4. the reservation — `used + estimate === limit` is admitted (the boundary is inclusive)
        const reservationId = `res_${randomUUID()}`;
        statements.insertEvent.run(tenantId, at, estimate, 'reservation', reservationId, requestId, null, at);

        return {
          ok: true,
          reservationId,
          tokens: estimate,
          used: used + estimate,
          limit: tenant.limit_tokens
        } satisfies Admission;
      });
    },

    /**
     * Swaps the reservation for the provider's real token count, keeping the original `window_ts`.
     * Idempotent: a second call for the same reservation is a no-op, so a retried bookkeeping path
     * cannot double-spend (asserted in the concurrency suite).
     */
    reconcile(reservationId: string, actualTokens: number, provider?: string): ReconcileResult {
      const actual = requireNonNegativeInteger(actualTokens, 'actualTokens');
      const at = now();

      return db.transaction(() => {
        const reservation = statements.selectReservation.get<TokenEventRow>(reservationId);
        if (reservation === undefined) return { reconciled: false, estimated: 0, actual, delta: 0 };

        statements.deleteById.run(reservation.id);
        statements.insertEvent.run(
          reservation.tenant_id,
          reservation.window_ts,
          actual,
          'actual',
          reservation.reservation_id,
          reservation.request_id,
          provider ?? reservation.provider,
          at
        );

        return { reconciled: true, estimated: reservation.tokens, actual, delta: actual - reservation.tokens };
      });
    },

    /** Pre-flight failure (no provider ever accepted the request) → give the capacity back. */
    release(reservationId: string): boolean {
      return db.transaction(() => statements.deleteReservation.run(reservationId).changes > 0);
    },

    /** Deletes every expired event, per tenant window. Returns the number of rows removed. */
    sweep(): number {
      const at = now();
      return db.transaction(() => {
        let removed = 0;
        for (const tenant of statements.selectTenants.all<TenantRow>()) {
          removed += statements.evictTenant.run(tenant.tenant_id, at - tenant.window_ms).changes;
        }
        return removed;
      });
    },


    usage(tenantId: string): WindowUsage {
      const at = now();
      const tenant = readTenant(tenantId);
      const windowMs = tenant?.window_ms ?? defaultWindowMs;
      const limit = tenant?.limit_tokens ?? defaultLimit;
      const cutoff = at - windowMs;
      const { used, events } = usedSince(tenantId, cutoff);
      const oldest = statements.oldestInWindow.get<{ oldest: number | null }>(tenantId, cutoff)?.oldest;

      return {
        tenantId,
        limit,
        used,
        remaining: Math.max(0, limit - used),
        resetAtMs: (oldest === null || oldest === undefined ? at : Number(oldest)) + windowMs,
        windowMs,
        events
      };
    },

    eventsInWindow(tenantId: string): TokenEventRow[] {
      const windowMs = readTenant(tenantId)?.window_ms ?? defaultWindowMs;
      return statements.eventsInWindow.all<TokenEventRow>(tenantId, now() - windowMs);
    },

    tenant: readTenant,

    transaction: <T>(fn: () => T) => db.transaction(fn)
  };

  return window;
}
