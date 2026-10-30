import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startMockDownstream } from '../helpers/mockDownstream.js';
import type { MockDownstream } from '../helpers/mockDownstream.js';
import { postMcp, startTestGateway } from '../helpers/startGateway.js';
import type { TestGateway } from '../helpers/startGateway.js';
import { TEST_SECRET, mintToken } from '../helpers/tokens.js';
import { buildForwardHeaders, filterResponseHeaders } from '../../src/proxy/forwarder.js';

const TOOLS_LIST = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
const REFUND = JSON.stringify({
  jsonrpc: '2.0',
  id: 'refund-1',
  method: 'tools/call',
  params: { name: 'trigger_refund', arguments: { customer_id: 'CUST-00001', amount: 10, reason: 'goodwill gesture' } }
});
const ECHO = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'mock/echo', params: {} });

const adminToken = mintToken('admin');
const viewerToken = mintToken('viewer');

/** The downstream's answer, fetched directly — the byte-for-byte reference. */
async function directToDownstream(mock: MockDownstream, body: string): Promise<string> {
  const response = await fetch(mock.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  return response.text();
}

function echoedHeaders(response: { json: unknown }): Record<string, string> {
  return (response.json as { result: { headers: Record<string, string> } }).result.headers;
}

describe('transparent forwarding', () => {
  let mock: MockDownstream;
  let gateway: TestGateway;

  beforeEach(async () => {
    mock = await startMockDownstream();
    gateway = await startTestGateway({
      config: { tokenSecret: TEST_SECRET, downstreamUrl: mock.url, devTokens: {} }
    });
  });

  afterEach(async () => {
    await gateway.close();
    await mock.close();
  });

  it.each([
    ['viewer', () => viewerToken],
    ['admin', () => adminToken]
  ])('returns tools/list byte-identically for %s', async (_role, token) => {
    const response = await postMcp(gateway, TOOLS_LIST, { token: token() });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(response.text).toBe(await directToDownstream(mock, TOOLS_LIST));
    // The body really is the whole catalogue, admin_* tools included.
    const tools = (response.json as { result: { tools: { name: string }[] } }).result.tools.map((tool) => tool.name);
    expect(tools).toEqual(['get_customer_record', 'trigger_refund', 'admin_reset_key', 'admin_list_tenants']);
  });

  it('forwards the request body byte-identically (the raw text is reused)', async () => {
    await postMcp(gateway, TOOLS_LIST, { token: viewerToken });

    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]?.rawBody).toBe(TOOLS_LIST);
  });

  it('returns an allowed tools/call byte-identically, with the string id preserved', async () => {
    const response = await postMcp(gateway, REFUND, { token: viewerToken });

    expect(response.status).toBe(200);
    expect(response.text).toBe(await directToDownstream(mock, REFUND));
    expect((response.json as { id: unknown }).id).toBe('refund-1');
    expect(mock.calls[0]?.rawBody).toBe(REFUND);
  });

  it('passes an unknown method through so the downstream answers -32601 itself', async () => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'resources/list', params: {} });
    const response = await postMcp(gateway, body, { token: viewerToken });

    expect(response.status).toBe(200);
    expect(response.json).toMatchObject({ id: 5, error: { code: -32601, message: 'Method not found' } });
    expect(mock.calls[0]?.method).toBe('resources/list');
  });

  it('forwards a notification and answers 202 with no body', async () => {
    const notification = JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' });
    const response = await postMcp(gateway, notification, { token: viewerToken });

    expect(response.status).toBe(202);
    expect(response.text).toBe('');
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]).toMatchObject({ method: 'notifications/initialized', notification: true });
  });

  it('strips the caller credential downstream and never relays hop-by-hop headers', async () => {
    const response = await postMcp(gateway, ECHO, {
      token: viewerToken,
      headers: { 'x-custom-header': 'kept', 'mcp-protocol-version': '2025-11-25' }
    });

    const headers = echoedHeaders(response);
    expect(headers.authorization).toBeUndefined();
    expect(headers.host).toBe(`127.0.0.1:${mock.port}`);
    expect(headers['content-type']).toBe('application/json');
    expect(headers['accept-encoding']).toBe('identity');
    expect(headers['x-custom-header']).toBe('kept');
    expect(headers['mcp-protocol-version']).toBe('2025-11-25');
  });

  it('forwards a gzip request body decoded, without the Content-Encoding that no longer applies', async () => {
    const response = await fetch(gateway.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-encoding': 'gzip',
        authorization: `Bearer ${viewerToken}`
      },
      body: gzipSync(ECHO)
    });
    const { result } = (await response.json()) as { result: { headers: Record<string, string>; rawBody: string } };

    expect(response.status).toBe(200);
    expect(result.headers['content-encoding']).toBeUndefined();
    expect(result.rawBody).toBe(ECHO);
  });

  it('relays the caller credential only when explicitly configured to', async () => {
    await gateway.close();
    gateway = await startTestGateway({
      config: { tokenSecret: TEST_SECRET, downstreamUrl: mock.url, devTokens: {}, forwardClientAuth: true }
    });
    const response = await postMcp(gateway, ECHO, { token: viewerToken });

    expect(echoedHeaders(response).authorization).toBe(`Bearer ${viewerToken}`);
  });

  it('injects the service credential downstream when configured', async () => {
    await gateway.close();
    gateway = await startTestGateway({
      config: {
        tokenSecret: TEST_SECRET,
        downstreamUrl: mock.url,
        devTokens: {},
        downstreamToken: 'service-token'
      }
    });
    const response = await postMcp(gateway, ECHO, { token: viewerToken });

    expect(echoedHeaders(response).authorization).toBe('Bearer service-token');
  });

  it('adds a correlation id and no authentication challenge on success', async () => {
    const response = await postMcp(gateway, TOOLS_LIST, { token: viewerToken });

    expect(response.headers.get('x-gateway-req-id')).toMatch(/^[0-9a-f-]{36}$/);
    expect(response.headers.get('www-authenticate')).toBeNull();
  });

  it('honours an inbound x-request-id so logs correlate across the gateway', async () => {
    await postMcp(gateway, TOOLS_LIST, { token: viewerToken, headers: { 'x-request-id': 'trace-me-123' } });

    expect(gateway.logsFor('proxy_request')[0]?.reqId).toBe('trace-me-123');
    expect(gateway.logsFor('http_request')[0]?.reqId).toBe('trace-me-123');
  });

  it('logs one proxy_request line with the upstream status and byte count', async () => {
    const response = await postMcp(gateway, TOOLS_LIST, { token: viewerToken });
    const [line] = gateway.logsFor('proxy_request');

    expect(line).toMatchObject({ upstreamStatus: 200, streaming: false });
    expect(line?.bytesOut).toBe(Buffer.byteLength(response.text));
    expect(typeof line?.durationMs).toBe('number');
  });

  it('is transparent by default even for admin tools (hardened filter off)', async () => {
    const response = await postMcp(gateway, TOOLS_LIST, { token: viewerToken });

    expect(response.text).toBe(await directToDownstream(mock, TOOLS_LIST));
    expect(gateway.logsFor('tool_list_filtered')).toHaveLength(0);
  });

  it('strips privileged tools in hardened mode for a viewer but not for an admin', async () => {
    await gateway.close();
    gateway = await startTestGateway({
      config: { tokenSecret: TEST_SECRET, downstreamUrl: mock.url, devTokens: {}, filterToolList: true }
    });

    const viewer = await postMcp(gateway, TOOLS_LIST, { token: viewerToken });
    const viewerTools = (viewer.json as { result: { tools: { name: string }[] } }).result.tools.map((tool) => tool.name);
    expect(viewerTools).toEqual(['get_customer_record', 'trigger_refund']);
    expect(gateway.logsFor('tool_list_filtered')[0]).toMatchObject({
      removed: ['admin_reset_key', 'admin_list_tenants']
    });

    const admin = await postMcp(gateway, TOOLS_LIST, { token: adminToken });
    const adminTools = (admin.json as { result: { tools: { name: string }[] } }).result.tools.map((tool) => tool.name);
    expect(adminTools).toHaveLength(4);
  });
});

