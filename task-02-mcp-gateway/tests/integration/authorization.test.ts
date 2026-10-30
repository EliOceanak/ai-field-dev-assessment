import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startMockDownstream } from '../helpers/mockDownstream.js';
import type { MockDownstream } from '../helpers/mockDownstream.js';
import { postMcp, startTestGateway } from '../helpers/startGateway.js';
import type { TestGateway } from '../helpers/startGateway.js';
import { TEST_SECRET, mintToken } from '../helpers/tokens.js';

const adminToken = mintToken('admin');
const viewerToken = mintToken('viewer');
const auditorToken = mintToken('auditor');

function callBody(id: unknown, name: string, args: Record<string, unknown> = {}): string {
  return JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
}

describe('method-level authorization (admin_* requires the admin role)', () => {
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

  it('intercepts a viewer admin_reset_key call with -32001 and never touches the downstream', async () => {
    const response = await postMcp(gateway, callBody(7, 'admin_reset_key', { customer_id: 'CUST-00001' }), {
      token: viewerToken
    });

    expect(response.status).toBe(200);
    expect(response.json).toEqual({
      jsonrpc: '2.0',
      id: 7,
      error: {
        code: -32001,
        message: 'Unauthorized tool call',
        data: { tool: 'admin_reset_key', required_role: 'admin', reason: 'insufficient_role' }
      }
    });
    // The decisive assertion for this task: the downstream server saw nothing at all.
    expect(mock.calls.length).toBe(0);
    // A policy denial is not a transport failure: no challenge header on a 200.
    expect(response.headers.get('www-authenticate')).toBeNull();
  });

  it('intercepts a viewer admin_list_tenants call (no arguments) with zero downstream calls', async () => {
    const response = await postMcp(gateway, callBody(1, 'admin_list_tenants'), { token: viewerToken });

    expect(response.status).toBe(200);
    expect((response.json as { error: { code: number } }).error.code).toBe(-32001);
    expect(mock.calls.length).toBe(0);
  });

  it('echoes a string id exactly as received on a denial', async () => {
    const response = await postMcp(gateway, callBody('req-abc-1', 'admin_reset_key', { customer_id: 'CUST-1' }), {
      token: viewerToken
    });

    expect((response.json as { id: unknown }).id).toBe('req-abc-1');
    expect(mock.calls.length).toBe(0);
  });

  it('echoes id 0 on a denial (no falsy-id confusion)', async () => {
    const response = await postMcp(gateway, callBody(0, 'admin_reset_key', { customer_id: 'CUST-1' }), {
      token: viewerToken
    });

    expect((response.json as { id: unknown }).id).toBe(0);
    expect(mock.calls.length).toBe(0);
  });

  it('forwards an admin admin_reset_key call and executes it downstream', async () => {
    const response = await postMcp(gateway, callBody(9, 'admin_reset_key', { customer_id: 'CUST-00001' }), {
      token: adminToken
    });

    expect(response.status).toBe(200);
    const body = response.json as { result: { structuredContent: Record<string, unknown> } };
    expect(body.result.structuredContent).toMatchObject({ rotated: true, customer_id: 'CUST-00001' });
    expect(mock.calls.length).toBe(1);
    expect(mock.calls[0]?.tool).toBe('admin_reset_key');
  });

  it('treats an unknown role as least privilege (non-admin, but still a valid credential)', async () => {
    const denied = await postMcp(gateway, callBody(2, 'admin_reset_key', { customer_id: 'CUST-1' }), {
      token: auditorToken
    });
    expect((denied.json as { error: { code: number } }).error.code).toBe(-32001);
    expect(mock.calls.length).toBe(0);

    const allowed = await postMcp(gateway, callBody(3, 'get_customer_record', { customer_id: 'CUST-00001' }), {
      token: auditorToken
    });
    expect(allowed.status).toBe(200);
    expect(mock.calls.length).toBe(1);
  });

  it('denies an admin_-prefixed tool the downstream does not even have', async () => {
    const response = await postMcp(gateway, callBody(4, 'admin_does_not_exist'), { token: viewerToken });

    // Interception is by prefix, so the downstream never gets to answer -32601.
    expect((response.json as { error: { code: number } }).error.code).toBe(-32001);
    expect(mock.calls.length).toBe(0);
  });

  it('normalises surrounding whitespace before the prefix check', async () => {
    const response = await postMcp(gateway, callBody(5, '  admin_reset_key  ', { customer_id: 'CUST-1' }), {
      token: viewerToken
    });

    expect((response.json as { error: { code: number } }).error.code).toBe(-32001);
    expect(mock.calls.length).toBe(0);
  });

  it('drops a denied notification silently (202, no body, no downstream call)', async () => {
    const notification = JSON.stringify({
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: 'admin_reset_key', arguments: { customer_id: 'CUST-1' } }
    });
    const response = await postMcp(gateway, notification, { token: viewerToken });

    expect(response.status).toBe(202);
    expect(response.text).toBe('');
    expect(mock.calls.length).toBe(0);
  });

  it('allows a viewer to call a non-privileged tool', async () => {
    const response = await postMcp(
      gateway,
      callBody(11, 'trigger_refund', { customer_id: 'CUST-00001', amount: 10, reason: 'goodwill gesture' }),
      { token: viewerToken }
    );

    expect(response.status).toBe(200);
    expect((response.json as { result: unknown }).result).toBeDefined();
    expect(mock.calls.length).toBe(1);
    expect(mock.calls[0]?.tool).toBe('trigger_refund');
  });

  it('logs the decision without ever logging the credential', async () => {
    await postMcp(gateway, callBody(12, 'admin_reset_key', { customer_id: 'CUST-1' }), { token: viewerToken });

    const decisions = gateway.logsFor('policy_decision');
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      role: 'viewer',
      method: 'tools/call',
      tool: 'admin_reset_key',
      decision: 'deny',
      reason: 'insufficient_role'
    });
    expect(typeof decisions[0]?.tokenId).toBe('string');
    expect(gateway.logLines.join('')).not.toContain(viewerToken);
  });
});

