/**
 * Process-wide counters exposed on `GET /stats`.
 *
 * Why `/stats` matters here: for a *streaming* response the final redaction count is not known
 * when the headers are written, so `X-Guardrail-Redactions` can only be set on the non-streaming
 * path. The streaming path reports through these counters instead (documented in the README).
 */
import type { RedactionCounts } from './redact/streamingRedactor.js';

export const COUNTERS = [
  'requests',
  'streams',
  'nonStreamingRequests',
  'chunksIn',
  'chunksOut',
  'eventsIn',
  'eventsOut',
  'unparsedEvents',
  'upstreamErrors',
  'upstreamTimeouts',
  'clientDisconnects',
  'holdbackCapHits',
  'redactions'
] as const;

export type CounterName = (typeof COUNTERS)[number];

export interface MetricsSnapshot {
  uptimeMs: number;
  requests: number;
  streams: number;
  nonStreamingRequests: number;
  chunksIn: number;
  chunksOut: number;
  eventsIn: number;
  eventsOut: number;
  unparsedEvents: number;
  upstreamErrors: number;
  upstreamTimeouts: number;
  clientDisconnects: number;
  holdbackCapHits: number;
  redactions: number;
  redactionsByType: RedactionCounts;
  bytesIn: number;
  bytesOut: number;
  /** Largest retained tail across every redactor — the memory bound, observed live. */
  maxBufferSeen: number;
}

export interface Metrics {
  inc(name: CounterName, by?: number): void;
  addBytesIn(bytes: number): void;
  addBytesOut(bytes: number): void;
  addRedactions(byType: RedactionCounts): void;
  /** Records a retained-tail size so `/stats` can prove the buffer stays bounded. */
  observeBuffer(bytes: number): void;
  snapshot(): MetricsSnapshot;
  reset(): void;
}

export function createMetrics(now: () => number = Date.now): Metrics {
  const counters: Record<CounterName, number> = Object.fromEntries(COUNTERS.map((name) => [name, 0])) as Record<
    CounterName,
    number
  >;
  let redactionsByType: RedactionCounts = {};
  let bytesIn = 0;
  let bytesOut = 0;
  let maxBufferSeen = 0;
  const startedAt = now();

  return {
    inc(name, by = 1) {
      counters[name] += by;
    },
    addBytesIn(bytes) {
      bytesIn += bytes;
    },
    addBytesOut(bytes) {
      bytesOut += bytes;
    },
    addRedactions(byType) {
      for (const [type, count] of Object.entries(byType)) {
        redactionsByType[type] = (redactionsByType[type] ?? 0) + count;
        counters.redactions += count;
      }
    },
    observeBuffer(bytes) {
      if (bytes > maxBufferSeen) maxBufferSeen = bytes;
    },
    snapshot() {
      return {
        uptimeMs: now() - startedAt,
        ...counters,
        redactionsByType: { ...redactionsByType },
        bytesIn,
        bytesOut,
        maxBufferSeen
      };
    },
    reset() {
      for (const name of COUNTERS) counters[name] = 0;
      redactionsByType = {};
      bytesIn = 0;
      bytesOut = 0;
      maxBufferSeen = 0;
    }
  };
}
