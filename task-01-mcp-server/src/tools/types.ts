/**
 * Shared tool-registration types.
 *
 * A `ToolDefinition` is the single source of truth for one tool: the metadata
 * advertised by `tools/list`, the Zod schemas that are enforced, and the
 * handler that runs. `src/server.ts` hands the same object to
 * `McpServer.registerTool` (advertisement + SDK bookkeeping) and to the
 * tool-call guard in `src/protocol/toolCallGuard.ts` (enforcement).
 */
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { z } from 'zod';
import type { CustomerStore } from '../data/store.js';
import type { Logger } from '../logging/logger.js';

/** Per-call context handed to every tool handler. */
export interface ToolContext {
  /** Request-scoped logger (already bound to `reqId` and `tool`). */
  logger: Logger;
  /** Store the handler must use — injected, never imported, so tests can isolate state. */
  store: CustomerStore;
  /** Correlation id: identical in the JSON-RPC error `data` and the stderr log line. */
  reqId: string;
}

export interface ToolDefinition<Args extends Record<string, unknown> = Record<string, unknown>> {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  /** Strict object schema; also the source of the advertised JSON Schema. */
  readonly inputSchema: z.ZodObject<z.ZodRawShape>;
  /** Strict object schema for `structuredContent`, advertised as `outputSchema`. */
  readonly outputSchema: z.ZodObject<z.ZodRawShape>;
  /** MCP tool annotations advertised in `tools/list` (read-only, destructive, …). */
  readonly annotations: ToolAnnotations;
  handler(args: Args, ctx: ToolContext): Promise<CallToolResult> | CallToolResult;
}
