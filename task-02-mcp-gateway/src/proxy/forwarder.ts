/**
 * Downstream forwarding: header hygiene, a bounded time-to-first-byte, and a
 * response body that is piped rather than buffered.
 *
 * Transparency contract (the README's status table is authoritative):
 *
 *  - request: `method`/`id`/`jsonrpc`/`params` are forwarded byte-identically (the
 *    raw body text is reused whenever no element had to be removed); `Accept` and
 *    `Content-Type` are mirrored; `Host` and `Content-Length` are recomputed by
 *    `fetch`.
 *  - response: status, content-type and body bytes are returned unchanged.
 *  - the caller's `Authorization` is **not** forwarded by default. A gateway that
 *    relays the end-user credential downstream turns every downstream server into a
 *    credential store and breaks the whole point of a single choke point.
 *  - `GATEWAY_UPSTREAM_TIMEOUT_MS` bounds **time to response headers**, not the whole
 *    exchange: a long SSE stream must not be cut off mid-flight.
 */
import type { ReadableStream as WebReadableStream } from 'node:stream/web';

/** Headers that are meaningless or dangerous to relay (RFC 9110 §7.6.1 + proxies). */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade'
]);

/**
 * Request headers the gateway owns and therefore never relays. `content-encoding` is one of them
 * because the body parser has already decoded a compressed request: what goes downstream is the
 * decoded text, and relaying `gzip` with it would make the downstream decode it a second time.
 */
const REQUEST_DENY = new Set([
  ...HOP_BY_HOP,
  'host',
  'content-length',
  'content-encoding',
  'cookie',
  'set-cookie',
  'expect'
]);

/** Response headers the gateway owns. `content-*` length/encoding are recomputed when piping. */
const RESPONSE_DENY = new Set([...HOP_BY_HOP, 'content-length', 'content-encoding']);

export interface ForwardHeaderOptions {
  /** Relay the caller's `Authorization` (default false — see the module doc). */
  forwardClientAuth?: boolean;
  /** Service credential injected as `Authorization: Bearer <token>`. */
  downstreamToken?: string;
  /** Content type to send upstream; mirrors the client's when omitted. */
  contentType?: string;
}

export type ClientHeaders = Record<string, string | string[] | undefined>;

/**
 * Build the upstream header set.
 *
 * Deny-list rather than allow-list: MCP carries behaviour in headers
 * (`Mcp-Session-Id`, `MCP-Protocol-Version`, `Last-Event-ID`) and an allow-list
 * would silently drop future ones, breaking "transparent" for a protocol that is
 * still evolving.
 */
export function buildForwardHeaders(client: ClientHeaders, options: ForwardHeaderOptions = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [rawName, rawValue] of Object.entries(client)) {
    if (rawValue === undefined) continue;
    const name = rawName.toLowerCase();
    if (REQUEST_DENY.has(name)) continue;
    if (name === 'authorization' && options.forwardClientAuth !== true) continue;
    // Forced to identity so the proxied body is byte-comparable and the response
    // headers stay consistent (see the README's transparency notes).
    if (name === 'accept-encoding') continue;
    out[name] = Array.isArray(rawValue) ? rawValue.join(', ') : rawValue;
  }

  out['accept-encoding'] = 'identity';
  if (options.contentType !== undefined) out['content-type'] = options.contentType;
  if (options.downstreamToken !== undefined) out.authorization = `Bearer ${options.downstreamToken}`;
  return out;
}

/** Copy a response header set, dropping hop-by-hop and body-framing headers. */
export function filterResponseHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, name) => {
    if (RESPONSE_DENY.has(name.toLowerCase())) return;
    out[name] = value;
  });
  return out;
}

export interface ForwardOptions {
  downstreamUrl: string;
  /** Bound on time to response headers. */
  timeoutMs: number;
  /** Exact bytes to send as the upstream body. */
  body: string;
  headers: Record<string, string>;
  fetchImpl?: typeof fetch;
  /** Aborts the upstream call when the client goes away. */
  signal?: AbortSignal;
  now?: () => number;
}

export interface ForwardedResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  contentType: string;
  body: WebReadableStream<Uint8Array> | null;
  durationMs: number;
}

export type ForwardFailureKind = 'unreachable' | 'timeout';

export type ForwardOutcome =
  | { ok: true; response: ForwardedResponse }
  | { ok: false; kind: ForwardFailureKind; durationMs: number };

/**
 * POST the body downstream and hand back the raw response.
 *
 * The body is never read here: callers stream it (SSE) or buffer it explicitly, so
 * a streaming response is never accidentally materialised in memory.
 */
export async function forward(options: ForwardOptions): Promise<ForwardOutcome> {
  const now = options.now ?? (() => Date.now());
  const fetchImpl = options.fetchImpl ?? fetch;
  const startedAt = now();

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs);

  const signal =
    options.signal === undefined ? controller.signal : AbortSignal.any([controller.signal, options.signal]);

  try {
    const response = await fetchImpl(options.downstreamUrl, {
      method: 'POST',
      headers: options.headers,
      body: options.body,
      signal,
      redirect: 'manual'
    });
    const durationMs = now() - startedAt;
    return {
      ok: true,
      response: {
        status: response.status,
        statusText: response.statusText,
        headers: filterResponseHeaders(response.headers),
        contentType: response.headers.get('content-type') ?? 'application/json',
        body: response.body as WebReadableStream<Uint8Array> | null,
        durationMs
      }
    };
  } catch {
    return { ok: false, kind: timedOut ? 'timeout' : 'unreachable', durationMs: now() - startedAt };
  } finally {
    clearTimeout(timer);
  }
}
