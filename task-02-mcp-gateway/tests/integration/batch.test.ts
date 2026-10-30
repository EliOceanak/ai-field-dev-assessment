import { afterEach, describe, expect, it } from 'vitest';
import { startMockDownstream } from '../helpers/mockDownstream.js';
import type { MockDownstream } from '../helpers/mockDownstream.js';
import { postMcp, startTestGateway } from '../helpers/startGateway.js';
import type { TestGateway } from '../helpers/startGateway.js';
import { TEST_SECRET, mintToken } from '../helpers/tokens.js';

const adminToken = mintToken('admin');
const viewerToken = mintToken('viewer');

const MIXED = JSON.stringify([
  { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
  {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'admin_reset_key', arguments: { customer_id: 'CUST-1' } }
  },
  {
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'get_customer_record', arguments: { customer_id: 'CUST-00001' } }
  }
]);

interface Item {
  id: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: { tool?: string } };
}

describe('batch handling', () => {
  let mock: MockDownstream;
  let gateway: TestGateway;

  async function boot(shuffleBatchResponses = false): Promise<void> {
    mock = await startMockDownstream({ shuffleBatchResponses });
    gateway = await startTestGateway({
      config: { tokenSecret: TEST_SECRET, downstreamUrl: mock.url, devTokens: {} }
    });
  }

  afterEach(async () => {
    await gateway.close();
    await mock.close();
  });

  it('merges per-element denials with upstream results, preserving order', async () => {
    await boot();
    const response = await postMcp(gateway, MIXED, { token: viewerToken });

    expect(response.status).toBe(200);
    const items = response.json as Item[];
    expect(items.map((item) => item.id)).toEqual([1, 2, 3]);
    expect(items[0]?.result).toBeDefined();
    expect(items[1]?.error).toMatchObject({
      code: -32001,
      message: 'Unauthorized tool call',
      data: { tool: 'admin_reset_key', required_role: 'admin', reason: 'insufficient_role' }
    });
    expect(items[2]?.result).toBeDefined();

    // One upstream request, carrying only the two allowed elements.
    const forwarded = JSON.parse(mock.calls[0]?.rawBody ?? '[]') as { id: number }[];
    expect(forwarded.map((message) => message.id)).toEqual([1, 3]);
    expect(mock.calls.some((call) => call.tool === 'admin_reset_key')).toBe(false);
  });

  it('matches upstream results by id when the downstream reorders the array', async () => {
    await boot(true);
    const response = await postMcp(gateway, MIXED, { token: viewerToken });

    const items = response.json as Item[];
    // Position 0 is tools/list and position 2 is get_customer_record, even though
    // the downstream answered in the opposite order.
    expect(items.map((item) => item.id)).toEqual([1, 2, 3]);
    expect(items[0]?.result).toHaveProperty('tools');
    expect(items[2]?.result).toHaveProperty('structuredContent');
    expect(items[1]?.error?.code).toBe(-32001);
  });

  it('reports an invalid element at its own position while forwarding the rest', async () => {
    await boot();
    const body = JSON.stringify([
      { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
      { jsonrpc: '1.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'ping' }
    ]);
    const response = await postMcp(gateway, body, { token: viewerToken });

    expect(response.status).toBe(200);
    const items = response.json as Item[];
    expect(items).toHaveLength(3);
    expect(items[1]?.error).toMatchObject({ code: -32600, message: 'Invalid request' });
    expect(items[0]?.result).toBeDefined();
    expect(items[2]?.error).toMatchObject({ code: -32601 });
  });

  it('answers a fully denied batch with no downstream request at all', async () => {
    await boot();
    const body = JSON.stringify([
      { jsonrpc: '2.0', id: 'a', method: 'tools/call', params: { name: 'admin_reset_key' } },
      { jsonrpc: '2.0', id: 'b', method: 'tools/call', params: { name: 'admin_list_tenants' } }
    ]);
    const response = await postMcp(gateway, body, { token: viewerToken });

    expect(response.status).toBe(200);
    const items = response.json as Item[];
    expect(items.map((item) => item.id)).toEqual(['a', 'b']);
    expect(items.every((item) => item.error?.code === -32001)).toBe(true);
    expect(mock.calls.length).toBe(0);
  });

  it('forwards an untouched batch byte-identically for an admin', async () => {
    await boot();
    const body = JSON.stringify([
      { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'admin_reset_key', arguments: { customer_id: 'CUST-1' } }
      }
    ]);
    const response = await postMcp(gateway, body, { token: adminToken });

    expect(response.status).toBe(200);
    expect(mock.calls[0]?.rawBody).toBe(body);
    const items = response.json as Item[];
    expect(items.map((item) => item.id)).toEqual([1, 2]);
  });

  it('answers 202 with no body for a batch of notifications', async () => {
    await boot();
    const body = JSON.stringify([
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } }
    ]);
    const response = await postMcp(gateway, body, { token: viewerToken });

    expect(response.status).toBe(202);
    expect(response.text).toBe('');
    expect(mock.calls).toHaveLength(2);
  });

  it('drops a denied notification inside a batch but still answers the denied request', async () => {
    await boot();
    const body = JSON.stringify([
      { jsonrpc: '2.0', method: 'tools/call', params: { name: 'admin_reset_key' } },
      { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'admin_reset_key' } }
    ]);
    const response = await postMcp(gateway, body, { token: viewerToken });

    expect(response.status).toBe(200);
    expect(response.json).toEqual([
      expect.objectContaining({ jsonrpc: '2.0', id: 7, error: expect.objectContaining({ code: -32001 }) })
    ]);
    expect(mock.calls.length).toBe(0);
  });

  it('rejects an empty batch with a single -32600 object', async () => {
    await boot();
    const response = await postMcp(gateway, '[]', { token: viewerToken });

    expect(response.status).toBe(400);
    expect(response.json).toEqual({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32600, message: 'Invalid request: empty batch' }
    });
    expect(mock.calls.length).toBe(0);
  });

  it('rejects a batch whose every element is invalid', async () => {
    await boot();
    const response = await postMcp(gateway, '[{"jsonrpc":"1.0"},7]', { token: viewerToken });

    expect(response.status).toBe(400);
    expect((response.json as { error: { code: number } }).error.code).toBe(-32600);
    expect(mock.calls.length).toBe(0);
  });

  it('logs one policy decision per element, tagged with its batch index', async () => {
    await boot();
    await postMcp(gateway, MIXED, { token: viewerToken });

    const decisions = gateway.logsFor('policy_decision');
    expect(decisions.map((line) => line.batchIndex)).toEqual([0, 1, 2]);
    expect(decisions.map((line) => line.decision)).toEqual(['allow', 'deny', 'allow']);
  });
});

