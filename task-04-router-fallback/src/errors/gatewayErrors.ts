/**
 * The sanitized gateway error envelope.
 *
 * ```
 * { "error": { "message": "Upstream provider unavailable",
 *              "type": "upstream_unavailable",
 *              "code": "gateway_upstream_error",
 *              "request_id": "req_01H…" } }
 * ```
 *
 * **Design choice worth reading:** the obvious API shape is `gatewayError({ type, code, message, … })`,
 * i.e. a caller-supplied message. This module deliberately refuses that — every field comes from a
 * **closed catalogue** and the caller only passes a *kind* plus the request id. That makes it structurally
 * impossible for an upstream body, a provider hostname, a stack trace, a SQL statement or a tenant
 * key to reach a client, instead of relying on every call site remembering to sanitize.
 * `tests/integration/error-sanitization.test.ts` proves it with injected sentinel strings, and
 * `assertSanitized()` is a belt-and-braces guard used by the tests.
 */

export type GatewayErrorKind =
  | 'rate_limited'
  | 'upstream_rate_limited'
  | 'upstream_timeout'
  | 'upstream_unavailable'
  | 'stream_failed'
  | 'invalid_request'
  | 'unauthorized'
  | 'payload_too_large'
  | 'not_found'
  | 'internal_error';

export interface GatewayErrorTemplate {
  status: number;
  type: string;
  code: string;
  message: string;
}

/** The only strings a client will ever see in an error body. */
export const GATEWAY_ERRORS: Record<GatewayErrorKind, GatewayErrorTemplate> = {
  rate_limited: {
    status: 429,
    type: 'rate_limit_exceeded',
    code: 'gateway_rate_limited',
    message: 'Rate limit exceeded for this tenant key'
  },
  upstream_rate_limited: {
    status: 429,
    type: 'rate_limit_exceeded',
    code: 'gateway_upstream_rate_limited',
    message: 'Upstream provider rate limit exceeded'
  },
  upstream_timeout: {
    status: 504,
    type: 'upstream_timeout',
    code: 'gateway_upstream_timeout',
    message: 'Upstream provider timed out'
  },
  upstream_unavailable: {
    status: 503,
    type: 'upstream_unavailable',
    code: 'gateway_upstream_error',
    message: 'Upstream provider unavailable'
  },
  stream_failed: {
    status: 502,
    type: 'upstream_unavailable',
    code: 'gateway_stream_failed',
    message: 'Upstream stream failed'
  },
  invalid_request: {
    status: 400,
    type: 'invalid_request',
    code: 'gateway_invalid_request',
    message: 'Invalid completion request'
  },
  unauthorized: {
    status: 401,
    type: 'invalid_request',
    code: 'gateway_unauthorized',
    message: 'Missing or invalid tenant API key'
  },
  payload_too_large: {
    status: 413,
    type: 'invalid_request',
    code: 'gateway_payload_too_large',
    message: 'Request body too large'
  },
  not_found: {
    status: 404,
    type: 'invalid_request',
    code: 'gateway_not_found',
    message: 'Unknown route'
  },
  internal_error: {
    status: 500,
    type: 'internal_error',
    code: 'gateway_internal_error',
    message: 'Internal gateway error'
  }
};

export interface FieldIssue {
  /** Dotted path inside the request body, e.g. `messages.0.role`. Never a value. */
  path: string;
  /** Stable Zod issue code, e.g. `invalid_type`. Never a value. */
  code: string;
}

export interface GatewayError {
  kind: GatewayErrorKind;
  status: number;
  type: string;
  code: string;
  message: string;
  requestId: string;
  retryAfterMs?: number;
  /** Validation detail — field paths and issue codes only (no received values). */
  issues?: FieldIssue[];
  /** Extra response headers (rate-limit headers on a 429). */
  headers?: Record<string, string>;
}

export interface GatewayErrorOptions {
  requestId: string;
  retryAfterMs?: number;
  issues?: FieldIssue[];
  headers?: Record<string, string>;
}

