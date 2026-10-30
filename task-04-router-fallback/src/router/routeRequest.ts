/**
 * The routing decision — the graded middle of Task 4.
 *
 * ```
 *   validate ─▶ tenant ─▶ estimate ─▶ ADMIT (one transaction) ─▶ attempts
 *                                        │ denied                 │
 *                                        ▼                        ├─ ok        → commit to client, reconcile(usage)
 *                                 429 + Retry-After               ├─ timeout   → eligible for failover
 *                                        │                        ├─ http 429/5xx → eligible for failover
 *                                        │                        ├─ network   → eligible for failover
 *                                        │                        └─ exhausted → release reservation, 5xx envelope
 * ```
 *
 * **The streaming rule.** Failover is only possible while *nothing* has been written to the client.
 * The moment a 2xx upstream response exists we return a `stream` plan and the gateway is committed:
 * if the provider then dies mid-stream the client gets a sanitized SSE error event and a `[DONE]`
 * terminator. Restarting on the secondary would duplicate tokens the client has already seen and
 * corrupt its state — worse than a truncated, honestly-labelled stream. The test that pins this
 * asserts the secondary recorded **zero** calls after a mid-stream failure.
 *
 * **Token accounting.** `admit` reserves an estimate; a successful response is reconciled against
 * the provider's `usage` (streamed or buffered, via a bounded pass-through scanner). A total failure
 * releases the reservation, because no tokens were produced. A mid-stream failure reconciles with
 * whatever we know, conservatively falling back to the reservation.
 */
import type { RouterConfig } from '../config.js';
import type { Db } from '../db/database.js';
import type { Logger } from '../logging/logger.js';
import type { Metrics } from '../metrics/metrics.js';
import { reservationTokens } from '../ratelimit/counter.js';
import type { TokenWindow } from '../ratelimit/tokenWindow.js';
import type { Mutex } from '../ratelimit/mutex.js';
import {
  classifyFailures,
  errorEnvelope,
  gatewayError,
  rateLimitHeaders,
  retryAfterSeconds,
  type AttemptFailure,
  type GatewayError
} from '../errors/gatewayErrors.js';
import { callProvider, type ProviderOk, type ProviderResult } from '../providers/providerClient.js';
import { failureKind, isFailoverEligible, resolveAttemptOrder, type Attempt } from '../providers/registry.js';
import { createSseUsageFilter, readUsagePayload, type TokenUsage } from './usageScanner.js';
import { createRequestLog, type RequestLog, type RequestOutcome } from './requestLog.js';
import type { ChatCompletionRequest } from './schema.js';

export interface RouterContext {
  config: RouterConfig;
  db: Db;
  tokenWindow: TokenWindow;
  logger: Logger;
  metrics: Metrics;
  mutex: Mutex;
  fetchImpl?: typeof fetch;
  now?: () => number;
  requestLog?: RequestLog;
}

export interface CompletionInput {
  requestId: string;
  tenantId: string;
  body: ChatCompletionRequest;
  /** Aborted when the client goes away, so an abandoned request stops costing upstream time. */
  signal?: AbortSignal;
}

export interface StreamPlan {
  kind: 'stream';
  status: number;
  headers: Record<string, string>;
  /** Pass-through upstream bytes; the router scans them for `usage` without retaining them. */
  body: ReadableStream<Uint8Array>;
  /** Must be called exactly once when the pipe finished or failed. */
  complete(result: { ok: boolean; error?: unknown }): void;
  /** Sanitized SSE frames to send when the upstream stream dies after the first byte. */
  midStreamFailureFrames(): string;
}

export type CompletionPlan =
  | { kind: 'error'; error: GatewayError }
  | { kind: 'buffered'; status: number; headers: Record<string, string>; body: string }
  | StreamPlan;

/** `total_tokens` wins; otherwise prompt+completion; otherwise `undefined` (→ keep the estimate). */
export function resolveActualTokens(usage: TokenUsage | undefined): number | undefined {
  if (usage === undefined) return undefined;
  if (typeof usage.total_tokens === 'number') return usage.total_tokens;
  const { prompt_tokens: prompt, completion_tokens: completion } = usage;
  if (typeof prompt === 'number' && typeof completion === 'number') return prompt + completion;
  return undefined;
}

/**
 * What the router sends upstream. It pins nothing about the payload except one thing: a streamed
 * request asks the provider for `stream_options.include_usage`, because otherwise a streamed
 * completion can only be charged the admission estimate (measured live: 45 tokens charged for a
 * 447-token answer). The frame is hidden again on the way back when the client did not ask for it.
 */