describe('batch authorization cannot be bypassed by a malformed sibling', () => {
  let mock: MockDownstream;
  let gateway: TestGateway;

  afterEach(async () => {
    await gateway.close();
    await mock.close();
  });

  async function boot(): Promise<void> {
    mock = await startMockDownstream();
    gateway = await startTestGateway({
      config: { tokenSecret: TEST_SECRET, downstreamUrl: mock.url, devTokens: {} }
    });
  }

  /**
   * The attack being guarded against: a viewer sends one allowed call plus one element that fails
   * envelope validation. Forwarding the original raw text would include the unchecked element, so
   * `admin_reset_key` would execute on the downstream; the batch therefore has to be re-serialized
   * from the elements that were actually inspected and allowed.
   */
  const bypasses: { name: string; raw: string }[] = [
    {
      name: 'element missing "jsonrpc"',
      raw: JSON.stringify([
        { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
        { id: 2, method: 'tools/call', params: { name: 'admin_reset_key', arguments: { customer_id: 'CUST-1' } } }
      ])
    },
    {
      name: 'element with "jsonrpc": "1.0"',
      raw: JSON.stringify([
        { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
        { jsonrpc: '1.0', id: 2, method: 'tools/call', params: { name: 'admin_reset_key', arguments: { customer_id: 'CUST-1' } } }
      ])
    },
    {
      name: 'element with an object id',
      raw: JSON.stringify([
        { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
        { jsonrpc: '2.0', id: { nested: true }, method: 'tools/call', params: { name: 'admin_reset_key' } }
      ])
    }
  ];

  for (const bypass of bypasses) {
    it(`never forwards the unchecked element to the downstream: ${bypass.name}`, async () => {
      await boot();

      const response = await postMcp(gateway, bypass.raw, { token: viewerToken });

      expect(response.status).toBe(200);
      const items = response.json as Item[];
      // The invalid element is answered locally with -32600 and never reaches the downstream.
      expect(items.some((item) => item.error?.code === -32600)).toBe(true);

      // The decisive assertion: nothing the downstream received mentions the admin tool.
      const forwarded = mock.calls.map((call) => call.rawBody).join('\n');
      expect(forwarded).not.toContain('admin_reset_key');
      expect(mock.calls).toHaveLength(1); // only the allowed `tools/list`
    });
  }

  it('still forwards an untouched batch byte-for-byte', async () => {
    await boot();
    const clean = JSON.stringify([
      { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }
    ]);

    const response = await postMcp(gateway, clean, { token: viewerToken });

    expect(response.status).toBe(200);
    expect(mock.calls[0]?.rawBody).toBe(clean);
  });
});
