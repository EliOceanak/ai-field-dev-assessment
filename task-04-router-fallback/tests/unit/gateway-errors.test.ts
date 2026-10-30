/**
 * The error envelope is the sanitization contract: a **closed catalogue** of messages plus the
 * request id. There is no API through which a caller can put an arbitrary string into a body, so
 * these tests are as much about the shape of the module as about the strings.
 */
import { describe, expect, it } from 'vitest';
import {
  GATEWAY_ERRORS,
  assertSanitized,
  classifyFailures,
  errorEnvelope,
  gatewayError,
  rateLimitHeaders,
  retryAfterSeconds,
  type GatewayErrorKind
} from '../../src/errors/gatewayErrors.js';

const KINDS = Object.keys(GATEWAY_ERRORS) as GatewayErrorKind[];

describe('gateway error envelope', () => {
  it('maps every kind to the documented status, type and code', () => {
    const table = KINDS.map((kind) => {
      const error = gatewayError(kind, { requestId: 'req_1' });
      return { kind, status: error.status, type: error.type, code: error.code };
    });

    expect(table).toEqual([
      { kind: 'rate_limited', status: 429, type: 'rate_limit_exceeded', code: 'gateway_rate_limited' },
      { kind: 'upstream_rate_limited', status: 429, type: 'rate_limit_exceeded', code: 'gateway_upstream_rate_limited' },
      { kind: 'upstream_timeout', status: 504, type: 'upstream_timeout', code: 'gateway_upstream_timeout' },
      { kind: 'upstream_unavailable', status: 503, type: 'upstream_unavailable', code: 'gateway_upstream_error' },
      { kind: 'stream_failed', status: 502, type: 'upstream_unavailable', code: 'gateway_stream_failed' },
      { kind: 'invalid_request', status: 400, type: 'invalid_request', code: 'gateway_invalid_request' },
      { kind: 'unauthorized', status: 401, type: 'invalid_request', code: 'gateway_unauthorized' },
      { kind: 'payload_too_large', status: 413, type: 'invalid_request', code: 'gateway_payload_too_large' },
      { kind: 'not_found', status: 404, type: 'invalid_request', code: 'gateway_not_found' },
      { kind: 'internal_error', status: 500, type: 'internal_error', code: 'gateway_internal_error' }
    ]);
  });

  it('serializes exactly the OpenAI-shaped envelope plus request_id', () => {
    const body = errorEnvelope(gatewayError('upstream_unavailable', { requestId: 'req_abc' }));
    expect(body).toEqual({
      error: {
        message: 'Upstream provider unavailable',
        type: 'upstream_unavailable',
        code: 'gateway_upstream_error',
        request_id: 'req_abc'
      }
    });
    expect(Object.keys(body)).toEqual(['error']);
    expect(Object.keys(body.error).sort()).toEqual(['code', 'message', 'request_id', 'type']);
  });

  it('carries validation issues as paths and codes, never as values', () => {
    const error = gatewayError('invalid_request', {
      requestId: 'req_1',
      issues: [{ path: 'messages.0.role', code: 'invalid_type' }]
    });
    const body = errorEnvelope(error);
    expect(body.error.issues).toEqual([{ path: 'messages.0.role', code: 'invalid_type' }]);
    expect(JSON.stringify(body)).not.toContain('SECRET');
  });

  it('omits optional fields when they are not relevant', () => {
    expect(errorEnvelope(gatewayError('not_found', { requestId: 'req_1' }))).toEqual({
      error: { message: 'Unknown route', type: 'invalid_request', code: 'gateway_not_found', request_id: 'req_1' }
    });
  });

  it('keeps every catalogue message free of upstream or internal artefacts', () => {
    for (const kind of KINDS) {
      const error = gatewayError(kind, { requestId: 'req_1' });
      expect(() => assertSanitized(errorEnvelope(error))).not.toThrow();
      expect(error.message).not.toMatch(/http|localhost|127\.0\.0\.1|stack|SQLITE|\.ts:/i);
    }
  });

  it('detects a leak when one is injected (the guard is not vacuous)', () => {
    expect(() => assertSanitized({ error: { message: 'INTERNAL_STACK_TRACE_SENTINEL' } })).toThrow(/leaked a forbidden substring/);
    expect(() => assertSanitized({ error: { message: 'SECRET_PROVIDER_BODY_SENTINEL' } })).toThrow(/leaked/);
    expect(() => assertSanitized({ error: { message: 'at Object.<anonymous> (/app/node_modules/x.js:1)' } })).toThrow(/leaked/);
  });

  it('rounds Retry-After up to at least one second', () => {
    expect(retryAfterSeconds(0)).toBe(1);
    expect(retryAfterSeconds(1)).toBe(1);
    expect(retryAfterSeconds(1_001)).toBe(2);
    expect(retryAfterSeconds(59_999)).toBe(60);
    expect(retryAfterSeconds(60_000)).toBe(60);
  });

  it('renders the three rate-limit headers with epoch seconds for the reset', () => {
    expect(rateLimitHeaders({ limit: 50_000, remaining: 12_345, resetAtMs: 1_700_000_060_000 })).toEqual({
      'X-RateLimit-Limit-Tokens': '50000',
      'X-RateLimit-Remaining-Tokens': '12345',
      'X-RateLimit-Reset': '1700000060'
    });
    expect(rateLimitHeaders({ limit: 10, remaining: -5, resetAtMs: 0 })['X-RateLimit-Remaining-Tokens']).toBe('0');
  });
});

describe('classifyFailures', () => {
  it('maps all-timeouts to 504 and all-rate-limits to an upstream 429', () => {
    expect(classifyFailures(['timeout'])).toBe('upstream_timeout');
    expect(classifyFailures(['timeout', 'timeout'])).toBe('upstream_timeout');
    expect(classifyFailures(['rate_limited', 'rate_limited'])).toBe('upstream_rate_limited');
  });

  it('maps a mixed or infrastructure failure to 503', () => {
    expect(classifyFailures(['http'])).toBe('upstream_unavailable');
    expect(classifyFailures(['network'])).toBe('upstream_unavailable');
    expect(classifyFailures(['timeout', 'network'])).toBe('upstream_unavailable');
    expect(classifyFailures(['rate_limited', 'timeout'])).toBe('upstream_unavailable');
  });

  it('treats a lone 4xx that was deliberately not retried as the client\'s mistake', () => {
    expect(classifyFailures(['http'], [400])).toBe('invalid_request');
    expect(classifyFailures(['http'], [404])).toBe('invalid_request');
    expect(classifyFailures(['http'], [500])).toBe('upstream_unavailable');
    expect(classifyFailures(['http'], [429])).toBe('upstream_rate_limited');
    expect(classifyFailures(['http', 'http'], [400, 500])).toBe('upstream_unavailable');
  });

  it('treats "no attempts at all" as an internal error rather than a client error', () => {
    expect(classifyFailures([])).toBe('internal_error');
  });
});
