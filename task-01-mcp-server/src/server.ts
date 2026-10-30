/**
 * Server assembly and process lifecycle.
 *
 * Responsibilities are deliberately narrow:
 *   - `buildServer()` wires the SDK (`McpServer` + registered tools), the
 *     validation guard and the stderr logger. It performs no I/O, so tests can
 *     drive it over an in-memory transport.
 *   - `main()` owns the process: config, stdio transport, signal handling and
 *     graceful shutdown. Nothing else may write to stdout.
 */
import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js';
import { getConfig } from './config.js';
import type { ServerConfig } from './config.js';
import { createStore, store as processStore } from './data/store.js';
import type { CustomerStore } from './data/store.js';
import { createLogger } from './logging/logger.js';
import type { Logger } from './logging/logger.js';
import { createToolContext, installToolCallGuard } from './protocol/toolCallGuard.js';
import { TOOLS } from './tools/index.js';
import { createStdioTransport } from './transport/guardedStdio.js';

export const SERVER_INSTRUCTIONS =
  'Customer operations server. Use get_customer_record to read a customer (id format CUST-XXXXX) and ' +
  'trigger_refund to refund an amount against that customer balance. Invalid arguments are rejected as ' +
  'JSON-RPC -32602; business outcomes such as an insufficient balance are returned as isError tool results.';

export interface BuildServerOptions {
  config?: ServerConfig;
  logger?: Logger;
  store?: CustomerStore;
}

/**
 * Build the MCP server: two tools, strict schemas, guard installed.
 *
 * Returned as an `McpServer` so callers can `connect()` any transport; the
 * process-level concerns live in `main()`.
 */
export function buildServer(options: BuildServerOptions = {}): McpServer {
  const config = options.config ?? getConfig();
  const logger =
    options.logger ?? createLogger({ level: config.logLevel, base: { server: config.serverName } });
  const store = options.store ?? processStore;

  const server = new McpServer(
    { name: config.serverName, version: config.serverVersion },
    { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS }
  );
  const guardOptions = { tools: TOOLS, logger, store };

  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        outputSchema: tool.outputSchema,
        annotations: tool.annotations
      },
      // Same handler, same context builder as the guard below: whichever layer
      // dispatches, the behaviour is identical.
      (args: Record<string, unknown>, extra: RequestHandlerExtra<ServerRequest, ServerNotification>) =>
        Promise.resolve(tool.handler(args, createToolContext(extra, guardOptions)))
    );
  }

  // Registered last: it replaces the SDK's own `tools/call` handler so schema
  // violations stay JSON-RPC errors instead of becoming `isError` results.
  installToolCallGuard(server, guardOptions);

  return server;
}

/** Create an isolated server + store pair (tests and demos). */
export function createIsolatedServer(options: Omit<BuildServerOptions, 'store'> = {}): {
  server: McpServer;
  store: CustomerStore;
} {
  const store = createStore();
  return { server: buildServer({ ...options, store }), store };
}

/**
 * Process entry point: stdio transport, lifecycle, graceful shutdown.
 *
 * Shutdown rules (each one is a real failure mode in a stdio MCP server):
 *   - never `process.exit()` while stdout still has buffered frames;
 *   - stdin EOF, SIGINT and SIGTERM all close the transport, flush, and exit 0;
 *   - a second signal is ignored while the first shutdown is in flight.
 */
export interface ShutdownHandle {
  /** Resolves once the transport is closed and stdout is flushed. */
  shutdown(reason: string): Promise<void>;
}

export function installShutdownHandlers(
  server: McpServer,
  logger: Logger,
  streams: { stdin: NodeJS.ReadableStream }
): ShutdownHandle {
  let shuttingDown: Promise<void> | undefined;

  const shutdown = (reason: string): Promise<void> => {
    shuttingDown ??= (async () => {
      logger.info('server_stopping', { reason });
      // `server.close()` → transport.close(): removes the stdin listeners,
      // pauses stdin, clears the read buffer and flushes pending writes
      // (`StdioServerTransport.send` awaits `drain` when the pipe is full).
      await server.close();
      logger.info('server_stopped', { reason });
      process.exitCode = 0;

      // Belt and braces: if a dependency still holds the event loop open, leave
      // anyway. `unref()` means a clean process exits naturally first.
      setTimeout(() => process.exit(0), 250).unref();
    })();
    return shuttingDown;
  };

  streams.stdin.on('end', () => void shutdown('stdin_eof'));
  streams.stdin.on('close', () => void shutdown('stdin_close'));
  process.on('SIGINT', () => void shutdown('sigint'));
  process.on('SIGTERM', () => void shutdown('sigterm'));

  return { shutdown };
}

/** Boot the server on stdio. Resolves when the process is shutting down. */
export async function main(): Promise<void> {
  const config = getConfig();
  const logger = createLogger({
    level: config.logLevel,
    base: { server: config.serverName, pid: process.pid }
  });

  const server = buildServer({ config, logger });
  const transport = createStdioTransport(logger);
  await server.connect(transport);

  logger.info('server_started', {
    version: config.serverVersion,
    transport: 'stdio',
    tools: TOOLS.map((tool) => tool.name),
    logLevel: config.logLevel
  });

  installShutdownHandlers(server, logger, { stdin: process.stdin });
}

const entryPoint = process.argv[1];
const invokedDirectly = entryPoint !== undefined && import.meta.url === pathToFileURL(entryPoint).href;

if (invokedDirectly) {
  main().catch((error: unknown) => {
    // The logger may not exist yet (invalid config), and stderr is always safe.
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${JSON.stringify({ level: 'error', event: 'server_failed_to_start', message })}\n`);
    process.exit(1);
  });
}
