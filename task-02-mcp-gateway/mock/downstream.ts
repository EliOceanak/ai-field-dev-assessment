/**
 * Mock downstream MCP server (JSON-RPC 2.0 over HTTP) with **call recording**.
 *
 * The recorder is the point: the decisive proof for this task is not that a denial
 * *looks* right, but that the downstream never saw the request. Every test asserts
 * against `calls` (or `GET /__calls` when the mock runs as its own process, which is
 * how `scripts/demo.mjs` drives it).
 *
 * Tools: `get_customer_record`, `trigger_refund`, `admin_reset_key`,
 * `admin_list_tenants`.
 *
 * Mock-only control methods (deliberately outside the MCP namespace, so the gateway
 * forwards them as ordinary unknown methods — which is itself a tested behaviour):
 *
 *   `mock/echo`   → `{ headers, rawBody }` for header-hygiene assertions
 *   `mock/slow`   → sleeps `params.delayMs` before answering (timeout tests)
 *   `mock/stream` → `text/event-stream`, one frame every `params.delayMs` (SSE tests)
 */
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { pathToFileURL } from 'node:url';

export interface RecordedCall {
  method: string;
  tool?: string;
  id?: string | number | null;
  notification: boolean;
  rawBody: string;
  headers: Record<string, string | string[] | undefined>;
  receivedAt: number;
}

export interface MockDownstream {
  url: string;
  port: number;
  calls: RecordedCall[];
  reset(): void;
  close(): Promise<void>;
  server: Server;
}

export interface MockDownstreamOptions {
  port?: number;
  host?: string;
  /**
   * Reverse a batch response array before sending it.
   *
   * JSON-RPC explicitly allows the response array to be in any order, so this lets a
   * test prove the gateway merges results by `id` rather than by position.
   */
  shuffleBatchResponses?: boolean;
}

const TOOL_DEFINITIONS = [
  {
    name: 'get_customer_record',
    title: 'Get customer record',
    description: 'Read a customer record by id (format CUST-XXXXX).',
    inputSchema: {
      type: 'object',
      properties: { customer_id: { type: 'string', pattern: '^CUST-[0-9]{5}$' } },
      required: ['customer_id'],
      additionalProperties: false
    }
  },
  {
    name: 'trigger_refund',
    title: 'Trigger refund',
    description: 'Refund an amount against a customer balance.',
    inputSchema: {
      type: 'object',
      properties: {
        customer_id: { type: 'string' },
        amount: { type: 'number', exclusiveMinimum: 0 },
        reason: { type: 'string', minLength: 10 }
      },
      required: ['customer_id', 'amount', 'reason'],
      additionalProperties: false
    }
  },
  {
    name: 'admin_reset_key',
    title: 'Reset API key (admin)',
    description: 'Rotate the API key for a customer. Requires the admin role.',
    inputSchema: {
      type: 'object',
      properties: { customer_id: { type: 'string' } },
      required: ['customer_id'],
      additionalProperties: false
    }
  },
  {
    name: 'admin_list_tenants',
    title: 'List tenants (admin)',
    description: 'List every tenant on the platform. Requires the admin role.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  }
] as const;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function jsonRpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id === undefined ? null : id, result };
}

function jsonRpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id === undefined ? null : id, error: { code, message } };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function runTool(name: string, args: Record<string, unknown>): unknown {
  switch (name) {
    case 'get_customer_record':
      return {
        content: [{ type: 'text', text: `customer ${String(args.customer_id)}` }],
        structuredContent: { customer_id: args.customer_id, name: 'Ada Lovelace', balance: 125.5 }
      };
    case 'trigger_refund':
      return {
        content: [{ type: 'text', text: 'refund accepted' }],
        structuredContent: { refund_id: 'RFD-00001', amount: args.amount }
      };
    case 'admin_reset_key':
      return {
        content: [{ type: 'text', text: 'key rotated' }],
        structuredContent: { rotated: true, customer_id: args.customer_id }
      };
    case 'admin_list_tenants':
      return { content: [{ type: 'text', text: 'tenants' }], structuredContent: { tenants: ['acme'] } };
    default:
      return null;
  }
}

