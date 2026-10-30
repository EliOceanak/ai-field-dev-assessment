/**
 * Tool-call guard: the explicit protocol-level validation layer.
 *
 * ## Why this exists (measured, not guessed)
 *
 * `McpServer.registerTool` *does* validate `arguments` against the Zod shape —
 * but it catches the resulting `McpError` and converts it into a tool result:
 *
 * ```js
 * // node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js:186-192
 * catch (error) {
 *   if (error instanceof McpError && error.code === ErrorCode.UrlElicitationRequired) throw error;
 *   return this.createToolError(error instanceof Error ? error.message : String(error));
 * }
 * ```
 *
 * So the SDK's own layer answers a schema violation with
 * `{ content: [...], isError: true }` and **no** `-32602`. The brief requires
 * "reject invalid formats with standard MCP JSON-RPC error codes", so the guard
 * installs its own `tools/call` handler *after* the tools are registered
 * (`Protocol.setRequestHandler` overwrites, and `McpServer.registerTool` has
 * already installed the SDK's). It validates first, throws
 * `McpToolInputError` (a `McpError` carrying `data.issues[]`) on failure, and
 * only then delegates to the very same handler the SDK has registered.
 *
 * One more measured obstacle: `McpServer.setRequestHandler` **hard-codes** its own
 * validation for `tools/call` and never consults the schema it is given:
 *
 * ```js
 * // node_modules/@modelcontextprotocol/sdk/dist/esm/server/index.js:104-111
 * if (method === 'tools/call') {
 *   const validatedRequest = safeParse(CallToolRequestSchema, request);
 *   if (!validatedRequest.success) {
 *     throw new McpError(ErrorCode.InvalidParams, `Invalid tools/call request: ${errorMessage}`);
 *   }
 *   …
 * }
 * ```
 *
 * That wrapper runs *before* the handler, so a client sending `arguments: null` or a
 * non-string `name` would otherwise receive `-32602` whose `message` is a multi-line Zod dump
 * and whose `data` carries no `issues[]`. Registering through `Protocol` directly (the
 * base class `Server` overrides) skips that wrapper, so this guard owns the whole
 * request-validation story and answers every shape with the same structured envelope.
 *
 * Everything else stays on the SDK: framing, `initialize`, `tools/list`,
 * JSON-RPC error serialization (including `data` and the exact `id` echo) and
 * unknown-method `-32601`.
 *
 * Run `node scripts/probe-sdk-error-shapes.mjs` to reproduce the baseline
 * behaviour side by side with this server's behaviour.
 */
