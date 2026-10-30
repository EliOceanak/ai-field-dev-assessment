/**
 * JSON-RPC 2.0 wire-format parsing for the gateway.
 *
 * The body is parsed **exactly once** and the original text is kept alongside the
 * parsed value. Two behaviours depend on that:
 *
 *  - a request that needs no modification is forwarded **byte-identically** (the raw
 *    text is the upstream body), and
 *  - a body that is not JSON at all can still be told apart from a body that is JSON
 *    but not a JSON-RPC envelope (`-32700` vs `-32600`).
 *
 * Forwarding the original text has one precondition: the gateway and the downstream must
 * read the same request out of it. A body whose objects repeat a key breaks that (see
 * `findDuplicateKey`), so it is refused with `-32600` before any policy decision.
 *
 * Nothing in this module performs I/O, so every branch is unit-testable.
 */
import { JsonRpcErrorCode, jsonRpcError, httpStatusFor } from '../errors/gatewayErrors.js';
import type { JsonRpcErrorResponse, RequestId } from '../errors/gatewayErrors.js';

export interface JsonRpcRequestMessage {
  jsonrpc: '2.0';
  id: RequestId;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotificationMessage {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

export type JsonRpcMessage = JsonRpcRequestMessage | JsonRpcNotificationMessage;

/** An element of a batch that failed envelope validation, with its original position. */
export interface InvalidElement {
  index: number;
  error: JsonRpcErrorResponse;
}

export type ParsedBody =
  | { kind: 'single'; message: JsonRpcMessage; text: string }
  | {
      kind: 'batch';
      /** Valid messages, in order. */
      messages: JsonRpcMessage[];
      /** Valid messages paired with their original batch position. */
      entries: { index: number; message: JsonRpcMessage }[];
      /** Elements that failed envelope validation, with their original position. */
      invalid: InvalidElement[];
      /** Length of the original array (positions that must appear in the merged response). */
      total: number;
      text: string;
    }
  | { kind: 'error'; status: number; error: JsonRpcErrorResponse };

/** Default body cap (1 MiB) — mirrors `GATEWAY_MAX_BODY_BYTES`. */
export const DEFAULT_MAX_BODY_BYTES = 1_048_576;

/**
 * A notification carries no `id` (JSON-RPC 2.0 §4.1).
 *
 * Deliberately *not* a type predicate: `JsonRpcRequestMessage` is structurally
 * assignable to `JsonRpcNotificationMessage`, so an `in`-based predicate would
 * narrow the negative branch to `never`. Use `requestIdOf()` to read the id.
 */
export function isNotification(message: JsonRpcMessage): boolean {
  return !('id' in message);
}

/** The `id` of a request, or `undefined` for a notification. */
export function requestIdOf(message: JsonRpcMessage): RequestId | undefined {
  return 'id' in message ? (message as JsonRpcRequestMessage).id : undefined;
}

/** The `id` to echo: only string/number/null are legal, anything else becomes `null`. */
function idOf(value: Record<string, unknown>): RequestId {
  const id = value.id;
  if (typeof id === 'string' || typeof id === 'number') return id;
  return null;
}

function invalidRequest(id: RequestId, message: string, data?: unknown): JsonRpcErrorResponse {
  return jsonRpcError({
    id,
    code: JsonRpcErrorCode.InvalidRequest,
    message,
    ...(data === undefined ? {} : { data })
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export type ElementResult =
  | { ok: true; message: JsonRpcMessage }
  | { ok: false; error: JsonRpcErrorResponse };

/**
 * Validate one JSON-RPC message.
 *
 * Deliberately strict about the envelope and permissive about everything else:
 * `params` is forwarded untouched (the *downstream* owns tool-level schema
 * validation), and an unknown `method` is forwarded so the downstream can answer
 * `-32601` itself. See the README design notes.
 */
export function validateElement(value: unknown): ElementResult {
  if (!isPlainObject(value)) {
    return { ok: false, error: invalidRequest(null, 'Invalid request') };
  }
  if (value.jsonrpc !== '2.0') {
    return { ok: false, error: invalidRequest(idOf(value), 'Invalid request') };
  }
  if (typeof value.method !== 'string' || value.method === '') {
    return { ok: false, error: invalidRequest(idOf(value), 'Invalid request') };
  }
  if ('id' in value && !(typeof value.id === 'string' || typeof value.id === 'number' || value.id === null)) {
    return { ok: false, error: invalidRequest(null, 'Invalid request') };
  }
  if ('params' in value && value.params !== undefined && !isPlainObject(value.params) && !Array.isArray(value.params)) {
    return { ok: false, error: invalidRequest(idOf(value), 'Invalid request', { field: 'params' }) };
  }

  const params = value.params === undefined ? {} : { params: value.params };
  if (!('id' in value)) return { ok: true, message: { jsonrpc: '2.0', method: value.method, ...params } };
  return { ok: true, message: { jsonrpc: '2.0', id: idOf(value), method: value.method, ...params } };
}

/** `-32700` — the body is not JSON. */
export function parseError(data?: unknown): ParsedBody {
  return {
    kind: 'error',
    status: 400,
    error: jsonRpcError({
      id: null,
      code: JsonRpcErrorCode.ParseError,
      message: 'Parse error',
      ...(data === undefined ? {} : { data })
    })
  };
}

/** `-32600` — the body is JSON but not a valid JSON-RPC 2.0 envelope. */
export function envelopeError(message = 'Invalid request', data?: unknown): ParsedBody {
  return {
    kind: 'error',
    status: 400,
    error: jsonRpcError({
      id: null,
      code: JsonRpcErrorCode.InvalidRequest,
      message,
      ...(data === undefined ? {} : { data })
    })
  };
}

/**
 * The first key that appears twice in the same JSON object, or `undefined`.
 *
 * RFC 8259 §4 leaves duplicate names undefined: `JSON.parse` keeps the last one, other parsers keep
 * the first or reject the object. Because the downstream parses the *original text*,
 * `{"method":"tools/call","method":"tools/list",…}` would be authorized here as `tools/list` and
 * could run downstream as `tools/call`. Refusing duplicates removes the ambiguity instead of betting
 * on the downstream's parser.
 *
 * Only called on text `JSON.parse` has already accepted, so it only has to track strings and
 * nesting. Keys are compared after unescaping: `"method"` is `"method"`.
 */
export function findDuplicateKey(text: string): string | undefined {
  // One entry per open container: the keys seen so far for an object, `null` for an array.
  const open: (Set<string> | null)[] = [];
  let keyNext = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"') {
      let end = index + 1;
      while (end < text.length && text[end] !== '"') end += text[end] === '\\' ? 2 : 1;
      const keys = open[open.length - 1];
      if (keyNext && keys) {
        const key = JSON.parse(text.slice(index, end + 1)) as string;
        if (keys.has(key)) return key;
        keys.add(key);
      }
      keyNext = false;
      index = end;
    } else if (char === '{') {
      open.push(new Set());
      keyNext = true;
    } else if (char === '[') {
      open.push(null);
      keyNext = false;
    } else if (char === '}' || char === ']') {
      open.pop();
      keyNext = false;
    } else if (char === ',') {
      keyNext = open[open.length - 1] instanceof Set;
    }
  }
  return undefined;
}

/** Parse + validate a request body that has already been read as text. */
export function parseJsonRpcBody(text: string): ParsedBody {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return parseError();
  }

  // Before anything reads the envelope: an ambiguous body is refused whole, batch or not.
  const duplicate = findDuplicateKey(text);
  if (duplicate !== undefined) {
    return envelopeError('Invalid request', { reason: 'duplicate_key', key: duplicate.slice(0, 64) });
  }

  if (Array.isArray(value)) {
    // JSON-RPC 2.0: an empty array is not a valid batch — answer with one object.
    if (value.length === 0) return envelopeError('Invalid request: empty batch');

    const messages: JsonRpcMessage[] = [];
    const entries: { index: number; message: JsonRpcMessage }[] = [];
    const invalid: InvalidElement[] = [];
    value.forEach((element, index) => {
      const result = validateElement(element);
      if (result.ok) {
        messages.push(result.message);
        entries.push({ index, message: result.message });
      } else {
        invalid.push({ index, error: result.error });
      }
    });

    // A batch with no valid element at all is an envelope failure, not an answer.
    if (messages.length === 0) {
      const first = invalid[0];
      return {
        kind: 'error',
        status: httpStatusFor(JsonRpcErrorCode.InvalidRequest),
        error: first?.error ?? invalidRequest(null, 'Invalid request')
      };
    }

    return { kind: 'batch', messages, entries, invalid, total: value.length, text };
  }

  const result = validateElement(value);
  if (!result.ok) {
    return { kind: 'error', status: httpStatusFor(JsonRpcErrorCode.InvalidRequest), error: result.error };
  }

  return { kind: 'single', message: result.message, text };
}

/** Serialize messages back into a JSON-RPC body (only needed when a batch is modified). */
export function serializeMessages(messages: readonly JsonRpcMessage[]): string {
  return JSON.stringify(messages);
}

