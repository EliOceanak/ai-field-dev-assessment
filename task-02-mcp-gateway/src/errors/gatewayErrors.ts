/**
 * Error contracts for the gateway's MCP surface.
 *
 * Two failure planes, kept deliberately apart — this is the split the README's
 * status-contract table makes authoritative:
 *
 *   | Plane                          | HTTP | Shape                                        |
 *   | ------------------------------ | ---- | -------------------------------------------- |
 *   | Transport authentication       | 401  | `WWW-Authenticate` + JSON-RPC `-32600`       |
 *   | Application policy denial      | 200  | JSON-RPC `-32001` (the *answer* to a call)   |
 *   | Protocol violation (envelope)  | 400  | JSON-RPC `-32700` / `-32600`                 |
 *   | Gateway-side upstream failure  | 502/504 | sanitized JSON-RPC `-32603`               |
 *
 * `-32001` is used even though the `2026-07-28` MCP revision marks
 * `-32000 … -32019` as a legacy sub-range: the brief mandates that exact code and
 * existing MCP clients already read it as "unauthorized tool call". No new codes
 * are invented anywhere in this package (see `docs/SDK-AND-PROTOCOL-NOTES.md`).
 */

/** The only JSON-RPC codes this gateway ever emits. */
export const JsonRpcErrorCode = {
  /** Body is not JSON. */
  ParseError: -32700,
  /** Body is JSON but not a valid JSON-RPC 2.0 envelope (also: failed authentication). */
  InvalidRequest: -32600,
  /** Unknown method / unknown tool — normally the *downstream's* answer, forwarded as-is. */
  MethodNotFound: -32601,
  /** Schema validation failure. */
  InvalidParams: -32602,
  /** Unexpected internal failure, sanitized. */
  InternalError: -32603,
  /** Task 2 only: unauthorized tool call (brief-mandated). */
  UnauthorizedToolCall: -32001
} as const;

export type JsonRpcErrorCodeValue = (typeof JsonRpcErrorCode)[keyof typeof JsonRpcErrorCode];

/** A JSON-RPC request id. `null` when the id could not be determined. */
export type RequestId = string | number | null;

/** JSON-RPC 2.0 error response. */
export interface JsonRpcErrorResponse {
  jsonrpc: '2.0';
  id: RequestId;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

/** `data` payload of a `-32001` denial. */
export interface UnauthorizedToolData {
  tool: string;
  required_role: string;
  reason: string;
}

/** Build a JSON-RPC error envelope. `data` is omitted entirely when undefined. */
export function jsonRpcError(input: {
  id: RequestId;
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
 * HTTP status for a locally generated JSON-RPC error.
 *
 * `-32001` maps to **200** on purpose: the HTTP exchange succeeded and the
 * gateway answered the `tools/call` — the caller is merely not allowed to use
 * that tool. A 403 here would break MCP clients that treat any non-2xx as a
 * transport failure and never surface the JSON-RPC error to the model.
 */
export function httpStatusFor(code: number): number {
  switch (code) {
    case JsonRpcErrorCode.ParseError:
    case JsonRpcErrorCode.InvalidRequest:
    case JsonRpcErrorCode.InvalidParams:
      return 400;
    case JsonRpcErrorCode.MethodNotFound:
      return 404;
    case JsonRpcErrorCode.InternalError:
      return 500;
    case JsonRpcErrorCode.UnauthorizedToolCall:
      return 200;
    default:
      return 500;
  }
}

/** Reasons an error message may be replaced with something generic. */
const LEAK_PATTERNS = [
  /https?:\/\/[^\s"'`]+/gi, // downstream URL / provider host
  /\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g, // host:port
  /\bat\s+[^\s]+\s+\([^)]*\)/g, // stack frame
  /\b[A-Za-z]:\\[^\s]+/g, // windows path
  /\/[\w./-]*\/(?:src|dist|node_modules)\/[\w./-]+/g, // posix path
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/-]+=*/gi, // credentials
  /\b(?:sk|pk|ghp|eyJ)[A-Za-z0-9._-]{8,}/g // token-ish strings
];

/**
 * Reduce an arbitrary thrown value to a short, non-leaking message.
 *
 * Upstream bodies, URLs, hostnames, file paths and stack traces must never reach
 * a client. Anything longer than 200
 * characters, or matching a leak pattern, is replaced by the generic fallback.
 */
export function sanitizeMessage(error: unknown, fallback = 'Internal error'): string {
  const raw =
    error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed.length > 200) return fallback;
  if (LEAK_PATTERNS.some((pattern) => pattern.test(trimmed))) return fallback;
  return trimmed;
}

/** Machine-readable `data` for a sanitized internal error, so a client can correlate logs. */
export function internalErrorData(reqId: string): { reqId: string } {
  return { reqId };
}
