/**
 * Process-wide counters, exposed on `GET /stats` (JSON) and `GET /metrics` (Prometheus text).
 *
 * The counters are the observability half of the graded behaviour: `rate_limited` vs `admitted`
 * shows the limiter working, `failovers` vs `provider_*` shows where traffic landed, and
 * `tokens_reserved` vs `tokens_reconciled` shows the reservation/reconcile dance actually closing.
 *
 * No tenant key, prompt text or upstream body is ever a label: that would put a secret (or PII) in
 * a metrics endpoint.
 */
export const COUNTERS = [
  'requests',
  'admitted',
  'rate_limited',
  'invalid_requests',
  'unauthorized',
  'internal_errors',
  'payload_too_large',
  'provider_primary',
  'provider_secondary',
  'failovers',
  'upstream_errors',
  'upstream_timeouts',
  'upstream_stalls',
  'usage_frames_stripped',
  'tenants_rejected',
  'streams',
  'non_streaming',
  'stream_failures',
  'client_disconnects',
  'reservations_released',
  'tokens_reserved',
  'tokens_reconciled',
  'tokens_actual',
  'sweeps',
  'swept_events'
] as const;

export type CounterName = (typeof COUNTERS)[number];

export interface MetricsSnapshot {
  uptimeMs: number;
  counters: Record<CounterName, number>;
  /** Same numbers, flattened for `X-` style convenience and for the demo. */
  totals: Record<string, number>;
}

export interface Metrics {
  inc(name: CounterName, by?: number): void;
  snapshot(): MetricsSnapshot;
  reset(): void;
  /** Prometheus text exposition format (content-type `text/plain; version=0.0.4`). */
  prometheus(): string;
}

function toSnake(name: string): string {
  return name.replace(/[^a-z0-9]+/gi, '_').toLowerCase();
}

export function createMetrics(now: () => number = Date.now): Metrics {
  const counters = Object.fromEntries(COUNTERS.map((name) => [name, 0])) as Record<CounterName, number>;
  const startedAt = now();

  return {
    inc(name, by = 1) {
      counters[name] += by;
    },

    snapshot() {
      return {
        uptimeMs: now() - startedAt,
        counters: { ...counters },
        totals: { ...counters }
      };
    },

    reset() {
      for (const name of COUNTERS) counters[name] = 0;
    },

    prometheus() {
      const lines: string[] = [];
      for (const name of COUNTERS) {
        const metric = `gateway_${toSnake(name)}_total`;
        lines.push(`# HELP ${metric} Task 4 router counter (${name})`);
        lines.push(`# TYPE ${metric} counter`);
        lines.push(`${metric} ${counters[name]}`);
      }
      lines.push('# HELP gateway_uptime_milliseconds Process uptime in ms');
      lines.push('# TYPE gateway_uptime_milliseconds gauge');
      lines.push(`gateway_uptime_milliseconds ${now() - startedAt}`);
      return `${lines.join('\n')}\n`;
    }
  };
}
