/**
 * One upstream attempt, with **three** deadlines that mean three different things.
 *
 * ```
 *   callProvider(provider, body, { signal, timeoutMs, firstByteTimeoutMs, idleTimeoutMs })
 *        │  headersTimer = setTimeout(timeoutMs)      ← the failover deadline
 *        │  ├─ fetch rejects before headers → { kind: 'timeout', phase: 'headers' }   (failover OK)
 *        │  ├─ status >= 400                → { kind: 'http', status }                (body drained)
 *        │  └─ status <  400                → clearTimeout(headersTimer)
 *        │                                     firstByteTimer = setTimeout(firstByteTimeoutMs)
 *        │                                     on the first body chunk:
 *        │                                       clearTimeout(firstByteTimer)
 *        │                                       idleTimer = setTimeout(idleTimeoutMs) ← stall detector
 *        │                                       every further chunk resets it
 *        └─ release(): clears every timer and the abort listener (no zombie timer, no leaked socket)
 * ```
 *
 * `timeoutMs` is **time to first response headers**, which is what "the primary timed out after
 * 3000 ms, fail over" means. It is deliberately *not* a total request budget: a healthy completion
 * may legitimately take longer than three seconds, and killing it would truncate a good answer and
 * (worse) regenerate it on the secondary. What must not happen is silence, and that is what the other
 * two deadlines measure.
 *
 * `firstByteTimeoutMs` is the window allowed between the response headers and the first body byte. It
 * exists because a model provider sends headers as soon as it accepts the request and *then* spends
 * seconds on prompt processing before the first token: charging that gap to the stall watchdog would
 * kill a healthy request. The watchdog only starts on the first chunk, and from there a provider that
 * sends a byte every few seconds streams for as long as it likes.
 *
 * `release()` **must** be called by the caller on every path. For a streaming success the idle
 * watchdog stays armed while the body is piped: if the provider goes quiet mid-stream the abort kills
 * the body, the router sees a mid-stream failure and terminates the SSE stream with a sanitized error
 * event — failover is no longer possible once bytes reached the client.
 *
 * **Non-streaming requests are bounded by the same deadline, and the docs say so.** A provider sends
 * the headers of a `stream: false` completion only once the completion is *finished*, so for a
 * non-streaming request `timeoutMs` bounds the whole completion and a long non-streaming answer fails
 * over to the secondary by design. Time-to-headers is what the streaming mode gets.
 *
 * The `fetch` implementation is injectable so the whole router is offline-testable.
 */
import type { ProviderConfig } from '../config.js';

export type ProviderMode = 'stream' | 'buffer';

export interface ProviderOk {
  kind: 'ok';
  status: number;
  headers: Headers;
  /** Present in `stream` mode. */
  stream: ReadableStream<Uint8Array> | null;
  /** Present in `buffer` mode: the raw payload text, forwarded verbatim to the client. */
  text?: string;
  /** Parsed payload when the provider returned JSON; `undefined` for a non-JSON body. */
  json?: unknown;
  elapsedMs: number;
  /** True when the *headers* deadline fired (checked after the body has been consumed). */
  timedOut(): boolean;
  /** True when the body went silent for longer than the idle deadline, or never started in time. */
  stalled(): boolean;
  release(): void;
}

export interface ProviderTimeout {
  kind: 'timeout';
  elapsedMs: number;
  /**
   * `headers` = the provider never started responding; `body` = it responded but produced no body
   * byte within the first-byte deadline, or went quiet mid-response. Nothing has been written to the
   * client in either case, so both are eligible for failover. Only a *buffered* attempt can end with a
   * `body` timeout: a streamed attempt is `ok` as soon as its headers arrive, and a later stall shows
   * up as `ProviderOk.stalled()` on a response the gateway has already committed.
   */
  phase: 'headers' | 'body';
}

export interface ProviderHttpError {
  kind: 'http';
  status: number;
  elapsedMs: number;
}

export interface ProviderNetworkError {
  kind: 'network';
  /** Error name (plus an optional syscall code) only — an upstream body or URL never appears here. */
  error: string;
  code?: string;
  elapsedMs: number;
}