describe('authorization fails closed on an unnameable tool call', () => {
  let mock: MockDownstream;
  let gateway: TestGateway;

  afterEach(async () => {
    await gateway.close();
    await mock.close();
  });

  it.each([
    ['no params at all', { jsonrpc: '2.0', id: 1, method: 'tools/call' }],
    ['a numeric name', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 42 } }],
    ['an object name', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: { tool: 'admin_reset_key' } } }],
    ['a null name', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: null } }]
  ])('rejects a tools/call with %s without contacting the downstream', async (_label, message) => {
    mock = await startMockDownstream();
    gateway = await startTestGateway({ config: { tokenSecret: TEST_SECRET, downstreamUrl: mock.url, devTokens: {} } });

    // An admin too: this is a malformed request, not a role question.
    const response = await postMcp(gateway, JSON.stringify(message), { token: adminToken });

    expect(response.status).toBe(200);
    expect(response.json).toMatchObject({
      id: 1,
      error: { code: -32602, message: 'Invalid params', data: { reason: 'unnameable_tool' } }
    });
    expect(mock.calls).toHaveLength(0);
  });

  it('still forwards a methods-only call transparently', async () => {
    mock = await startMockDownstream();
    gateway = await startTestGateway({ config: { tokenSecret: TEST_SECRET, downstreamUrl: mock.url, devTokens: {} } });

    const response = await postMcp(gateway, JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list' }), {
      token: viewerToken
    });

    expect(response.status).toBe(200);
    expect(mock.calls).toHaveLength(1);
  });
});

describe('authorization cannot be split across duplicate JSON keys', () => {
  let mock: MockDownstream;
  let gateway: TestGateway;

  afterEach(async () => {
    await gateway.close();
    await mock.close();
  });

  /**
   * `JSON.parse` keeps the *last* duplicate, so each payload looks harmless to the policy; a downstream
   * whose parser keeps the *first* one would run `admin_reset_key` from the same bytes. The gateway
   * forwards original text, so the only safe answer is to refuse the ambiguity outright.
   */
  it.each([
    [
      'a duplicate method',
      '{"jsonrpc":"2.0","id":1,"method":"tools/call","method":"tools/list","params":{"name":"admin_reset_key"}}'
    ],
    [
      'a duplicate tool name',
      '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"admin_reset_key","name":"get_customer_record"}}'
    ],
    [
      'a duplicate inside one batch element',
      '[{"jsonrpc":"2.0","id":1,"method":"tools/list"},' +
        '{"jsonrpc":"2.0","id":2,"method":"tools/call","method":"tools/list","params":{"name":"admin_reset_key"}}]'
    ]
  ])('refuses %s with -32600 and never contacts the downstream', async (_label, raw) => {
    mock = await startMockDownstream();
    gateway = await startTestGateway({ config: { tokenSecret: TEST_SECRET, downstreamUrl: mock.url, devTokens: {} } });

    const response = await postMcp(gateway, raw, { token: viewerToken });

    expect(response.status).toBe(400);
    expect(response.json).toMatchObject({
      id: null,
      error: { code: -32600, message: 'Invalid request', data: { reason: 'duplicate_key' } }
    });
    expect(mock.calls).toHaveLength(0);
  });
});
