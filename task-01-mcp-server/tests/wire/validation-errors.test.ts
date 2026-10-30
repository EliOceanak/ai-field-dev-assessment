/**
 * Protocol compliance: JSON-RPC error mapping on the real wire.
 *
 * The decisive contract, asserted here:
 *   - `-32602` for every schema violation, with `data.issues[].path`;
 *   - `-32601` for an unknown method;
 *   - `-32700` for malformed JSON, and the process keeps serving afterwards;
 *   - `-32600` for a valid-JSON, invalid-envelope message (including a batch);
 *   - domain failures are `isError: true` **results**, never JSON-RPC errors.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startMcpProcess } from '../helpers/mcpProcess.js';
import type { JsonRpcResponse, McpProcess } from '../helpers/mcpProcess.js';

let server: McpProcess;

beforeEach(async () => {
  server = await startMcpProcess();
  await server.initialize();
});

afterEach(async () => {
  await server.close();
});

interface Issues {
  path: string;
  message: string;
  code: string;
}

function issuesOf(response: JsonRpcResponse): Issues[] {
  const data = response.error?.data as { issues?: Issues[] } | undefined;
  return data?.issues ?? [];
}

describe('-32602 invalid params', () => {
  it('rejects a malformed customer_id and names the field', async () => {
    const response = await server.request('tools/call', {
      name: 'get_customer_record',
      arguments: { customer_id: 'CUST-0001' }
    });

    expect(response.error?.code).toBe(-32602);
    expect(response.error?.message).toBe('Invalid params');
    expect(issuesOf(response)).toEqual([
      {
        path: 'customer_id',
        message: 'customer_id must match CUST-XXXXX (CUST- followed by exactly 5 digits)',
        code: 'invalid_format'
      }
    ]);
  });

  it('rejects a string amount, a non-positive amount and too many decimals', async () => {
    const cases: Array<{ amount: unknown; message: string }> = [
      { amount: '10', message: 'amount must be a number' },
      { amount: 0, message: 'amount must be greater than 0' },
      { amount: -1, message: 'amount must be greater than 0' },
      { amount: 10.005, message: 'at most 2 decimal places' },
      { amount: 1e-9, message: 'at most 2 decimal places' }
    ];

    for (const testCase of cases) {
      const response = await server.request('tools/call', {
        name: 'trigger_refund',
        arguments: { customer_id: 'CUST-00001', amount: testCase.amount, reason: 'service outage credit' }
      });

      expect(response.error?.code, `amount=${JSON.stringify(testCase.amount)}`).toBe(-32602);
      expect(issuesOf(response).map((issue) => issue.path)).toEqual(['amount']);
      expect(issuesOf(response)[0]?.message).toContain(testCase.message);
    }
  });

  it('rejects a 9-character reason and a whitespace-only reason', async () => {
    for (const reason of ['too short', '          ']) {
      const response = await server.request('tools/call', {
        name: 'trigger_refund',
        arguments: { customer_id: 'CUST-00001', amount: 10, reason }
      });

      expect(response.error?.code, `reason=${JSON.stringify(reason)}`).toBe(-32602);
      expect(issuesOf(response)).toEqual([
        {
          path: 'reason',
          message: 'reason must be at least 10 characters after trimming',
          code: 'too_small'
        }
      ]);
    }
  });

  it('reports every bad field of one call, in schema order', async () => {
    const response = await server.request('tools/call', {
      name: 'trigger_refund',
      arguments: { customer_id: 'nope', amount: -1, reason: 'short' }
    });

    expect(response.error?.code).toBe(-32602);
    expect(issuesOf(response).map((issue) => issue.path)).toEqual(['customer_id', 'amount', 'reason']);
  });

  it('rejects an unknown extra key with the key name as the path', async () => {
    const response = await server.request('tools/call', {
      name: 'trigger_refund',
      arguments: { customer_id: 'CUST-00001', amount: 10, reason: 'service outage credit', admin: true }
    });

    expect(response.error?.code).toBe(-32602);
    expect(issuesOf(response)).toEqual([
      { path: 'admin', message: 'Unrecognized key: "admin"', code: 'unrecognized_keys' }
    ]);
  });

  it('rejects a missing arguments object by naming all required fields', async () => {
    const response = await server.request('tools/call', { name: 'trigger_refund' });

    expect(response.error?.code).toBe(-32602);
    expect(issuesOf(response).map((issue) => issue.path)).toEqual(['customer_id', 'amount', 'reason']);
  });

  it.each([
    ['null', null],
    ['an array', [1, 2]],
    ['a string', 'nope'],
    ['a number', 7]
  ])('rejects arguments that are %s with a structured issue, not a schema dump', async (_label, value) => {
    // The SDK's own tools/call wrapper validates the request before any handler runs, and answers a
    // non-object `arguments` with `-32602` whose message is a multi-line Zod dump and whose data has
    // no `issues[]`. The guard registers on `Protocol` to own that validation, so this asserts the
    // structured envelope instead: `-32602`, the plain message, exactly one `issues[]` entry whose
    // path is `arguments`, and no Zod text anywhere in the serialized response.
    const response = await server.request('tools/call', { name: 'get_customer_record', arguments: value });

    expect(response.error?.code).toBe(-32602);
    expect(response.error?.message).toBe('Invalid params');
    expect(issuesOf(response)).toEqual([
      { path: 'arguments', message: expect.stringContaining('arguments must be an object'), code: 'invalid_type' }
    ]);
    expect(JSON.stringify(response)).not.toContain('expected record');
  });

  it.each([
    ['a number', 42],
    ['an object', { name: 'get_customer_record' }],
    ['null', null],
    ['an empty string', '']
  ])('rejects a tool name that is %s with a structured issue', async (_label, value) => {
    const response = await server.request('tools/call', { name: value, arguments: {} });

    expect(response.error?.code).toBe(-32602);
    expect(issuesOf(response)).toEqual([
      { path: 'name', message: expect.stringContaining('non-empty string'), code: 'invalid_type' }
    ]);
  });

  it('carries the tool name and a request id alongside the issues', async () => {
    const response = await server.request(
      'tools/call',
      { name: 'trigger_refund', arguments: { customer_id: 'CUST-00001', amount: 0, reason: 'service outage' } },
      42
    );

    expect(response.id).toBe(42);
    expect(response.error?.data).toMatchObject({ tool: 'trigger_refund', reqId: '42' });
  });

  it('keeps the error correlatable with the stderr log line', async () => {
    const response = await server.request(
      'tools/call',
      { name: 'trigger_refund', arguments: { customer_id: 'CUST-00001', amount: 0, reason: 'service outage' } },
      'req-77'
    );

    const reqId = (response.error?.data as { reqId?: string }).reqId;
    expect(reqId).toBe('req-77');
    const logLine = server.stderrLogs().find((line) => line.event === 'tool_rejected' && line.reqId === reqId);
    expect(logLine).toMatchObject({ tool: 'trigger_refund', reason: 'invalid_arguments', paths: ['amount'] });
  });
});

describe('-32601 unknown method and unknown tool', () => {
  it('answers an unknown method with -32601', async () => {
    const response = await server.request('resources/read', { uri: 'file:///etc/passwd' });

    expect(response.error).toEqual({ code: -32601, message: 'Method not found' });
  });

  it('answers an unknown tool with -32602, the measured SDK/spec behaviour', async () => {
    // Measured: `McpServer` itself throws `McpError(InvalidParams, 'Tool X not
    // found')` (server/mcp.js:154), and the MCP spec treats an unknown tool name
    // as an invalid *parameter*, not an unknown *method*. We keep the code and
    // add the structured payload; see the README design notes.
    const response = await server.request('tools/call', { name: 'ghost_tool', arguments: {} });

    expect(response.error?.code).toBe(-32602);
    expect(issuesOf(response)).toEqual([
      { path: 'name', message: 'Unknown tool: ghost_tool', code: 'unknown_tool' }
    ]);
  });
});

describe('-32700 parse errors keep the server alive', () => {
  it('answers malformed JSON with -32700, id null, and still serves', async () => {
    server.raw('{"jsonrpc":"2.0","id":9,"method":"tools/list"');

    const parseError = await server.waitForStdout((message) => message.error?.code === -32700);
    expect(parseError).toMatchObject({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });

    const after = await server.request('tools/list', {});
    expect(after.error).toBeUndefined();
    expect((after.result?.tools as unknown[]).length).toBe(2);
  });

  it('survives a burst of garbage and then answers a valid request', async () => {
    server.raw('not json at all');
    server.raw('{"jsonrpc":"2.0","id":1,"method":');
    server.raw('}{');

    const after = await server.request('ping', {});
    expect(after.result).toEqual({});

    const parseErrors = server
      .stdoutLines()
      .map((line) => JSON.parse(line) as JsonRpcResponse)
      .filter((message) => message.error?.code === -32700);
    expect(parseErrors.length).toBe(3);
  });

  it('logs the framing failure to stderr without echoing the offending line', async () => {
    server.raw('{"jsonrpc":"2.0","id":1,"secret":"ada@example.com"');

    await server.waitForStdout((message) => message.error?.code === -32700);
    const framingLog = server.stderrLogs().find((line) => line.event === 'jsonrpc_framing_error');
    expect(framingLog).toMatchObject({ code: -32700, response: 'id:null' });
    expect(server.stderrLines().join('\n')).not.toContain('ada@example.com');
  });
});

describe('-32600 invalid envelope', () => {
  it('answers a valid-JSON but invalid JSON-RPC message with -32600', async () => {
    server.raw('{"id":1,"method":"tools/list"}');

    const response = await server.waitForStdout((message) => message.error?.code === -32600);
    expect(response).toMatchObject({ id: null, error: { code: -32600, message: 'Invalid Request' } });
  });

  it('answers a non-object params value with -32600 instead of leaking a schema dump', async () => {
    server.raw('{"jsonrpc":"2.0","id":"bad-params","method":"tools/call","params":42}');

    const response = await server.waitForStdout((message) => message.error?.code === -32600);
    expect(response?.error?.message).toBe('Invalid Request');

    // Still serving.
    expect((await server.request('ping', {})).result).toEqual({});
  });

  it('rejects a JSON-RPC batch array, which this protocol revision does not support', async () => {
    server.raw('[{"jsonrpc":"2.0","id":1,"method":"tools/list"}]');

    const response = await server.waitForStdout((message) => message.error?.code === -32600);
    expect(response?.id).toBeNull();
  });
});

describe('domain failures are tool results, not JSON-RPC errors', () => {
  it('returns isError for an unknown but well-formed customer id', async () => {
    const response = await server.request('tools/call', {
      name: 'get_customer_record',
      arguments: { customer_id: 'CUST-09999' }
    });

    expect(response.error).toBeUndefined();
    const result = response.result as { isError?: boolean; content: Array<{ text?: string }> };
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]?.text ?? '{}')).toEqual({
      error: {
        code: 'customer_not_found',
        message: 'No customer record found for CUST-09999',
        customer_id: 'CUST-09999'
      }
    });
  });

  it('returns isError when the refund exceeds the balance, and leaves the balance untouched', async () => {
    const response = await server.request('tools/call', {
      name: 'trigger_refund',
      arguments: { customer_id: 'CUST-00002', amount: 100, reason: 'goodwill credit' }
    });

    expect(response.error).toBeUndefined();
    const result = response.result as { isError?: boolean; content: Array<{ text?: string }> };
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]?.text ?? '{}')).toMatchObject({
      error: { code: 'insufficient_funds', balance_usd: 75, requested_usd: 100 }
    });

    const record = await server.request('tools/call', {
      name: 'get_customer_record',
      arguments: { customer_id: 'CUST-00002' }
    });
    expect((record.result as { structuredContent: { balance_usd: number } }).structuredContent.balance_usd).toBe(75);
  });

  it('logs the rejection with its domain code', async () => {
    await server.request('tools/call', {
      name: 'trigger_refund',
      arguments: { customer_id: 'CUST-00002', amount: 100, reason: 'goodwill credit' }
    });

    expect(
      server.stderrLogs().find((line) => line.event === 'tool_rejected' && line.reason === 'insufficient_funds')
    ).toBeDefined();
  });
});

describe('no internal error leaks', () => {
  it('never returns -32603 for client-side mistakes, and never leaks paths or stacks', async () => {
    const responses = [
      await server.request('tools/call', { name: 'ghost', arguments: {} }),
      await server.request('tools/call', { name: 'trigger_refund', arguments: 'nope' }),
      await server.request('tools/call', {
        name: 'trigger_refund',
        arguments: { customer_id: null, amount: null, reason: null }
      }),
      await server.request('tools/call', { name: 'get_customer_record', arguments: [] })
    ];

    for (const response of responses) {
      expect(response.error?.code).toBe(-32602);
      expect(JSON.stringify(response)).not.toContain('at Object.');
      expect(JSON.stringify(response)).not.toContain('/home/');
    }
  });
});
