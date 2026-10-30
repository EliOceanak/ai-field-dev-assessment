/**
 * The tool-call guard, in process.
 *
 * These tests cover what the wire suites cannot reach without a broken
 * deployment: a handler that throws, and a handler whose `structuredContent`
 * violates the advertised `outputSchema`. Both must leave the client with a
 * sanitized `-32603` while the operator gets the real cause on stderr.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolResultSchema, ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createStore } from '../../src/data/store.js';
import { createLogger } from '../../src/logging/logger.js';
import { installToolCallGuard } from '../../src/protocol/toolCallGuard.js';
import { buildServer, createIsolatedServer } from '../../src/server.js';
import type { ToolDefinition } from '../../src/tools/types.js';

function silentLogger(level: 'info' | 'debug' = 'debug') {
  const lines: string[] = [];
  return {
    lines,
    logger: createLogger({
      level,
      stream: { write: (chunk: string) => (lines.push(chunk), true) } as unknown as NodeJS.WritableStream
    })
  };
}

async function connect(server: McpServer): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'guard-test', version: '1.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

async function expectProtocolError(promise: Promise<unknown>): Promise<McpError> {
  const caught = await promise.then(
    () => undefined,
    (error: unknown) => error
  );
  expect(caught).toBeInstanceOf(McpError);
  return caught as McpError;
}

describe('the guard on a healthy server', () => {
  it('lets a valid call through and returns structured content the client accepts', async () => {
    const { server } = createIsolatedServer({ logger: silentLogger().logger });
    const client = await connect(server);

    const tools = await client.listTools();
    const result = await client.callTool({
      name: 'get_customer_record',
      arguments: { customer_id: 'CUST-00002' }
    });

    expect(tools.tools.map((tool) => tool.name)).toEqual(['get_customer_record', 'trigger_refund']);
    expect(result.structuredContent).toMatchObject({ customer_id: 'CUST-00002', balance_usd: 75 });
    await client.close();
  });

  it('rejects invalid arguments as a -32602 protocol error, not an isError result', async () => {
    const { server } = createIsolatedServer({ logger: silentLogger().logger });
    const client = await connect(server);

    const error = await expectProtocolError(
      client.callTool({
        name: 'trigger_refund',
        arguments: { customer_id: 'CUST-00001', amount: 0, reason: 'short' }
      })
    );

    expect(error.code).toBe(ErrorCode.InvalidParams);
    // The wire message is exactly `Invalid params` (see tests/wire/validation-errors.test.ts);
    // the SDK client re-wraps it in `McpError`, which prefixes `MCP error -32602: `.
    expect(error.message).toContain('Invalid params');
    expect(error.data).toMatchObject({
      tool: 'trigger_refund',
      issues: [
        { path: 'amount', code: 'too_small' },
        { path: 'reason', code: 'too_small' }
      ]
    });
    await client.close();
  });

  it('answers an unknown tool with -32602 and a name path', async () => {
    const { server } = createIsolatedServer({ logger: silentLogger().logger });
    const client = await connect(server);

    const error = await expectProtocolError(client.callTool({ name: 'no_such_tool', arguments: {} }));

    expect(error.code).toBe(ErrorCode.InvalidParams);
    expect(error.data).toMatchObject({ issues: [{ path: 'name', code: 'unknown_tool' }] });
    await client.close();
  });

  it('logs every call and rejection to the injected logger', async () => {
    const sink = silentLogger();
    const { server } = createIsolatedServer({ logger: sink.logger });
    const client = await connect(server);

    await client.callTool({ name: 'get_customer_record', arguments: { customer_id: 'CUST-00001' } });
    await client
      .callTool({ name: 'get_customer_record', arguments: { customer_id: 'nope' } })
      .catch(() => undefined);

    const events = sink.lines.map((line) => (JSON.parse(line) as { event: string }).event);
    expect(events).toContain('tool_called');
    expect(events).toContain('tool_completed');
    expect(events).toContain('tool_rejected');
    await client.close();
  });
});

describe('the guard on a broken tool', () => {
  const brokenTool = (handler: ToolDefinition['handler']): ToolDefinition => ({
    name: 'broken_tool',
    title: 'Broken tool',
    description: 'A tool used only by the guard tests.',
    inputSchema: z.strictObject({ value: z.string() }),
    outputSchema: z.strictObject({ echo: z.string() }),
    annotations: { readOnlyHint: true },
    handler
  });

  async function clientFor(tool: ToolDefinition, sink: ReturnType<typeof silentLogger>): Promise<Client> {
    const server = new McpServer({ name: 'guard-test', version: '0.0.0' }, { capabilities: { tools: {} } });
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.inputSchema, outputSchema: tool.outputSchema },
      async () => ({ content: [{ type: 'text', text: 'x' }] })
    );
    installToolCallGuard(server, { tools: [tool], logger: sink.logger, store: createStore() });
    return connect(server);
  }

  it('sanitizes an unexpected exception into -32603 and keeps the cause on stderr', async () => {
    const sink = silentLogger();
    const client = await clientFor(
      brokenTool(() => {
        throw new Error('SENTINEL: upstream database dsn postgres://user:pw@host/db');
      }),
      sink
    );

    const error = await expectProtocolError(client.callTool({ name: 'broken_tool', arguments: { value: 'x' } }));

    expect(error.code).toBe(ErrorCode.InternalError);
    expect(error.message).toContain('Internal error');
    expect(JSON.stringify(error.data)).not.toContain('SENTINEL');
    expect(JSON.stringify(error.data)).not.toContain('postgres');

    // The operator still sees the real cause, correlated by reqId.
    const failure = sink.lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((line) => line.event === 'tool_failed');
    expect((failure?.cause as { message?: string } | undefined)?.message).toContain('SENTINEL');
    expect(failure?.reqId).toBe((error.data as { reqId?: string }).reqId);

    await client.close();
  });

  it('rejects structuredContent that violates the advertised outputSchema', async () => {
    const sink = silentLogger();
    const client = await clientFor(
      brokenTool(() => ({ content: [{ type: 'text', text: '{}' }], structuredContent: { echo: 42 } })),
      sink
    );

    const error = await expectProtocolError(client.callTool({ name: 'broken_tool', arguments: { value: 'x' } }));

    expect(error.code).toBe(ErrorCode.InternalError);
    expect(sink.lines.map((line) => (JSON.parse(line) as { event: string }).event)).toContain('tool_output_invalid');

    await client.close();
  });

  it('does not validate output for an isError result', async () => {
    const sink = silentLogger();
    const client = await clientFor(
      brokenTool(() => ({ isError: true, content: [{ type: 'text', text: '{"error":{"code":"x"}}' }] })),
      sink
    );

    const result = await client.callTool({ name: 'broken_tool', arguments: { value: 'x' } }, CallToolResultSchema);
    expect(result.isError).toBe(true);
    await client.close();
  });
});

describe('buildServer', () => {
  it('exposes the two tools over a fresh store and reports the configured identity', async () => {
    const sink = silentLogger();
    const server = buildServer({
      config: { serverName: 'test-mcp', serverVersion: '2.0.0', logLevel: 'debug' },
      logger: sink.logger,
      store: createStore()
    });
    const client = await connect(server);

    expect(client.getServerVersion()).toEqual({ name: 'test-mcp', version: '2.0.0' });
    expect((await client.listTools()).tools).toHaveLength(2);
    await client.close();
  });
});