export type ProviderResult = ProviderOk | ProviderTimeout | ProviderHttpError | ProviderNetworkError;

export interface CallProviderOptions {
  signal?: AbortSignal;
  /**
   * Deadline for the provider to *start* responding. This is the failover deadline: when it fires,
   * nothing has been written to the client, so another provider may be tried.
   */
  timeoutMs: number;
  /**
   * Deadline for the first body byte, measured from the response headers. Prompt processing happens
   * after the headers, so this is what keeps a slow first token from looking like a stalled stream.
   * `0` disables it; defaults to `timeoutMs`.
   */
  firstByteTimeoutMs?: number;
  /**
   * Idle deadline for the response body. A healthy response may take as long as it likes as long as
   * it keeps producing bytes; it may not go silent for longer than this. `0` disables the watchdog.
   */
  idleTimeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** Defaults to `stream` when `body.stream === true`, else `buffer`. */
  mode?: ProviderMode;
  /** Cap for a buffered response body. Default 1 MiB. */
  maxBytes?: number;
}

const DEFAULT_MAX_BYTES = 1024 * 1024;
const DRAIN_BYTES = 64 * 1024;

export class ProviderPayloadTooLargeError extends Error {
  readonly limit: number;
  constructor(limit: number) {
    super(`provider payload exceeds ${limit} bytes`);
    this.name = 'ProviderPayloadTooLargeError';
    this.limit = limit;
  }
}

/** `…/v1` + `/chat/completions`, tolerant of a trailing slash. */
export function providerUrl(provider: ProviderConfig): string {
  return `${provider.baseUrl.replace(/\/+$/, '')}/chat/completions`;
}

/** Host only — logs and `/healthz` use this; a provider hostname never reaches an error body. */
export function providerHost(provider: ProviderConfig): string {
  try {
    return new URL(provider.baseUrl).host;
  } catch {
    return 'unknown';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readBounded(
  stream: ReadableStream<Uint8Array> | null,
  limit: number,
  onChunk?: () => void
): Promise<string> {
  if (stream === null) return '';
  const reader = stream.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: false });
  let text = '';
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      onChunk?.();
      bytes += value.byteLength;
      if (bytes > limit) {
        await reader.cancel();
        throw new ProviderPayloadTooLargeError(limit);
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    reader.releaseLock();
  }
}

/** Reads and discards a bounded amount so the socket stays reusable, then cancels the rest. */
async function drain(stream: ReadableStream<Uint8Array> | null, limit = DRAIN_BYTES): Promise<void> {
  if (stream === null) return;
  try {
    const reader = stream.getReader();
    let bytes = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value?.byteLength ?? 0;
        if (bytes >= limit) break;
      }
    } finally {
      reader.releaseLock();
    }
    await stream.cancel().catch(() => undefined);
  } catch {
    /* an already-aborted body is fine: we only wanted the socket back */
  }
}

/**
 * Wraps an upstream body so every chunk reports progress: the first chunk ends the first-byte window
 * and every chunk resets the stall watchdog. The bytes are forwarded untouched (this is a tap, not a
 * buffer).
 */
function withIdleReset(
  stream: ReadableStream<Uint8Array> | null,
  onChunk: () => void
): ReadableStream<Uint8Array> | null {
  if (stream === null) return null;
  return stream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        onChunk();
        controller.enqueue(chunk);
      }
    })
  );
}