export function gatewayError(kind: GatewayErrorKind, options: GatewayErrorOptions): GatewayError {
  const template = GATEWAY_ERRORS[kind];
  const error: GatewayError = {
    kind,
    status: template.status,
    type: template.type,
    code: template.code,
    message: template.message,
    requestId: options.requestId
  };
  if (options.retryAfterMs !== undefined) error.retryAfterMs = options.retryAfterMs;
  if (options.issues !== undefined && options.issues.length > 0) error.issues = options.issues;
  if (options.headers !== undefined) error.headers = options.headers;
  return error;
}

/** The wire shape. `request_id` is the join key to the stderr log line for the same request. */
export function errorEnvelope(error: GatewayError): {
  error: { message: string; type: string; code: string; request_id: string; issues?: FieldIssue[] };
} {
  return {
    error: {
      message: error.message,
      type: error.type,
      code: error.code,
      request_id: error.requestId,
      ...(error.issues !== undefined ? { issues: error.issues } : {})
    }
  };
}

/** `Retry-After` is whole seconds and never `0` (a 0 would invite an immediate retry storm). */
export function retryAfterSeconds(retryAfterMs: number): number {
  return Math.max(1, Math.ceil(retryAfterMs / 1000));
}

export interface RateLimitHeadersInput {
  limit: number;
  remaining: number;
  resetAtMs: number;
}

/** `X-RateLimit-Reset` is epoch **seconds**, the de-facto convention. */
export function rateLimitHeaders(input: RateLimitHeadersInput): Record<string, string> {
  return {
    'X-RateLimit-Limit-Tokens': String(input.limit),
    'X-RateLimit-Remaining-Tokens': String(Math.max(0, input.remaining)),
    'X-RateLimit-Reset': String(Math.ceil(input.resetAtMs / 1000))
  };
}

/** What one attempt did, reduced to the vocabulary the classifier understands. */
export type AttemptFailure = 'timeout' | 'http' | 'network' | 'rate_limited';

/**
 * Maps "what did every attempt do?" to one envelope, so the status the client sees is derived from
 * the dominant failure rather than from whichever attempt happened to be last.
 *
 * all timeouts → 504 · all rate-limited → 429 · anything else → 503.
 */
export function classifyFailures(failures: readonly AttemptFailure[], httpStatuses: readonly number[] = []): GatewayErrorKind {
  if (failures.length === 0) return 'internal_error';
  if (failures.every((failure) => failure === 'timeout')) return 'upstream_timeout';
  if (failures.every((failure) => failure === 'rate_limited')) return 'upstream_rate_limited';
  // A single 4xx that the failover policy deliberately did not retry is either an upstream throttle
  // (429) or the *client's* mistake; both are more useful than a generic 503.
  const only = httpStatuses.length === 1 ? httpStatuses[0] : undefined;
  if (failures.length === 1 && failures[0] === 'http' && only !== undefined) {
    if (only === 429) return 'upstream_rate_limited';
    if (only >= 400 && only < 500) return 'invalid_request';
  }
  return 'upstream_unavailable';
}

/**
 * Guard used by tests (and available for a boot-time self-check): throws if a client-visible string
 * carries an upstream/internal artifact. Kept intentionally dumb — substrings we never emit.
 */
export const FORBIDDEN_SUBSTRINGS = [
  'SQLITE',
  'sqlite3',
  'at Object.',
  'at async ',
  'node_modules',
  'Bearer ',
  'INTERNAL_STACK_TRACE_SENTINEL',
  'SECRET_PROVIDER_BODY_SENTINEL',
  'SECRET_TENANT_KEY_SENTINEL',
  'stack trace',
  'Stack trace'
] as const;

export function assertSanitized(value: unknown, forbidden: readonly string[] = FORBIDDEN_SUBSTRINGS): void {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const needle of forbidden) {
    if (text.includes(needle)) throw new Error(`gateway error envelope leaked a forbidden substring: "${needle}"`);
  }
}
