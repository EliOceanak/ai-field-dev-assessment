/**
 * Upstream client: one `fetch` to the provider, no retries and no buffering — the caller pipes
 * `body` straight into the SSE parser.
 *
 * The `fetch` implementation is injectable so integration tests can script a
 * provider without a network, and the whole gateway stays offline-testable.
 */
import type { GuardrailConfig } from '../config.js';

export interface UpstreamResponse {
  status: number;
  headers: Headers;
  /** Raw byte stream; `null` for responses without a body (e.g. 204). */
  body: ReadableStream<Uint8Array> | null;
}

export interface OpenUpstreamOptions {
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

/** `…/v1` + `/chat/completions`, tolerant of a trailing slash. */
export function upstreamUrl(config: GuardrailConfig): string {
  return `${config.upstreamBaseUrl.replace(/\/+$/, '')}/chat/completions`;
}

/**
 * Host only — never the full provider URL. `/healthz` and the logs use this, so a provider
 * hostname can never leak into a client-visible error body.
 */
export function upstreamHost(config: GuardrailConfig): string {
  try {
    return new URL(config.upstreamBaseUrl).host;
  } catch {
    return 'unknown';
  }
}

export async function openUpstream(
  config: GuardrailConfig,
  body: unknown,
  options: OpenUpstreamOptions = {}
): Promise<UpstreamResponse> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const streaming = typeof body === 'object' && body !== null && (body as { stream?: unknown }).stream === true;

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: streaming ? 'text/event-stream' : 'application/json'
  };
  if (config.upstreamApiKey !== undefined && config.upstreamApiKey !== '') {
    headers.authorization = `Bearer ${config.upstreamApiKey}`;
  }

  const response = await fetchImpl(upstreamUrl(config), {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    ...(options.signal !== undefined ? { signal: options.signal } : {})
  });

  return { status: response.status, headers: response.headers, body: response.body };
}
