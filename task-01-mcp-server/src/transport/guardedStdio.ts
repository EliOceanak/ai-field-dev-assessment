/**
 * Guarded stdio transport: framing errors become protocol-correct responses.
 *
 * ## Why this exists (measured)
 *
 * `StdioServerTransport` frames stdin into newline-delimited JSON and hands each
 * line to `JSONRPCMessageSchema.parse(JSON.parse(line))`. When that throws, the
 * transport reports the failure through `onerror` and — out of the box — sends
 * **nothing** back:
 *
 * ```js
 * // node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js:55-70
 * processReadBuffer() {
 *   while (true) {
 *     try { const message = this._readBuffer.readMessage(); if (message === null) break; this.onmessage?.(message); }
 *     catch (error) { this.onerror?.(error); }   // <- no reply, loop continues
 *   }
 * }
 * ```
 *
 * The spec requires a `-32700` (parse error) or `-32600` (invalid request)
 * response, and the client must be able to tell "your message was malformed"
 * from "the server died". The guard therefore wraps the SDK transport, maps the
 * thrown error to the right code, replies with `id: null`, and leaves the
 * reading loop untouched so the process keeps serving.
 *
 * The error *message* is never forwarded or logged: `JSON.parse` errors quote the
 * offending input, and stdin carries customer data.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Readable, Writable } from 'node:stream';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage, MessageExtraInfo } from '@modelcontextprotocol/sdk/types.js';
import type { Logger } from '../logging/logger.js';
import { ErrorCode, jsonRpcError } from '../protocol/errors.js';

export interface GuardedStdioOptions {
  /** Defaults to the process stdin stream. */
  stdin?: Readable;
  /** Defaults to the process stdout stream — the one stream reserved for protocol bytes. */
  stdout?: Writable;
  logger: Logger;
}

export type FramingErrorCode = typeof ErrorCode.ParseError | typeof ErrorCode.InvalidRequest;

export interface FramingFailure {
  code: FramingErrorCode;
  message: string;
}

/**
 * Classify what the SDK's read buffer threw.
 *
 * - `SyntaxError` → the line is not JSON at all → `-32700` parse error.
 * - anything carrying Zod's `issues[]` → valid JSON, invalid JSON-RPC envelope
 *   (missing `jsonrpc`, non-object `params`, unknown top-level key, …) → `-32600`.
 */
export function classifyFramingError(error: unknown): FramingFailure | undefined {
  if (error instanceof SyntaxError) {
    return { code: ErrorCode.ParseError, message: 'Parse error' };
  }
  if (typeof error === 'object' && error !== null && Array.isArray((error as { issues?: unknown }).issues)) {
    return { code: ErrorCode.InvalidRequest, message: 'Invalid Request' };
  }
  return undefined;
}

export class GuardedStdioTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage, extra?: MessageExtraInfo) => void;

  private readonly inner: StdioServerTransport;
  private readonly logger: Logger;

  constructor(options: GuardedStdioOptions) {
    this.logger = options.logger;
    this.inner = new StdioServerTransport(options.stdin, options.stdout);
    // The Protocol replaces the callbacks of the transport it is given (this
    // wrapper), so the SDK transport's own callbacks stay ours.
    this.inner.onmessage = (message) => this.onmessage?.(message);
    this.inner.onclose = () => this.onclose?.();
    this.inner.onerror = (error) => this.handleFramingError(error);
  }

  async start(): Promise<void> {
    await this.inner.start();
  }

  async close(): Promise<void> {
    await this.inner.close();
  }

  send(message: JSONRPCMessage): Promise<void> {
    return this.inner.send(message);
  }

  private handleFramingError(error: Error): void {
    const failure = classifyFramingError(error);
    if (failure === undefined) {
      this.onerror?.(error);
      return;
    }

    // Only the error *class* is logged; the message may quote the raw line.
    this.logger.warn('jsonrpc_framing_error', {
      code: failure.code,
      kind: error.name,
      response: 'id:null'
    });

    void this.send(jsonRpcError({ id: null, code: failure.code, message: failure.message }) as JSONRPCMessage);
  }
}

/** Wire the real process streams. The transport is the only stdout writer. */
export function createStdioTransport(logger: Logger, streams: Omit<GuardedStdioOptions, 'logger'> = {}): GuardedStdioTransport {
  // stdout is reserved for JSON-RPC frames; handing the stream to the transport
  // here is the single, deliberate exception to the static stdout guard.
  // stdout-guard: allow
  const stdout = streams.stdout ?? process.stdout;
  const stdin = streams.stdin ?? process.stdin;
  return new GuardedStdioTransport({ stdin, stdout, logger });
}