describe('header hygiene (pure)', () => {
  const clientHeaders = {
    host: 'gateway.local:8787',
    connection: 'keep-alive',
    'keep-alive': 'timeout=5',
    'transfer-encoding': 'chunked',
    te: 'trailers',
    upgrade: 'h2c',
    'proxy-authorization': 'Basic c2VjcmV0',
    'proxy-connection': 'keep-alive',
    'content-length': '123',
    'content-encoding': 'gzip',
    cookie: 'session=abc',
    'set-cookie': 'x=1',
    authorization: 'Bearer caller-credential',
    'accept-encoding': 'gzip, deflate, br',
    accept: 'application/json',
    'content-type': 'application/json',
    'mcp-session-id': 'sess-1'
  };

  it('drops hop-by-hop, framing, cookie and credential headers by default', () => {
    expect(buildForwardHeaders(clientHeaders)).toEqual({
      accept: 'application/json',
      'content-type': 'application/json',
      'mcp-session-id': 'sess-1',
      // Forced to identity so the proxied body stays byte-comparable.
      'accept-encoding': 'identity'
    });
  });

  it('relays the caller credential only when asked', () => {
    expect(buildForwardHeaders(clientHeaders, { forwardClientAuth: true }).authorization).toBe(
      'Bearer caller-credential'
    );
    expect(buildForwardHeaders(clientHeaders).authorization).toBeUndefined();
  });

  it('injects the service credential, replacing the caller one', () => {
    const headers = buildForwardHeaders(clientHeaders, { forwardClientAuth: true, downstreamToken: 'svc' });
    expect(headers.authorization).toBe('Bearer svc');
  });

  it('mirrors the request content type and joins repeated header values', () => {
    const headers = buildForwardHeaders({ 'x-multi': ['a', 'b'] }, { contentType: 'application/json' });
    expect(headers['x-multi']).toBe('a, b');
    expect(headers['content-type']).toBe('application/json');
  });

  it('drops body-framing headers from the response', () => {
    const upstream = new Headers({
      'content-type': 'application/json',
      'content-length': '42',
      'content-encoding': 'gzip',
      connection: 'keep-alive',
      'transfer-encoding': 'chunked',
      'mcp-session-id': 'sess-1',
      'retry-after': '3'
    });

    expect(filterResponseHeaders(upstream)).toEqual({
      'content-type': 'application/json',
      'mcp-session-id': 'sess-1',
      'retry-after': '3'
    });
  });
});