export function buildUpstreamBody(body: ChatCompletionRequest, config: Pick<RouterConfig, 'injectStreamUsage'>): ChatCompletionRequest {
  if (config.injectStreamUsage !== true || body.stream !== true) return body;
  const streamOptions = isRecord(body.stream_options) ? body.stream_options : {};
  return { ...body, stream_options: { ...streamOptions, include_usage: true } };
}

/** Did the *client* ask for the usage frame? */
export function clientWantsUsage(body: ChatCompletionRequest): boolean {
  return isRecord(body.stream_options) && body.stream_options.include_usage === true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function serializeSseError(error: GatewayError): string {
  return `data: ${JSON.stringify(errorEnvelope(error))}\n\ndata: [DONE]\n\n`;
}

export async function handleCompletion(input: CompletionInput, ctx: RouterContext): Promise<CompletionPlan> {
  const { config, logger, metrics, tokenWindow, mutex } = ctx;
  const now = ctx.now ?? Date.now;
  const requestLog = ctx.requestLog ?? createRequestLog(ctx.db, now);
  const startedAt = now();
  const log = logger.child({ reqId: input.requestId, tenant: input.tenantId });
  // Admission reserves the input estimate *plus* an output budget: a reservation that ignored
  // `max_tokens` would let a tenant spend the whole window on prompts and stream unbounded output.
  const estimate = reservationTokens(input.body, config);
  const upstreamBody = buildUpstreamBody(input.body, config);
  const stripUsage = !clientWantsUsage(input.body);
  metrics.inc('requests');

  // Admission. The in-process mutex queues same-tenant bursts; SQLite's `BEGIN IMMEDIATE` is what
  // makes the decision exact across OS processes (see tests/concurrency/cross-process.test.ts).
  const admission = await mutex.runExclusive(input.tenantId, () =>
    tokenWindow.admit(input.tenantId, estimate, input.requestId)
  );

  if (!admission.ok) {
    metrics.inc('rate_limited');
    const usage = tokenWindow.usage(input.tenantId);
    const retryAfterMs = admission.retryAfterMs > 0 ? admission.retryAfterMs : Math.max(0, usage.resetAtMs - now());
    const headers = {
      ...rateLimitHeaders({ limit: usage.limit, remaining: usage.remaining, resetAtMs: usage.resetAtMs }),
      'Retry-After': String(retryAfterSeconds(retryAfterMs))
    };
    log.warn('rate_limited', {
      used: admission.used,
      limit: admission.limit,
      estimate,
      retryAfterMs,
      oversized: admission.oversized
    });
    requestLog.record({ requestId: input.requestId, tenantId: input.tenantId, outcome: 'rate_limited', latencyMs: now() - startedAt });
    return { kind: 'error', error: gatewayError('rate_limited', { requestId: input.requestId, retryAfterMs, headers }) };
  }

  metrics.inc('admitted');
  metrics.inc('tokens_reserved', estimate);
  log.debug('admitted', { estimate, used: admission.used, limit: admission.limit });

  const succeed = (attempt: Attempt, result: ProviderOk): CompletionPlan => {
    const fallback = attempt.role === 'secondary';
    if (fallback) metrics.inc('failovers');
    metrics.inc(attempt.role === 'primary' ? 'provider_primary' : 'provider_secondary');

    const gatewayHeaders: Record<string, string> = {
      'x-gateway-provider': attempt.role,
      'x-gateway-fallback': fallback ? 'true' : 'false',
      'x-gateway-attempts': String(attempt.index),
      'x-gateway-request-id': input.requestId
    };
    const upstreamStream = result.stream;

    if (upstreamStream === null) {
      metrics.inc('non_streaming');
      const usage = readUsagePayload(result.json);
      const actual = resolveActualTokens(usage) ?? estimate;
      tokenWindow.reconcile(admission.reservationId, actual, attempt.provider.name);
      metrics.inc('tokens_actual', actual);
      metrics.inc('tokens_reconciled');
      const window = tokenWindow.usage(input.tenantId);
      const outcome: RequestOutcome = fallback ? 'failover' : 'ok';
      requestLog.record({
        requestId: input.requestId,
        tenantId: input.tenantId,
        provider: attempt.role,
        model: attempt.provider.model,
        totalTokens: actual,
        outcome,
        failover: fallback,
        latencyMs: now() - startedAt
      });
      log.info('request_served', {
        provider: attempt.role,
        providerName: attempt.provider.name,
        fallback,
        outcome,
        tokens: actual,
        reconciledFrom: usage !== undefined ? 'usage' : 'reservation',
        latencyMs: now() - startedAt
      });
      result.release();
      return {
        kind: 'buffered',
        status: result.status,
        headers: {
          ...gatewayHeaders,
          ...rateLimitHeaders({ limit: window.limit, remaining: window.remaining, resetAtMs: window.resetAtMs }),
          'content-type': result.headers.get('content-type') ?? 'application/json; charset=utf-8'
        },
        body: result.text ?? ''
      };
    }
    metrics.inc('streams');
    // Bounded, frame-aware pass-through: bytes go straight to the client, only the current frame is
    // held, and the `usage` frame is removed when the client never asked for it.
    const scanner = createSseUsageFilter({ stripUsage });
    const body = upstreamStream.pipeThrough(scanner.stream);
    // Token counts are not known until the stream ends, so these headers reflect the reservation
    // (the same trade-off Task 3 documents for its redaction counter).
    const window = tokenWindow.usage(input.tenantId);
    let finished = false;

    return {
      kind: 'stream',
      status: result.status,
      headers: {
        ...gatewayHeaders,
        ...rateLimitHeaders({ limit: window.limit, remaining: window.remaining, resetAtMs: window.resetAtMs }),
        'content-type': result.headers.get('content-type') ?? 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        'x-accel-buffering': 'no'
      },
      body,
      complete({ ok, error }) {
        if (finished) return;
        finished = true;
        const scanned = resolveActualTokens(scanner.usage());
        const actual = scanned ?? estimate;
        tokenWindow.reconcile(admission.reservationId, actual, attempt.provider.name);
        metrics.inc('tokens_actual', actual);
        metrics.inc('tokens_reconciled');
        if (!ok) {
          metrics.inc('stream_failures');
          if (result.stalled()) metrics.inc('upstream_stalls');
        }
        if (scanner.strippedFrames() > 0) metrics.inc('usage_frames_stripped', scanner.strippedFrames());
        result.release();
        const outcome: RequestOutcome = ok ? (fallback ? 'failover' : 'ok') : 'stream_failed';
        requestLog.record({
          requestId: input.requestId,
          tenantId: input.tenantId,
          provider: attempt.role,
          model: attempt.provider.model,
          totalTokens: actual,
          outcome,
          failover: fallback,
          latencyMs: now() - startedAt
        });
        const fields = {
          provider: attempt.role,
          providerName: attempt.provider.name,
          fallback,
          outcome,
          tokens: actual,
          reconciledFrom: scanned !== undefined ? 'usage' : 'reservation',
          retainedBytes: scanner.maxRetainedBytes(),
          strippedUsageFrames: scanner.strippedFrames(),
          latencyMs: now() - startedAt,
          ...(error instanceof Error ? { reason: error.name } : {})
        };
        if (ok) log.info('stream_finished', fields);
        else if (result.stalled()) log.warn('upstream_stream_stalled', fields);
        else log.warn('stream_failed', fields);
      },
      midStreamFailureFrames() {
        return serializeSseError(gatewayError('stream_failed', { requestId: input.requestId }));
      }
    };
  };

  const attempts = resolveAttemptOrder(config);
  const failures: AttemptFailure[] = [];
  const httpStatuses: number[] = [];
  let attempted = 0;

  for (const attempt of attempts) {
    const isLast = attempt.index === attempts.length;
    attempted = attempt.index;

    const result: ProviderResult = await callProvider(attempt.provider, upstreamBody, {
      timeoutMs: attempt.provider.timeoutMs,
      firstByteTimeoutMs: config.streamFirstByteTimeoutMs,
      idleTimeoutMs: config.streamIdleTimeoutMs,
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
      ...(ctx.fetchImpl !== undefined ? { fetchImpl: ctx.fetchImpl } : {})
    });

    if (result.kind === 'ok') {
      return succeed(attempt, result);
    }

    const kind = failureKind(result) ?? 'network';
    failures.push(kind);
    if (result.kind === 'http') httpStatuses.push(result.status);
    if (kind === 'timeout') metrics.inc('upstream_timeouts');
    metrics.inc('upstream_errors');
    log.warn('provider_attempt_failed', {
      provider: attempt.role,
      kind,
      ...(result.kind === 'http' ? { status: result.status } : {}),
      elapsedMs: result.elapsedMs
    });

    if (!isFailoverEligible(result, config.failoverOn) || isLast) break;
    log.info('failover', { from: attempt.role, to: attempts[attempt.index]?.role ?? 'none', reason: kind });
  }

  // Every attempt failed: nothing was produced, so the reservation goes back.
  tokenWindow.release(admission.reservationId);
  metrics.inc('reservations_released');

  const errorKind = classifyFailures(failures, httpStatuses);
  const error = gatewayError(errorKind, { requestId: input.requestId });
  requestLog.record({
    requestId: input.requestId,
    tenantId: input.tenantId,
    outcome: errorKind === 'upstream_timeout' ? 'upstream_timeout' : 'upstream_error',
    latencyMs: now() - startedAt
  });
  log.warn('all_attempts_failed', { attempts: attempted, failures, httpStatuses, errorKind, status: error.status });
  return { kind: 'error', error };
}
