import { afterEach, describe, expect, it } from 'vitest';
import { startMockDownstream } from '../helpers/mockDownstream.js';
import type { MockDownstream } from '../helpers/mockDownstream.js';
import { postMcp, startTestGateway } from '../helpers/startGateway.js';
import type { TestGateway } from '../helpers/startGateway.js';
import { TEST_SECRET, expiredToken, mintToken, tamperPayload } from '../helpers/tokens.js';
import { WWW_AUTHENTICATE } from '../../src/middleware/auth.js';

const viewerToken = mintToken('viewer');
const TOOLS_LIST = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });

describe('error handling and the HTTP status contract', () => {
  let mock: MockDownstream | undefined;
  let gateway: TestGateway | undefined;

  async function boot(config: Record<string, unknown> = {}): Promise<TestGateway> {
    mock = await startMockDownstream();
    gateway = await startTestGateway({
      config: { tokenSecret: TEST_SECRET, downstreamUrl: mock.url, devTokens: {}, ...config }
    });
    return gateway;
  }

  afterEach(async () => {
    await gateway?.close();
    await mock?.close();
    gateway = undefined;
    mock = undefined;
  });

  // `clientReason` is what the caller is told; `auditReason` is what the log records. Anything about
  // the credential itself collapses to `invalid_token`, so the response cannot be used as an oracle
  // for "unparseable" vs "forged" vs "expired".
  it.each([
    ['no Authorization header', {}, 'missing_header', 'missing_header'],
    ['a non-Bearer scheme', { authorization: 'Basic dXNlcjpwYXNz' }, 'malformed_header', 'malformed_header'],
    ['an empty Bearer credential', { authorization: 'Bearer ' }, 'malformed_header', 'malformed_header'],
    ['an unknown token', { authorization: 'Bearer not-a-real-token' }, 'invalid_token', 'malformed_token'],
    ['a tampered token', { authorization: `Bearer ${tamperPayload(viewerToken)}` }, 'invalid_token', 'invalid_signature'],
    ['an expired token', { authorization: `Bearer ${expiredToken('viewer')}` }, 'invalid_token', 'expired'],
    [
      'a token signed with the wrong secret',
      { authorization: `Bearer ${mintToken('viewer', { secret: 'other' })}` },
      'invalid_token',
      'invalid_signature'
    ]
  ])('answers 401 with a challenge for %s', async (_label, headers, clientReason, auditReason) => {
    const started = await boot();
    const response = await postMcp(started, TOOLS_LIST, { headers });

    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe(WWW_AUTHENTICATE);
    expect(response.json).toEqual({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32600, message: 'Invalid request', data: { reason: clientReason } }
    });
    // The precise reason survives where it belongs: the audit log.
    expect(started.logsFor('auth_failure')[0]).toMatchObject({ reason: auditReason });
    // No upstream request is made for an unauthenticated caller.
    expect(mock?.calls.length).toBe(0);
    // The rejected credential never appears anywhere in the response.
    expect(response.text).not.toContain('Bearer not-a-real-token');
  });

  it('authenticates before parsing the body (401 wins over 400)', async () => {
    const started = await boot();
    const response = await postMcp(started, '{"jsonrpc": "2.0",');

    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe(WWW_AUTHENTICATE);
    expect(gateway?.logsFor('http_request')).toHaveLength(0);
  });

  it('answers 400 with -32700 for a malformed JSON body', async () => {
    const started = await boot();
    const response = await postMcp(started, '{"jsonrpc": "2.0",', { token: viewerToken });

    expect(response.status).toBe(400);
    expect(response.headers.get('www-authenticate')).toBeNull();
    expect(response.json).toEqual({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32700, message: 'Parse error' }
    });
    expect(mock?.calls.length).toBe(0);
  });

  it('answers 400 with -32600 for valid JSON that is not a JSON-RPC envelope', async () => {
    const started = await boot();
    const response = await postMcp(started, '{"hello":"world"}', { token: viewerToken });

    expect(response.status).toBe(400);
    expect(response.json).toEqual({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32600, message: 'Invalid request' }
    });
    expect(mock?.calls.length).toBe(0);
  });

  it('answers 400 with -32600 for an empty body', async () => {
    const started = await boot();
    const response = await postMcp(started, '', { token: viewerToken });

    expect(response.status).toBe(400);
    expect((response.json as { error: { code: number } }).error.code).toBe(-32700);
  });

  it('answers 413 for a body over the configured limit', async () => {
    const started = await boot({ maxBodyBytes: 128 });
    const response = await postMcp(started, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', pad: 'x'.repeat(400) }), {
      token: viewerToken
    });

    expect(response.status).toBe(413);
    expect(response.json).toMatchObject({
      error: { code: -32600, data: { reason: 'body_too_large', limit: 128 } }
    });
    expect(mock?.calls.length).toBe(0);
  });
});

