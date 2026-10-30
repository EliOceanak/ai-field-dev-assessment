/**
 * Real-SDK downstream MCP server for the interop test.
 *
 * Unlike `mock/downstream.ts` (a hand-rolled JSON-RPC HTTP server, which is what
 * makes byte-identical assertions possible), this one is the official
 * `McpServer` + `StreamableHTTPServerTransport` pair — the same stack Task 1 uses.
 * Its job is to prove the gateway is transparent to a *real* MCP server:
 *
 *  - `sessionIdGenerator: undefined` → stateless mode, no `Mcp-Session-Id` handling;
 *  - `enableJsonResponse` left at its default (`false`), so POST responses come back
 *    as `text/event-stream` — which means the gateway's SSE passthrough is exercised
 *    against the real SDK, not a synthetic stream;
 *  - the tool handlers push their own name into `invocations`, so a test can prove
 *    the server never saw a blocked `admin_*` call.
 */
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

export interface SdkDownstream {
  url: string;
  port: number;
  /** Tool names whose handlers actually ran, in order. */
  invocations: string[];
  reset(): void;
  close(): Promise<void>;
  server: Server;
}

export interface SdkDownstreamOptions {
  port?: number;
  host?: string;
  /** Return JSON responses instead of SSE (default: the SDK's SSE behaviour). */
  enableJsonResponse?: boolean;
}

export async function startSdkDownstream(options: SdkDownstreamOptions = {}): Promise<SdkDownstream> {
  const invocations: string[] = [];

  /**
   * Build the server: four tools, two of them privileged.
   *
   * A **new** `McpServer` + `StreamableHTTPServerTransport` pair is created per
   * request (see the request handler): in stateless mode the v1.32 SDK throws
   * `Stateless transport cannot be reused across requests`, so one shared instance
   * would fail on the second POST. The `invocations` array is shared, which is what
   * makes "the real server never saw this call" observable.
   */
  function buildServer(): McpServer {
    const server = new McpServer(
      { name: 'sdk-downstream', version: '1.0.0' },
      { capabilities: { tools: {} }, instructions: 'Real-SDK downstream used by the gateway interop test.' }
    );

    server.registerTool(
      'get_customer_record',
      { description: 'Read a customer record.', inputSchema: { customer_id: z.string() } },
      ({ customer_id }) => {
        invocations.push('get_customer_record');
        return {
          content: [{ type: 'text', text: JSON.stringify({ customer_id, name: 'Ada Lovelace' }) }],
          structuredContent: { customer_id, name: 'Ada Lovelace' }
        };
      }
    );

    server.registerTool(
      'trigger_refund',
      {
        description: 'Refund an amount.',
        inputSchema: { customer_id: z.string(), amount: z.number(), reason: z.string() }
      },
      ({ customer_id, amount, reason }) => {
        invocations.push('trigger_refund');
        return {
          content: [{ type: 'text', text: JSON.stringify({ customer_id, amount, reason }) }],
          structuredContent: { refund_id: 'RFD-1', amount }
        };
      }
    );

    server.registerTool(
      'admin_reset_key',
      { description: 'Rotate an API key (admin only).', inputSchema: { customer_id: z.string() } },
      ({ customer_id }) => {
        invocations.push('admin_reset_key');
        return {
          content: [{ type: 'text', text: JSON.stringify({ rotated: true, customer_id }) }],
          structuredContent: { rotated: true, customer_id }
        };
      }
    );

    server.registerTool('admin_list_tenants', { description: 'List tenants (admin only).', inputSchema: {} }, () => {
      invocations.push('admin_list_tenants');
      return {
        content: [{ type: 'text', text: JSON.stringify({ tenants: ['acme'] }) }],
        structuredContent: { tenants: ['acme'] }
      };
    });

    return server;
  }

  const httpServer = createServer((req, res) => {
    void (async () => {
      const server = buildServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        ...(options.enableJsonResponse === undefined ? {} : { enableJsonResponse: options.enableJsonResponse })
      });
      res.on('close', () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      // The body is deliberately NOT read here: `handleRequest` wraps
      // `@hono/node-server`'s listener, which builds a Web `Request` from the Node
      // stream — consuming that stream first makes the conversion fail with a 500.
      await transport.handleRequest(req, res);
    })().catch((error: unknown) => {
      process.stderr.write(`sdk-downstream error: ${String(error)}\n`);
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end();
    });
  });

  const host = options.host ?? '127.0.0.1';
  await new Promise<void>((resolve) => httpServer.listen(options.port ?? 0, host, resolve));
  const address = httpServer.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  return {
    url: `http://${host}:${port}/mcp`,
    port,
    invocations,
    reset: () => {
      invocations.length = 0;
    },
    close: () =>
      new Promise<void>((resolve) => {
        httpServer.closeAllConnections();
        httpServer.close(() => resolve());
      }),
    server: httpServer
  };
}
