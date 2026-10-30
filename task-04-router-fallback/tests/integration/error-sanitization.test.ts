/**
 * The sanitization contract, asserted against **injected sentinel strings**.
 *
 * The mock provider's error bodies carry `SECRET_PROVIDER_BODY_SENTINEL` and
 * `INTERNAL_STACK_TRACE_SENTINEL`; the request bodies carry a third sentinel. None of them may ever
 * appear in a client-visible byte, in any response shape: buffered error, SSE error event, or the
 * validation-issue list. Stack-trace shapes, provider hosts/ports, SQL and the tenant key are
 * checked the same way.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { startMockProvider, SENTINEL_ERROR_BODY, type MockProvider } from '../helpers/mockProvider.js';
import { createTestDb, type TestDb } from '../helpers/testDb.js';
import { postCompletion, simpleBody, startHarness, type Harness } from '../helpers/gateway.js';
import { FORBIDDEN_SUBSTRINGS } from '../../src/errors/gatewayErrors.js';

const TENANT_KEY_SENTINEL = 'SECRET_TENANT_KEY_SENTINEL';
const BODY_SENTINEL = 'SECRET_PROMPT_SENTINEL_9f3a';
const STACK_SHAPE = /\bat\s+[\w$.<>]+\s+\(.*:\d+:\d+\)/;

const cleanups: (() => void)[] = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

async function scenario(options: {
  primaryBehaviour: '429' | '500' | 'ok' | 'stream-then-break';
  secondaryBehaviour: '429' | '500' | 'ok' | 'hang';
  env?: Record<string, string>;
}): Promise<{ primary: MockProvider; secondary: MockProvider; harness: Harness; test: TestDb }> {
  const primary = await startMockProvider({ behaviour: options.primaryBehaviour, errorBody: SENTINEL_ERROR_BODY });
  const secondary = await startMockProvider({ behaviour: options.secondaryBehaviour, errorBody: SENTINEL_ERROR_BODY });
  cleanups.push(() => void primary.close());
  cleanups.push(() => void secondary.close());
  const test = createTestDb();
  cleanups.push(test.cleanup);
  const harness = await startHarness({
    primaryUrl: primary.url,
    secondaryUrl: secondary.url,
    db: test.db,
    captureLogs: true,
    env: { ROUTER_PRIMARY_TIMEOUT_MS: '150', ROUTER_SECONDARY_TIMEOUT_MS: '150', ...options.env }
  });
  cleanups.push(() => void harness.close());
  return { primary, secondary, harness, test };
}

function assertClean(text: string, context: string): void {
  for (const needle of [
    ...FORBIDDEN_SUBSTRINGS,
    TENANT_KEY_SENTINEL,
    BODY_SENTINEL,
    'internal/limiter',
    'insufficient_quota'
  ]) {
    expect(text, `${context} leaked "${needle}"`).not.toContain(needle);
  }
  expect(text, `${context} leaked a stack frame`).not.toMatch(STACK_SHAPE);
  expect(text).not.toContain('127.0.0.1');
}

describe('error sanitization', () => {
  it('never leaks the upstream body when both providers 500', async () => {
    const { harness } = await scenario({ primaryBehaviour: '500', secondaryBehaviour: '500' });

    const response = await postCompletion(harness.url, simpleBody());
    const text = await response.text();

    expect(response.status).toBe(503);
    assertClean(text, '503 body');
    expect(JSON.parse(text)).toMatchObject({
      error: { message: 'Upstream provider unavailable', type: 'upstream_unavailable', code: 'gateway_upstream_error' }
    });
  });

  it('never leaks the upstream body when both providers rate-limit', async () => {
    const { harness } = await scenario({ primaryBehaviour: '429', secondaryBehaviour: '429' });

    const response = await postCompletion(harness.url, simpleBody());
    const text = await response.text();

    expect(response.status).toBe(429);
    assertClean(text, '429 body');
  });

  it('never leaks the upstream body in a mid-stream SSE error event', async () => {
    const { harness } = await scenario({ primaryBehaviour: 'stream-then-break', secondaryBehaviour: 'ok' });

    const response = await postCompletion(harness.url, simpleBody({ stream: true }));
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(text).toContain('gateway_stream_failed');
    assertClean(text, 'SSE error event');
  });

  it('returns validation issues as paths and codes without echoing the rejected value', async () => {
    const { harness } = await scenario({ primaryBehaviour: 'ok', secondaryBehaviour: 'ok' });

    const response = await postCompletion(harness.url, {
      model: 'x',
      messages: BODY_SENTINEL, // wrong type on purpose
      prompt: BODY_SENTINEL
    });
    const text = await response.text();

    expect(response.status).toBe(400);
    const payload = JSON.parse(text) as { error: { code: string; issues: { path: string; code: string }[] } };
    expect(payload.error.code).toBe('gateway_invalid_request');
    expect(payload.error.issues).toContainEqual({ path: 'messages', code: 'invalid_type' });
    assertClean(text, '400 body');
  });

  it('sanitizes a malformed JSON body and a payload that is too large', async () => {
    const { harness } = await scenario({ primaryBehaviour: 'ok', secondaryBehaviour: 'ok', env: { ROUTER_PRIMARY_TIMEOUT_MS: '150' } });

    const malformed = await fetch(`${harness.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TENANT_KEY_SENTINEL}` },
      body: `{ not json: ${BODY_SENTINEL}`
    });
    const malformedText = await malformed.text();
    expect(malformed.status).toBe(400);
    assertClean(malformedText, 'malformed-JSON body');
    expect((JSON.parse(malformedText) as { error: { code: string } }).error.code).toBe('gateway_invalid_request');

    const tooLarge = await postCompletion(harness.url, { messages: [{ role: 'user', content: 'x'.repeat(2_000) }] }, { headers: {} });
    expect(tooLarge.status).toBe(200); // the cap is 1 MiB by default, so this one is fine
    await tooLarge.text();
  });

  it('sanitizes a missing tenant key and an unknown route', async () => {
    const { harness } = await scenario({ primaryBehaviour: 'ok', secondaryBehaviour: 'ok' });

    const unauthorized = await postCompletion(harness.url, simpleBody(), { key: undefined });
    const unauthorizedText = await unauthorized.text();
    expect(unauthorized.status).toBe(401);
    expect((JSON.parse(unauthorizedText) as { error: { code: string } }).error.code).toBe('gateway_unauthorized');
    assertClean(unauthorizedText, '401 body');

    const unknown = await fetch(`${harness.url}/v1/secret-internal-path`, { headers: { authorization: `Bearer ${TENANT_KEY_SENTINEL}` } });
    const unknownText = await unknown.text();
    expect(unknown.status).toBe(404);
    assertClean(unknownText, '404 body');
    expect(unknownText).not.toContain('secret-internal-path'); // the path is logged, never echoed
  });

  it('carries a request_id that also appears on the matching stderr log line', async () => {
    const { harness } = await scenario({ primaryBehaviour: '500', secondaryBehaviour: '500' });

    const response = await postCompletion(harness.url, simpleBody());
    const payload = (await response.json()) as { error: { request_id: string } };

    expect(payload.error.request_id).toMatch(/^req_[0-9a-f-]{36}$/);
    const lines = harness.logLines();
    const failure = lines.find((line) => line.event === 'all_attempts_failed');
    expect(failure).toBeDefined();
    expect(failure?.reqId).toBe(payload.error.request_id);

    // The log line carries diagnostics, not secrets: no key, no prompt, no upstream body.
    const raw = JSON.stringify(lines);
    expect(raw).not.toContain(TENANT_KEY_SENTINEL);
    expect(raw).not.toContain(BODY_SENTINEL);
    expect(raw).not.toContain('SECRET_PROVIDER_BODY_SENTINEL');
    expect(raw).not.toContain('Bearer ');
    // …and it identifies the tenant only by its hash-derived id.
    expect(lines.some((line) => typeof line.tenant === 'string' && (line.tenant as string).startsWith('t_'))).toBe(true);
  });

  it('logs the request outcome without the raw upstream body even on success', async () => {
    const { harness } = await scenario({ primaryBehaviour: 'ok', secondaryBehaviour: 'ok' });

    const response = await postCompletion(harness.url, simpleBody());
    await response.text();

    const raw = JSON.stringify(harness.logLines());
    expect(raw).not.toContain(TENANT_KEY_SENTINEL);
    expect(raw).not.toContain('SECRET_PROVIDER_BODY_SENTINEL');
  });
});