import { CallToolRequestParamsSchema, CallToolRequestSchema, ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { CallToolResult, ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Protocol } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import { z } from 'zod';
import type { CustomerStore } from '../data/store.js';
import type { Logger } from '../logging/logger.js';
import type { ToolContext, ToolDefinition } from '../tools/types.js';
import { McpToolInputError, mapZodError, mcpError } from './errors.js';

/**
 * `tools/call` with the two client-controlled fields loosened to `unknown`.
 *
 * Measured: `setRequestHandler` validates the whole request with the schema it
 * is given *before* the handler runs, and a Zod failure there is serialized as
 * `-32603` carrying the raw Zod message (`shared/protocol.js:414-428`). A client
 * sending `arguments: "nope"` would therefore get an internal error for its own
 * mistake. Loosening exactly those two fields lets the guard answer with
 * `-32602` plus `data.issues[]` instead — and the fields are still fully
 * validated, just one layer further in.
 */
const GuardedCallToolRequestSchema = CallToolRequestSchema.extend({
  params: CallToolRequestParamsSchema.extend({
    name: z.unknown().optional(),
    arguments: z.unknown().optional()
  })
});

export interface ToolCallGuardOptions {
  tools: readonly ToolDefinition[];
  logger: Logger;
  store: CustomerStore;
}

/** Context for one call; also used by the SDK-registered callback, so both paths agree. */
export function createToolContext(
  extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
  options: ToolCallGuardOptions
): ToolContext {
  return {
    logger: options.logger,
    store: options.store,
    reqId: String(extra.requestId ?? 'unknown')
  };
}

export function installToolCallGuard(mcpServer: McpServer, options: ToolCallGuardOptions): void {
  const toolsByName = new Map(options.tools.map((tool) => [tool.name, tool]));

  // Registered on `Protocol` (not `Server`) on purpose — see the module doc: `Server.setRequestHandler`
  // would validate the request against the SDK's own strict schema first and answer a malformed
  // `tools/call` with a raw Zod dump instead of `data.issues[]`.
  Protocol.prototype.setRequestHandler.call(mcpServer.server, GuardedCallToolRequestSchema, async (request, extra) => {
    const reqId = String(extra.requestId ?? 'unknown');
    const rawName: unknown = request.params.name;

    if (typeof rawName !== 'string' || rawName === '') {
      options.logger.child({ reqId, tool: '(missing)' }).warn('tool_rejected', { reason: 'invalid_arguments' });
      throw new McpToolInputError('(missing)', reqId, [
        { path: 'name', message: 'name must be a non-empty string', code: 'invalid_type' }
      ]);
    }

    const toolName = rawName;
    const tool = toolsByName.get(toolName);

    if (tool === undefined) {
      // Measured SDK behaviour for an unknown tool name is `-32602` ("Tool X not
      // found"), which also matches the MCP spec's guidance that an unknown tool
      // is an invalid *parameter*, not an unknown *method*. We keep the code and
      // add the structured payload.
      options.logger.child({ reqId, tool: toolName }).warn('tool_rejected', { reason: 'unknown_tool' });
      throw mcpError(ErrorCode.InvalidParams, 'Invalid params', {
        tool: toolName,
        reqId,
        issues: [{ path: 'name', message: `Unknown tool: ${toolName}`, code: 'unknown_tool' }]
      });
    }

    const log = options.logger.child({ reqId, tool: toolName });
    const rawArguments: unknown = request.params.arguments;
    if (rawArguments !== undefined && (typeof rawArguments !== 'object' || rawArguments === null || Array.isArray(rawArguments))) {
      log.warn('tool_rejected', { reason: 'invalid_arguments_shape' });
      throw new McpToolInputError(toolName, reqId, [
        {
          path: 'arguments',
          message: `arguments must be an object (received ${Array.isArray(rawArguments) ? 'array' : rawArguments === null ? 'null' : typeof rawArguments})`,
          code: 'invalid_type'
        }
      ]);
    }

    const parsed = tool.inputSchema.safeParse(rawArguments ?? {});

    if (!parsed.success) {
      const issues = mapZodError(parsed.error);
      log.warn('tool_rejected', {
        reason: 'invalid_arguments',
        issueCount: issues.length,
        paths: issues.map((issue) => issue.path)
      });
      throw new McpToolInputError(toolName, reqId, issues);
    }

    const args = parsed.data as { customer_id?: unknown; amount?: unknown };
    // Only identifiers and shapes are logged — never the reason text or the
    // whole argument object (they are customer data).
    log.info('tool_called', {
      argumentKeys: Object.keys(parsed.data).sort(),
      customerId: args.customer_id,
      ...(args.amount === undefined ? {} : { amountUsd: args.amount })
    });

    try {
      const result = await tool.handler(parsed.data as Record<string, unknown>, createToolContext(extra, options));
      assertOutput(tool, result, log, reqId);
      return result;
    } catch (error) {
      if (error instanceof McpError) throw error;
      // Unexpected: the client gets a sanitized -32603, the operator gets the
      // real cause (with stack) on stderr, correlated by reqId.
      log.error('tool_failed', { reason: 'unhandled_exception' }, error);
      throw mcpError(ErrorCode.InternalError, 'Internal error', { reqId, tool: toolName });
    }
  });
}


/**
 * Enforce the advertised `outputSchema` on the way out.
 *
 * The SDK's own `validateToolOutput` runs inside the handler the guard
 * replaces, so the guard keeps the check rather than letting `outputSchema`
 * degrade into documentation. A violation is a server bug, not a client error:
 * sanitized `-32603` to the client, full detail on stderr.
 */
function assertOutput(tool: ToolDefinition, result: CallToolResult, log: Logger, reqId: string): void {
  if (result.isError === true || result.structuredContent === undefined) return;
  const parsed = tool.outputSchema.safeParse(result.structuredContent);
  if (!parsed.success) {
    log.error(
      'tool_output_invalid',
      { reason: 'output_schema_mismatch' },
      new Error(JSON.stringify(mapZodError(parsed.error)))
    );
    throw mcpError(ErrorCode.InternalError, 'Internal error', { reqId, tool: tool.name });
  }
}