describe('upstream failures', () => {
  let gateway: TestGateway | undefined;

  afterEach(async () => {
    await gateway?.close();
    gateway = undefined;
  });

  it('answers 502 with a sanitized -32603 when the downstream is unreachable', async () => {
    const mock = await startMockDownstream();
    const deadUrl = mock.url;
    await mock.close();

    gateway = await startTestGateway({
      config: { tokenSecret: TEST_SECRET, downstreamUrl: deadUrl, devTokens: {} }
    });
    const response = await postMcp(gateway, TOOLS_LIST, { token: viewerToken });

    expect(response.status).toBe(502);
    expect(response.json).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32603, message: 'Bad gateway' }
    });
    // No upstream hostname, port, URL, stack trace or error text leaks out.
    expect(response.text).not.toContain('http://');
    expect(response.text).not.toContain(String(new URL(deadUrl).port));
    expect(response.text).not.toContain('ECONNREFUSED');
    expect((response.json as { error: { data: { reqId: string } } }).error.data.reqId).toBe(
      response.headers.get('x-gateway-req-id')
    );
    expect(gateway.logsFor('gateway_error')[0]).toMatchObject({ status: 502, reason: 'unreachable' });
  });

  it('answers 504 with a sanitized -32603 when the downstream times out', async () => {
    const mock = await startMockDownstream();
    gateway = await startTestGateway({
      config: { tokenSecret: TEST_SECRET, downstreamUrl: mock.url, devTokens: {}, upstreamTimeoutMs: 50 }
    });

    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'mock/slow', params: { delayMs: 600 } });
    const response = await postMcp(gateway, body, { token: viewerToken });

    expect(response.status).toBe(504);
    expect(response.json).toMatchObject({ id: 1, error: { code: -32603, message: 'Gateway timeout' } });
    expect(response.text).not.toContain('http://');
    expect(response.text).not.toContain('aborted');
    expect(gateway.logsFor('gateway_error')[0]).toMatchObject({ status: 504, reason: 'timeout' });

    await mock.close();
  });

  it('still answers 504 for a denied-then-timed-out batch (no upstream call for the denied element)', async () => {
    const mock = await startMockDownstream();
    gateway = await startTestGateway({
      config: { tokenSecret: TEST_SECRET, downstreamUrl: mock.url, devTokens: {}, upstreamTimeoutMs: 50 }
    });

    const body = JSON.stringify([
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'admin_reset_key' } },
      { jsonrpc: '2.0', id: 2, method: 'mock/slow', params: { delayMs: 600 } }
    ]);
    const response = await postMcp(gateway, body, { token: viewerToken });

    expect(response.status).toBe(504);
    expect(mock.calls.some((call) => call.tool === 'admin_reset_key')).toBe(false);

    await mock.close();
  });
});

describe('routing and health', () => {
  let mock: MockDownstream | undefined;
  let gateway: TestGateway | undefined;

  afterEach(async () => {
    await gateway?.close();
    await mock?.close();
    gateway = undefined;
    mock = undefined;
  });

  it('serves a health probe', async () => {
    mock = await startMockDownstream();
    gateway = await startTestGateway({
      config: { tokenSecret: TEST_SECRET, downstreamUrl: mock.url, devTokens: {} }
    });

    const response = await fetch(gateway.url.replace('/mcp', '/health'));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: 'ok', service: 'mcp-gateway' });
  });

  it('rejects a GET on the MCP endpoint with 405 and an Allow header', async () => {
    mock = await startMockDownstream();
    gateway = await startTestGateway({
      config: { tokenSecret: TEST_SECRET, downstreamUrl: mock.url, devTokens: {} }
    });

    const response = await fetch(gateway.url, { headers: { authorization: `Bearer ${viewerToken}` } });

    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('POST');
    expect(mock.calls.length).toBe(0);
  });

  it('answers 404 for an unknown path', async () => {
    mock = await startMockDownstream();
    gateway = await startTestGateway({
      config: { tokenSecret: TEST_SECRET, downstreamUrl: mock.url, devTokens: {} }
    });

    const response = await fetch(gateway.url.replace('/mcp', '/nope'));
    expect(response.status).toBe(404);
  });
});


describe('shipped-by-default credentials announce themselves', () => {
  let mock: MockDownstream;
  let gateway: TestGateway;

  afterEach(async () => {
    await gateway?.close();
    await mock?.close();
  });

  it('warns at boot and flags /health when the default secret and dev tokens are live', async () => {
    mock = await startMockDownstream();
    gateway = await startTestGateway({ config: { downstreamUrl: mock.url } }); // defaults kept on purpose

    const warning = gateway.logsFor('insecure_defaults_active')[0];
    expect(warning).toBeDefined();
    expect(warning?.defaults).toEqual(['tokenSecret', 'devTokens.admin', 'devTokens.viewer']);

    const health = (await (await fetch(gateway.url.replace('/mcp', '/health'))).json()) as Record<string, unknown>;
    expect(health.insecureDefaults).toBe(true);
  });

  it('stays quiet when both are configured', async () => {
    mock = await startMockDownstream();
    gateway = await startTestGateway({
      config: {
        downstreamUrl: mock.url,
        tokenSecret: 'a-real-secret-value',
        devTokens: { admin: 'real-admin-token', viewer: 'real-viewer-token' }
      }
    });

    expect(gateway.logsFor('insecure_defaults_active')).toHaveLength(0);
    const health = (await (await fetch(gateway.url.replace('/mcp', '/health'))).json()) as Record<string, unknown>;
    expect(health.insecureDefaults).toBe(false);
  });
});
