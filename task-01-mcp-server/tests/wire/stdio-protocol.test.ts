/**
 * Wire protocol: the happy path, driven by raw JSON-RPC over the real stdio pipe.
 *
 * These tests deliberately avoid the SDK client — the framing, the `id` echo and
 * the result shapes must hold for *any* client, including the SDK client covered
 * in `tests/wire/sdk-client.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startMcpProcess } from '../helpers/mcpProcess.js';
import type { McpProcess } from '../helpers/mcpProcess.js';
import { toJsonSchema } from '../../src/schemas/customer.js';
import { getCustomerRecordInputSchema, triggerRefundInputSchema } from '../../src/schemas/customer.js';

let server: McpProcess;

beforeEach(async () => {
  server = await startMcpProcess();
});

afterEach(async () => {
  await server.close();
});

describe('initialize', () => {
  it('reports the server identity, the tools capability and the negotiated protocol version', async () => {
    const response = await server.request('initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'raw-wire-test', version: '1.0.0' }
    });

    expect(response.error).toBeUndefined();
    expect(response.result).toMatchObject({
      protocolVersion: '2025-11-25',
      serverInfo: { name: 'customer-ops-mcp', version: '1.0.0' },
      capabilities: { tools: { listChanged: true } }
    });
    expect(typeof response.result?.instructions).toBe('string');
  });

  it('takes the advertised identity from the environment', async () => {
    await server.close();
    server = await startMcpProcess({ env: { MCP_SERVER_NAME: 'refunds-mcp', MCP_SERVER_VERSION: '9.9.9' } });

    const response = await server.initialize();
    expect(response.result?.serverInfo).toEqual({ name: 'refunds-mcp', version: '9.9.9' });
  });

  it('answers notifications/initialized with no response at all', async () => {
    await server.initialize();
    const before = server.stdoutLines().length;
    server.notify('notifications/initialized');
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 150));
    expect(server.stdoutLines().length).toBe(before);
  });

  it('answers ping with an empty result object', async () => {
    await server.initialize();
    expect(await server.request('ping', {})).toMatchObject({ result: {} });
  });
});

describe('tools/list', () => {
  it('advertises exactly the two tools, in a stable order', async () => {
    await server.initialize();
    const response = await server.request('tools/list', {});
    const tools = response.result?.tools as Array<{ name: string }>;

    expect(tools.map((tool) => tool.name)).toEqual(['get_customer_record', 'trigger_refund']);
  });

  it('advertises the schema that is actually enforced, with a closed object', async () => {
    await server.initialize();
    const response = await server.request('tools/list', {});
    const tools = response.result?.tools as Array<{ name: string; inputSchema: Record<string, unknown> }>;

    expect(tools[0]?.inputSchema).toEqual(toJsonSchema(getCustomerRecordInputSchema));
    expect(tools[1]?.inputSchema).toEqual(toJsonSchema(triggerRefundInputSchema));
    expect(tools[0]?.inputSchema.additionalProperties).toBe(false);
    expect(tools[1]?.inputSchema.required).toEqual(['customer_id', 'amount', 'reason']);
  });

  it('gives every tool a description and an output schema', async () => {
    await server.initialize();
    const response = await server.request('tools/list', {});
    const tools = response.result?.tools as Array<{
      name: string;
      description?: string;
      outputSchema?: Record<string, unknown>;
      annotations?: Record<string, unknown>;
    }>;

    for (const tool of tools) {
      expect(tool.description?.length ?? 0).toBeGreaterThan(40);
      expect(tool.outputSchema?.additionalProperties).toBe(false);
    }
    expect(tools[0]?.annotations?.readOnlyHint).toBe(true);
    expect(tools[1]?.annotations?.readOnlyHint).toBe(false);
  });
});

describe('tools/call — get_customer_record', () => {
  it('returns the record as readable text and as structuredContent', async () => {
    await server.initialize();
    const response = await server.request('tools/call', {
      name: 'get_customer_record',
      arguments: { customer_id: 'CUST-00001' }
    });

    const result = response.result as {
      content: Array<{ type: string; text: string }>;
      structuredContent: Record<string, unknown>;
      isError?: boolean;
    };

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({
      customer_id: 'CUST-00001',
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      plan: 'enterprise',
      balance_usd: 250.5,
      refunds: []
    });
    expect(result.content).toHaveLength(1);
    expect(JSON.parse(result.content[0]!.text)).toEqual(result.structuredContent);
  });
});

describe('tools/call — trigger_refund', () => {
  it('applies the refund and reports the new balance', async () => {
    await server.initialize();
    const response = await server.request('tools/call', {
      name: 'trigger_refund',
      arguments: { customer_id: 'CUST-00001', amount: 25, reason: 'service outage credit' }
    });

    const result = response.result as { structuredContent: Record<string, unknown>; isError?: boolean };
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({
      refund_id: 'REF-000001',
      customer_id: 'CUST-00001',
      amount_usd: 25,
      new_balance_usd: 225.5,
      reason: 'service outage credit',
      idempotent_replay: false
    });
  });

  it('is observable through a following get_customer_record', async () => {
    await server.initialize();
    await server.request('tools/call', {
      name: 'trigger_refund',
      arguments: { customer_id: 'CUST-00001', amount: 25, reason: 'service outage credit' }
    });

    const response = await server.request('tools/call', {
      name: 'get_customer_record',
      arguments: { customer_id: 'CUST-00001' }
    });
    const record = (response.result as { structuredContent: { balance_usd: number; refunds: unknown[] } })
      .structuredContent;

    expect(record.balance_usd).toBe(225.5);
    expect(record.refunds).toHaveLength(1);
  });

  it('issues sequential refund ids across calls', async () => {
    await server.initialize();
    const first = await server.request('tools/call', {
      name: 'trigger_refund',
      arguments: { customer_id: 'CUST-00001', amount: 1, reason: 'first refund credit' }
    });
    const second = await server.request('tools/call', {
      name: 'trigger_refund',
      arguments: { customer_id: 'CUST-00002', amount: 2, reason: 'second refund credit' }
    });

    expect((first.result as { structuredContent: { refund_id: string } }).structuredContent.refund_id).toBe(
      'REF-000001'
    );
    expect((second.result as { structuredContent: { refund_id: string } }).structuredContent.refund_id).toBe(
      'REF-000002'
    );
  });

  it('replays the same idempotency key instead of refunding twice', async () => {
    await server.initialize();
    const call = () =>
      server.request('tools/call', {
        name: 'trigger_refund',
        arguments: {
          customer_id: 'CUST-00001',
          amount: 25,
          reason: 'service outage credit',
          idempotency_key: 'retry-1'
        }
      });

    const first = await call();
    const replay = await call();
    const firstReceipt = (first.result as { structuredContent: Record<string, unknown> }).structuredContent;
    const replayReceipt = (replay.result as { structuredContent: Record<string, unknown> }).structuredContent;

    expect(replayReceipt.refund_id).toBe(firstReceipt.refund_id);
    expect(replayReceipt.idempotent_replay).toBe(true);
    expect(replayReceipt.new_balance_usd).toBe(225.5);

    const record = await server.request('tools/call', {
      name: 'get_customer_record',
      arguments: { customer_id: 'CUST-00001' }
    });
    expect((record.result as { structuredContent: { refunds: unknown[] } }).structuredContent.refunds).toHaveLength(1);
  });
});

describe('id echo', () => {
  it('echoes id 0 exactly, as a number', async () => {
    await server.initialize();
    const response = await server.request('tools/list', {}, 0);
    expect(response.id).toBe(0);
    expect(typeof response.id).toBe('number');
  });

  it('echoes a string id exactly', async () => {
    await server.initialize();
    const response = await server.request('tools/list', {}, 'abc');
    expect(response.id).toBe('abc');
  });

  it('echoes a large integer id exactly', async () => {
    await server.initialize();
    const response = await server.request('tools/list', {}, 9007199254740991);
    expect(response.id).toBe(9007199254740991);
  });
});

describe('graceful shutdown', () => {
  it('exits 0 on stdin EOF and logs the shutdown sequence', async () => {
    await server.initialize();
    const code = await server.exit();

    expect(code).toBe(0);
    const events = server.stderrLogs().map((line) => line.event);
    expect(events).toContain('server_started');
    expect(events).toContain('server_stopping');
    expect(events).toContain('server_stopped');
  });

  it('exits 0 on SIGTERM after logging the shutdown sequence', async () => {
    await server.initialize();
    const pid = server.pid;
    expect(typeof pid).toBe('number');

    process.kill(pid as number, 'SIGTERM');
    const code = await server.waitForExit();

    expect(code).toBe(0);
    const events = server.stderrLogs().map((line) => line.event);
    expect(events).toContain('server_stopping');
    expect(events).toContain('server_stopped');
    expect(server.stderrLogs().find((line) => line.event === 'server_stopping')?.reason).toBe('sigterm');
  });
});
