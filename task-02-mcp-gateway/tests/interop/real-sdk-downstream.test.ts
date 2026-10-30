/**
 * Interop: a **real** MCP server (`McpServer` + `StreamableHTTPServerTransport`)
 * behind the gateway, driven by the **real** SDK client *through* the gateway.
 *
 * This is the strongest available evidence that the proxy is transparent: neither
 * side knows the gateway exists. It also proves the interception point is the
 * gateway's own decision, because the downstream server's tool handlers record
 * their own invocations — `admin_reset_key` never appears in that list for a viewer.
 *
 * Note the transport defaults to SSE responses, so this suite also drives the SSE
 * passthrough path against the official SDK implementation.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startSdkDownstream } from '../../mock/sdkDownstream.js';
import type { SdkDownstream } from '../../mock/sdkDownstream.js';
import { startTestGateway } from '../helpers/startGateway.js';
import type { TestGateway } from '../helpers/startGateway.js';
import { TEST_SECRET, mintToken } from '../helpers/tokens.js';

const adminToken = mintToken('admin');
const viewerToken = mintToken('viewer');

let downstream: SdkDownstream;
let gateway: TestGateway;

async function connect(token: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(gateway.url), {
    requestInit: { headers: { authorization: `Bearer ${token}` } }
  });
  const client = new Client({ name: 'gateway-interop-test', version: '1.0.0' });
  await client.connect(transport);
  return client;
}

beforeAll(async () => {
  downstream = await startSdkDownstream();
  gateway = await startTestGateway({
    config: { tokenSecret: TEST_SECRET, downstreamUrl: downstream.url, devTokens: {} }
  });
});

afterAll(async () => {
  await gateway.close();
  await downstream.close();
});

describe('real MCP server behind the gateway', () => {
  it('completes the SDK handshake and lists tools transparently for both roles', async () => {
    const admin = await connect(adminToken);
    const viewer = await connect(viewerToken);

    const adminTools = await admin.listTools();
    const viewerTools = await viewer.listTools();

    const names = ['get_customer_record', 'trigger_refund', 'admin_reset_key', 'admin_list_tenants'];
    expect(adminTools.tools.map((tool) => tool.name)).toEqual(names);
    expect(viewerTools.tools.map((tool) => tool.name)).toEqual(names);
    expect(viewerTools.tools).toEqual(adminTools.tools);

    await admin.close();
    await viewer.close();
  });

  it('blocks a viewer admin_* call before the real server sees it', async () => {
    const viewer = await connect(viewerToken);
    downstream.reset();

    const failure = await viewer.callTool({ name: 'admin_reset_key', arguments: { customer_id: 'CUST-00001' } }).then(
      () => undefined,
      (error: unknown) => error as { code?: number; message?: string; data?: unknown }
    );

    expect(failure).toBeDefined();
    expect(failure?.code).toBe(-32001);
    expect(failure?.message).toContain('Unauthorized tool call');
    // The real server's handler never ran.
    expect(downstream.invocations).not.toContain('admin_reset_key');
    expect(downstream.invocations).toHaveLength(0);

    await viewer.close();
  });

  it('lets the same viewer call a non-privileged tool through the gateway', async () => {
    const viewer = await connect(viewerToken);
    downstream.reset();

    const result = await viewer.callTool({ name: 'get_customer_record', arguments: { customer_id: 'CUST-00001' } });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ customer_id: 'CUST-00001' });
    expect(downstream.invocations).toEqual(['get_customer_record']);

    await viewer.close();
  });

  it('lets an admin execute the privileged tool through the gateway', async () => {
    const admin = await connect(adminToken);
    downstream.reset();

    const result = await admin.callTool({ name: 'admin_reset_key', arguments: { customer_id: 'CUST-00001' } });

    expect(result.structuredContent).toMatchObject({ rotated: true, customer_id: 'CUST-00001' });
    expect(downstream.invocations).toEqual(['admin_reset_key']);

    await admin.close();
  });

  it('rejects an unauthenticated SDK client with the transport-level 401', async () => {
    const transport = new StreamableHTTPClientTransport(new URL(gateway.url));
    const client = new Client({ name: 'gateway-interop-anon', version: '1.0.0' });

    await expect(client.connect(transport)).rejects.toThrow();
  });
});
