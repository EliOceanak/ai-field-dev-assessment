/**
 * Error contracts for the MCP surface.
 *
 * Two distinct failure planes, kept deliberately apart (this is the single most
 * common MCP mistake):
 *
 *   | Plane                       | Shape                                            |
 *   | --------------------------- | ------------------------------------------------ |
 *   | Protocol / schema violation | JSON-RPC `error` object, `-32602` + `data.issues[]` |
 *   | Domain outcome              | `CallToolResult` with `isError: true`            |
 *
 * A refund that exceeds the balance is a *legitimate answer* the model must be
 * able to read and reason about, so it is a tool result. Arguments that do not
 * satisfy the advertised schema are a *protocol* violation, so they are a
 * JSON-RPC error. See the README ("Design notes") for the measured SDK
 * behaviour that forced the explicit validation layer.
 */
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { z } from 'zod';

export { ErrorCode };

/** One field-level validation problem, addressed by JSON path. */
export interface JsonRpcIssue {
  /** Dotted path of the offending argument, `'(root)'` for the object itself. */
  path: string;
  /** Stable, human-readable reason. */
  message: string;
  /** Zod issue code (`invalid_type`, `too_small`, `unrecognized_keys`, …). */
  code: string;
}

/** JSON-RPC 2.0 error response, `id: null` when the id could not be determined. */
export interface JsonRpcErrorResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

/** `data` payload of a `-32602` response produced by the tool-call guard. */
export interface InvalidParamsData {
  tool?: string;
  reqId: string;
  issues: JsonRpcIssue[];
}

/**
 * Convert Zod issues into the `data.issues[]` contract.
 *
 * `unrecognized_keys` issues carry no path, so the offending key names are used
 * as the path — otherwise a reviewer sees `(root): Unrecognized key: "x"` and
 * has to guess which key is meant.
 */
export function mapZodError(error: z.ZodError): JsonRpcIssue[] {
  return error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.map(String).join('.') : '(root)';
    const keys = 'keys' in issue && Array.isArray(issue.keys) ? issue.keys : undefined;
    return {
      path: keys !== undefined && issue.path.length === 0 ? keys.join(', ') : path,
      message: issue.message,
      code: issue.code
    };
  });
}

/** Build a JSON-RPC error envelope (used by the transport-level guard). */
export function jsonRpcError(input: {
  id: string | number | null;
  code: number;
  message: string;
  data?: unknown;
}): JsonRpcErrorResponse {
  return {
    jsonrpc: '2.0',
    id: input.id,
    error: {
      code: input.code,
      message: input.message,
      ...(input.data === undefined ? {} : { data: input.data })
    }
  };
}

/**
 * Build an `McpError` whose wire `message` is *exactly* `message`.
 *
 * `new McpError(code, message)` sets `Error.message` to
 * `` `MCP error ${code}: ${message}` `` (see `types.js`). The SDK's own
 * `-32601` response is a plain `"Method not found"`, and the repository-wide
 * error contract specifies exactly
 * `"Invalid params"` / `"Internal error"`, so the prefix is stripped here.
 * The JSON-RPC `code` is unchanged, and `instanceof McpError` still holds.
 */
export function mcpError(code: number, message: string, data?: unknown): McpError {
  const error = new McpError(code, message, data);
  error.message = message;
  return error;
}

/**
 * Raised by the validation layer when `arguments` do not satisfy the tool's
 * advertised schema. Serialized by the SDK into a `-32602` JSON-RPC error.
 */
export class McpToolInputError extends McpError {
  constructor(tool: string, reqId: string, issues: JsonRpcIssue[]) {
    super(ErrorCode.InvalidParams, 'Invalid params', { tool, reqId, issues } satisfies InvalidParamsData);
    this.name = 'McpToolInputError';
    this.message = 'Invalid params';
  }
}

/** Domain failure code carried by a tool-level (`isError: true`) result. */
export type DomainErrorCode = 'customer_not_found' | 'insufficient_funds' | 'unknown_error';

/**
 * Thrown by the data layer for expected, non-exceptional outcomes (unknown
 * customer, insufficient funds). The tool handler converts it into a tool-level
 * error result — never into a JSON-RPC error.
 */
export class DomainError extends Error {
  readonly code: DomainErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: DomainErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.details = details;
  }
}

/**
 * Build the `isError: true` tool result for a domain failure.
 *
 * The text block is a JSON document rather than prose so that both a model and
 * a test can read the machine-readable `code` without parsing English.
 */
export function toolError(code: DomainErrorCode, message: string, details: Record<string, unknown> = {}): CallToolResult {
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: JSON.stringify({ error: { code, message, ...details } }, null, 2)
      }
    ]
  };
}

/** Build the success result: a readable text block plus machine-readable structure. */
export function toolResult<T extends Record<string, unknown>>(payload: T): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload
  };
}