export async function callProvider(
  provider: ProviderConfig,
  body: unknown,
  options: CallProviderOptions
): Promise<ProviderResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const mode: ProviderMode = options.mode ?? (isRecord(body) && body.stream === true ? 'stream' : 'buffer');
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const idleTimeoutMs = options.idleTimeoutMs ?? 0;
  const firstByteTimeoutMs = options.firstByteTimeoutMs ?? options.timeoutMs;
  const startedAt = Date.now();

  const controller = new AbortController();
  let headersTimedOut = false;
  let firstByteTimedOut = false;
  let bodyStalled = false;
  let released = false;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let firstByteTimer: ReturnType<typeof setTimeout> | undefined;

  // Three deadlines, three meanings:
  //   headersTimer    the provider must *start* responding within `timeoutMs` (failover deadline)
  //   firstByteTimer  the body must *begin* within `firstByteTimeoutMs` of the headers — prompt
  //                   processing happens after the headers and is not a stall
  //   idleTimer       the body must keep producing bytes within `idleTimeoutMs` (stall detector)
  const headersTimer = setTimeout(() => {
    headersTimedOut = true;
    controller.abort();
  }, options.timeoutMs);

  const armFirstByte = (): void => {
    if (firstByteTimeoutMs <= 0 || released) return;
    firstByteTimer = setTimeout(() => {
      firstByteTimedOut = true;
      controller.abort();
    }, firstByteTimeoutMs);
  };

  const touch = (): void => {
    if (idleTimeoutMs <= 0 || released) return;
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      bodyStalled = true;
      controller.abort();
    }, idleTimeoutMs);
  };

  /**
   * Every body chunk reports progress. The first one closes the first-byte window; from then on only
   * the stall watchdog applies, so a provider may stream for as long as it keeps talking.
   */
  const onBodyChunk = (): void => {
    if (firstByteTimer !== undefined) {
      clearTimeout(firstByteTimer);
      firstByteTimer = undefined;
    }
    touch();
  };

  const onExternalAbort = (): void => controller.abort();
  options.signal?.addEventListener('abort', onExternalAbort, { once: true });

  const release = (): void => {
    if (released) return;
    released = true;
    clearTimeout(headersTimer);
    if (firstByteTimer !== undefined) clearTimeout(firstByteTimer);
    firstByteTimer = undefined;
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    idleTimer = undefined;
    options.signal?.removeEventListener('abort', onExternalAbort);
  };

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: mode === 'stream' ? 'text/event-stream' : 'application/json'
  };
  if (provider.apiKey !== undefined && provider.apiKey !== '') headers.authorization = `Bearer ${provider.apiKey}`;

  try {
    const response = await fetchImpl(providerUrl(provider), {
      method: 'POST',
      headers,
      // The router owns the model choice: a client cannot pin a model behind the gateway's back.
      body: JSON.stringify(isRecord(body) ? { ...body, model: provider.model } : body),
      signal: controller.signal
    });

    // Headers arrived: the failover deadline no longer applies. From here on, only silence is fatal —
    // and silence is measured in two stages: first byte, then inter-chunk gap.
    clearTimeout(headersTimer);
    armFirstByte();

    if (response.status >= 400) {
      await drain(response.body);
      release();
      return { kind: 'http', status: response.status, elapsedMs: Date.now() - startedAt };
    }

    if (mode === 'stream') {
      return {
        kind: 'ok',
        status: response.status,
        headers: response.headers,
        stream: withIdleReset(response.body, onBodyChunk),
        elapsedMs: Date.now() - startedAt,
        timedOut: () => headersTimedOut,
        stalled: () => bodyStalled || firstByteTimedOut,
        release
      };
    }

    const text = await readBounded(response.body, maxBytes, onBodyChunk);
    release();
    let json: unknown;
    try {
      json = JSON.parse(text) as unknown;
    } catch {
      json = undefined;
    }
    return {
      kind: 'ok',
      status: response.status,
      headers: response.headers,
      stream: null,
      text,
      json,
      elapsedMs: Date.now() - startedAt,
      timedOut: () => headersTimedOut,
      stalled: () => bodyStalled || firstByteTimedOut,
      release
    };
  } catch (error) {
    release();
    const elapsedMs = Date.now() - startedAt;
    if (headersTimedOut) return { kind: 'timeout', elapsedMs, phase: 'headers' };
    if (bodyStalled || firstByteTimedOut) return { kind: 'timeout', elapsedMs, phase: 'body' };
    if (options.signal?.aborted === true) return { kind: 'network', error: 'ClientAborted', elapsedMs };
    const code = (error as { code?: unknown }).code;
    return {
      kind: 'network',
      error: error instanceof Error ? error.name : 'UnknownError',
      ...(typeof code === 'string' ? { code } : {}),
      elapsedMs
    };
  }
}