export async function startMockDownstream(options: MockDownstreamOptions = {}): Promise<MockDownstream> {
  const calls: RecordedCall[] = [];

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://mock.local');

    if (req.method === 'GET' && url.pathname === '/__calls') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ count: calls.length, calls: calls.map((c) => ({ method: c.method, tool: c.tool })) }));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/__reset') {
      calls.length = 0;
      res.writeHead(204).end();
      return;
    }
    if (req.method !== 'POST' || url.pathname !== '/mcp') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
      return;
    }

    const rawBody = await readBody(req);
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify(jsonRpcError(null, -32700, 'Parse error')));
      return;
    }

    const messages = Array.isArray(parsed) ? parsed : [parsed];
    const responses: unknown[] = [];

    for (const message of messages) {
      const record = (typeof message === 'object' && message !== null ? message : {}) as Record<string, unknown>;
      const method = typeof record.method === 'string' ? record.method : '';
      const params = (typeof record.params === 'object' && record.params !== null ? record.params : {}) as Record<
        string,
        unknown
      >;
      const id = record.id as string | number | null | undefined;
      const notification = !('id' in record);

      calls.push({
        method,
        ...(typeof params.name === 'string' ? { tool: params.name } : {}),
        ...(notification ? {} : { id: id ?? null }),
        notification,
        rawBody,
        headers: req.headers,
        receivedAt: Date.now()
      });

      // `mock/stream` writes straight to the socket: no JSON-RPC response envelope.
      if (method === 'mock/stream') {
        const frames = typeof params.frames === 'number' ? params.frames : 3;
        const delayMs = typeof params.delayMs === 'number' ? params.delayMs : 10;
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive'
        });
        for (let index = 0; index < frames; index += 1) {
          res.write(`event: frame\ndata: ${JSON.stringify({ index })}\n\n`);
          await sleep(delayMs);
        }
        res.write(`event: done\ndata: ${JSON.stringify(jsonRpcResult(id, { frames }))}\n\n`);
        res.end();
        return;
      }

      if (method === 'mock/slow') {
        await sleep(typeof params.delayMs === 'number' ? params.delayMs : 50);
        if (!notification) responses.push(jsonRpcResult(id, { slept: params.delayMs ?? 50 }));
        continue;
      }

      if (method === 'mock/echo') {
        if (!notification) {
          responses.push(jsonRpcResult(id, { headers: req.headers, rawBody, bytesIn: Buffer.byteLength(rawBody) }));
        }
        continue;
      }

      if (method === 'tools/list') {
        if (!notification) responses.push(jsonRpcResult(id, { tools: TOOL_DEFINITIONS }));
        continue;
      }

      if (method === 'tools/call') {
        const name = typeof params.name === 'string' ? params.name : '';
        const args = (typeof params.arguments === 'object' && params.arguments !== null
          ? params.arguments
          : {}) as Record<string, unknown>;
        if (!TOOL_DEFINITIONS.some((tool) => tool.name === name)) {
          if (!notification) responses.push(jsonRpcError(id, -32601, 'Method not found'));
          continue;
        }
        if (!notification) responses.push(jsonRpcResult(id, runTool(name, args)));
        continue;
      }

      if (notification) continue;
      responses.push(jsonRpcError(id, -32601, 'Method not found'));
    }

    if (responses.length === 0) {
      res.writeHead(202, { 'content-type': 'application/json' });
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    const payload = Array.isArray(parsed) ? responses : responses[0];
    res.end(JSON.stringify(options.shuffleBatchResponses === true && Array.isArray(payload) ? [...payload].reverse() : payload));
  }

  const server = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end();
    });
  });

  const host = options.host ?? '127.0.0.1';
  await new Promise<void>((resolve) => server.listen(options.port ?? 0, host, resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  return {
    url: `http://${host}:${port}/mcp`,
    port,
    calls,
    reset: () => {
      calls.length = 0;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
    server
  };
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const mock = await startMockDownstream({ port: Number(process.env.MOCK_PORT ?? 8788) });
  // stdout is fine here: only `src/` is scanned by scripts/check-logging-hygiene.mjs.
  // The line is machine-readable so the demo can discover an ephemeral port.
  console.log(JSON.stringify({ event: 'mock_listening', url: mock.url, port: mock.port }));
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      void mock.close().then(() => process.exit(0));
    });
  }
}
