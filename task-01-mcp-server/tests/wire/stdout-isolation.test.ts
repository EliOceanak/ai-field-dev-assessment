/**
 * STDIO isolation: every byte the real process writes to stdout must be a valid
 * JSON-RPC message, and every log line must arrive on stderr.
 *
 * This is the executable form of the spec's stdio binding rules:
 *   "The server MUST NOT write anything to its stdout that is not a valid MCP
 *    message. The server MAY write UTF-8 strings to stderr for any logging
 *    purposes."  — docs/SDK-AND-PROTOCOL-NOTES.md
 *
 * `scripts/check-stdout-hygiene.mjs` enforces the same rule statically; this
 * suite enforces it on the wire, including while validation fails and after
 * malformed input, with logging turned up to `debug`.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { startMcpProcess } from '../helpers/mcpProcess.js';
import type { McpProcess } from '../helpers/mcpProcess.js';

let server: McpProcess | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

/** Assert every captured stdout line parses as a JSON-RPC 2.0 message. */
function assertEveryLineIsJsonRpc(process_: McpProcess): number {
  const lines = process_.stdoutLines();
  expect(lines.length).toBeGreaterThan(0);

  for (const line of lines) {
    // Framing: one message per line, no embedded newlines, no ANSI escapes.
    expect(line).not.toMatch(/[\u001b\u0000-\u0008\u000b-\u001f]/);
    let parsed: Record<string, unknown> = {};
    expect(() => {
      parsed = JSON.parse(line) as Record<string, unknown>;
    }, `stdout line is not JSON: ${line}`).not.toThrow();

    expect(parsed.jsonrpc, `stdout line is not JSON-RPC 2.0: ${line}`).toBe('2.0');
    const isResponse = Object.prototype.hasOwnProperty.call(parsed, 'id');
    const isNotification = typeof parsed.method === 'string' && !isResponse;
    expect(isResponse || isNotification, `stdout line is neither a response nor a notification: ${line}`).toBe(true);
    if (isResponse) {
      expect(parsed.result !== undefined || parsed.error !== undefined).toBe(true);
    }
  }

  return lines.length;
}

describe('stdout carries nothing but JSON-RPC', () => {
  it('stays pure across the whole happy path with logging at debug', async () => {
    server = await startMcpProcess({ env: { MCP_LOG_LEVEL: 'debug' } });
    await server.initialize();
    await server.request('tools/list', {});
    await server.request('tools/call', {
      name: 'get_customer_record',
      arguments: { customer_id: 'CUST-00001' }
    });
    await server.request('tools/call', {
      name: 'trigger_refund',
      arguments: { customer_id: 'CUST-00001', amount: 25, reason: 'service outage credit' }
    });

    expect(assertEveryLineIsJsonRpc(server)).toBe(4);
  });

  it('stays pure while validation fails and after malformed input', async () => {
    server = await startMcpProcess({ env: { MCP_LOG_LEVEL: 'debug' } });
    await server.initialize();

    await server.request('tools/call', { name: 'trigger_refund', arguments: { amount: 'ten' } });
    await server.request('tools/call', { name: 'ghost', arguments: {} });
    await server.request('tools/call', {
      name: 'trigger_refund',
      arguments: { customer_id: 'CUST-00002', amount: 100, reason: 'goodwill credit' }
    });
    await server.request('tools/call', { name: 'get_customer_record', arguments: { customer_id: 'CUST-09999' } });
    server.raw('{ this is not json');
    server.raw('{"jsonrpc":"2.0","id":1}');
    await server.request('ping', {});
    await server.request('unknown/method', {});

    // 7 responses + 1 parse error + 1 invalid request
    expect(assertEveryLineIsJsonRpc(server)).toBe(9);
  });

  it('keeps stdout pure when logging is silent', async () => {
    server = await startMcpProcess({ env: { MCP_LOG_LEVEL: 'silent' } });
    await server.initialize();
    await server.request('tools/list', {});

    expect(assertEveryLineIsJsonRpc(server)).toBe(2);
    expect(server.stderrLines()).toHaveLength(0);
  });
});

describe('stderr carries the logs', () => {
  it('emits one JSON object per line for the whole request lifecycle', async () => {
    server = await startMcpProcess({ env: { MCP_LOG_LEVEL: 'debug' } });
    await server.initialize();
    await server.request('tools/call', {
      name: 'trigger_refund',
      arguments: { customer_id: 'CUST-00001', amount: 25, reason: 'service outage credit' }
    });

    const logs = server.stderrLogs();
    expect(logs.length).toBeGreaterThanOrEqual(3);
    for (const line of logs) {
      expect(typeof line.ts).toBe('string');
      expect(['debug', 'info', 'warn', 'error']).toContain(line.level);
      expect(typeof line.event).toBe('string');
    }

    const events = logs.map((line) => line.event);
    expect(events).toContain('server_started');
    expect(events).toContain('tool_called');
    expect(events).toContain('tool_completed');
  });

  it('correlates each tool log line with the JSON-RPC request id', async () => {
    server = await startMcpProcess();
    await server.initialize();
    await server.request(
      'tools/call',
      { name: 'get_customer_record', arguments: { customer_id: 'CUST-00001' } },
      'trace-me'
    );

    const logLine = server.stderrLogs().find((line) => line.event === 'tool_called');
    expect(logLine).toMatchObject({ reqId: 'trace-me', tool: 'get_customer_record', customerId: 'CUST-00001' });
  });

  it('never logs the refund reason or the full argument payload', async () => {
    const reason = 'SENTINEL reason text that must never be logged';
    server = await startMcpProcess({ env: { MCP_LOG_LEVEL: 'debug' } });
    await server.initialize();
    await server.request('tools/call', {
      name: 'trigger_refund',
      arguments: { customer_id: 'CUST-00001', amount: 25, reason }
    });

    const stderr = server.stderrLines().join('\n');
    expect(stderr).not.toContain(reason);
    expect(stderr).not.toContain('SENTINEL');
    // Shapes and identifiers are logged instead.
    expect(stderr).toContain('reasonChars');
    expect(stderr).toContain('REF-000001');
  });

  it('never logs a customer email address', async () => {
    server = await startMcpProcess({ env: { MCP_LOG_LEVEL: 'debug' } });
    await server.initialize();
    await server.request('tools/call', {
      name: 'get_customer_record',
      arguments: { customer_id: 'CUST-00001' }
    });

    expect(server.stderrLines().join('\n')).not.toContain('ada@example.com');
  });
});
