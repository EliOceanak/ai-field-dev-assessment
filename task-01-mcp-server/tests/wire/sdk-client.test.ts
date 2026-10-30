/**
 * Real client interop: the *official* SDK `Client` + `StdioClientTransport`
 * against the real spawned process.
 *
 * The hand-rolled driver in `tests/helpers/mcpProcess.ts` proves the wire
 * contract; this suite proves the server is usable by the SDK that the brief
 * names, including its client-side `structuredContent`/`outputSchema` validation
 * and its error typing.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const PACKAGE_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');

let client: Client;
let stderrChunks: string[];

beforeEach(async () => {
  stderrChunks = [];
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', resolve(PACKAGE_ROOT, 'src/server.ts')],
    cwd: PACKAGE_ROOT,
    stderr: 'pipe',
    env: { PATH: process.env.PATH ?? '', MCP_LOG_LEVEL: 'info' }
  });
  transport.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk.toString('utf8')));

  client = new Client({ name: 'sdk-interop-test', version: '1.0.0' });
  await client.connect(transport);
});

afterEach(async () => {
  await client.close();
});

describe('official SDK client', () => {
  it('negotiates a protocol version and sees the two tools', async () => {
    const tools = await client.listTools();

    expect(client.getServerVersion()).toMatchObject({ name: 'customer-ops-mcp', version: '1.0.0' });
    expect(tools.tools.map((tool) => tool.name)).toEqual(['get_customer_record', 'trigger_refund']);
    expect(tools.tools[1]?.inputSchema).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['customer_id', 'amount', 'reason']
    });
  });

  it('calls get_customer_record and gets structured content validated against the output schema', async () => {
    const result = await client.callTool({ name: 'get_customer_record', arguments: { customer_id: 'CUST-00001' } });

    // `Client.callTool` validates `structuredContent` against the advertised
    // `outputSchema` and would throw if it did not match.
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      customer_id: 'CUST-00001',
      name: 'Ada Lovelace',
      plan: 'enterprise',
      balance_usd: 250.5
    });
  });

  it('calls trigger_refund and observes the balance change', async () => {
    const refund = await client.callTool({
      name: 'trigger_refund',
      arguments: { customer_id: 'CUST-00001', amount: 25.5, reason: 'service outage credit' }
    });
    const record = await client.callTool({ name: 'get_customer_record', arguments: { customer_id: 'CUST-00001' } });

    expect(refund.structuredContent).toMatchObject({ refund_id: 'REF-000001', new_balance_usd: 225 });
    expect(record.structuredContent).toMatchObject({ balance_usd: 225 });
  });

  it('surfaces a schema violation as a typed McpError with data.issues', async () => {
    const error = await client
      .callTool({ name: 'trigger_refund', arguments: { customer_id: 'CUST-0001', amount: 10, reason: 'short' } })
      .then(
        () => undefined,
        (caught: unknown) => caught as McpError
      );

    expect(error).toBeInstanceOf(McpError);
    expect(error?.code).toBe(ErrorCode.InvalidParams);
    expect(error?.data).toMatchObject({
      tool: 'trigger_refund',
      issues: [{ path: 'customer_id' }, { path: 'reason' }]
    });
  });

  it('reads a domain failure as a normal isError result', async () => {
    const result = await client.callTool({
      name: 'trigger_refund',
      arguments: { customer_id: 'CUST-00002', amount: 100, reason: 'goodwill credit' }
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('insufficient_funds');
  });

  it('keeps the child process stderr free of anything but JSON logs', async () => {
    await client.callTool({ name: 'get_customer_record', arguments: { customer_id: 'CUST-00001' } });

    const lines = stderrChunks
      .join('')
      .split('\n')
      .filter((line) => line.trim() !== '');
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(() => JSON.parse(line) as unknown, `stderr line is not JSON: ${line}`).not.toThrow();
    }
  });
});
