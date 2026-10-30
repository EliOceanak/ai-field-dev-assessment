/**
 * Test helper: drive the *real* server process over a real stdio pipe.
 *
 * Not a test file — `vitest.config.ts` only picks up `*.test.ts`. Every wire
 * suite spawns the production entry point (`tsx src/server.ts`) so that stdout
 * isolation, JSON-RPC framing and shutdown behaviour are observed, not
 * simulated.
 */
import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const SERVER_ENTRY = resolve(PACKAGE_ROOT, 'src/server.ts');

export interface JsonRpcResponse {
  jsonrpc?: string;
  id?: string | number | null;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
}

export interface McpProcess {
  /** Send one request and resolve with the response carrying the same id. */
  request(method: string, params?: unknown, id?: string | number): Promise<JsonRpcResponse>;
  /** Send a notification (no response expected). */
  notify(method: string, params?: unknown): void;
  /** Write a raw line — used for malformed input. */
  raw(line: string): void;
  /** Every stdout line, verbatim (including anything that is not JSON). */
  stdoutLines(): string[];
  /** Every stderr line, verbatim. */
  stderrLines(): string[];
  /** Parsed stderr log lines. */
  stderrLogs(): Record<string, unknown>[];
  /** Wait until a parsed stdout message satisfies the predicate. */
  waitForStdout(
    predicate: (message: JsonRpcResponse) => boolean,
    timeoutMs?: number
  ): Promise<JsonRpcResponse | undefined>;
  /** Full stdio handshake: initialize + notifications/initialized. */
  initialize(params?: Record<string, unknown>): Promise<JsonRpcResponse>;
  /** Close stdin and resolve with the exit code (graceful-shutdown proof). */
  exit(): Promise<number | null>;
  /** Wait for the process to leave, whatever the trigger (signal, EOF). */
  waitForExit(timeoutMs?: number): Promise<number | null>;
  /** Terminate the child (test cleanup). */
  close(): Promise<void>;
  readonly pid: number | undefined;
}

export interface StartOptions {
  env?: Record<string, string | undefined>;
}

let idCounter = 0;

function nextId(): number {
  idCounter += 1;
  return idCounter;
}

function idKey(id: string | number | null | undefined): string {
  return `${typeof id}:${String(id)}`;
}

/** Split a growing buffer into complete lines, feeding each to `sink`. */
function drain(chunk: string, sink: (line: string) => void): string {
  let rest = chunk;
  let index = rest.indexOf('\n');
  while (index !== -1) {
    const line = rest.slice(0, index);
    rest = rest.slice(index + 1);
    if (line.trim() !== '') sink(line);
    index = rest.indexOf('\n');
  }
  return rest;
}

export async function startMcpProcess(options: StartOptions = {}): Promise<McpProcess> {
  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, ['--import', 'tsx', SERVER_ENTRY], {
    cwd: PACKAGE_ROOT,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...options.env }
  });

  const stdout: string[] = [];
  const stderr: string[] = [];
  const responses: JsonRpcResponse[] = [];
  const waiters = new Map<string, (response: JsonRpcResponse) => void>();
  let stdoutBuffer = '';
  let stderrBuffer = '';
  let exited = false;
  let exitCode: number | null = null;

  const dispatch = (line: string): void => {
    stdout.push(line);
    let parsed: JsonRpcResponse;
    try {
      parsed = JSON.parse(line) as JsonRpcResponse;
    } catch {
      return; // the isolation suite asserts on the raw lines instead
    }
    responses.push(parsed);
    const key = idKey(parsed.id);
    const waiter = waiters.get(key);
    if (waiter !== undefined) {
      waiters.delete(key);
      waiter(parsed);
    }
  };

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdoutBuffer = drain(`${stdoutBuffer}${chunk}`, dispatch);
  });

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderrBuffer = drain(`${stderrBuffer}${chunk}`, (line) => stderr.push(line));
  });

  child.on('exit', (code) => {
    exited = true;
    exitCode = code;
  });

  const write = (line: string): void => {
    child.stdin.write(`${line}\n`);
  };

  const client: McpProcess = {
    pid: child.pid,

    request(method, params, id = nextId()) {
      const key = idKey(id);
      const promise = new Promise<JsonRpcResponse>((resolvePromise, rejectPromise) => {
        waiters.set(key, resolvePromise);
        setTimeout(() => {
          if (waiters.delete(key)) rejectPromise(new Error(`timed out waiting for ${method} (id ${key})`));
        }, 15_000).unref();
      });
      write(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }));
      return promise;
    },

    notify(method, params) {
      write(JSON.stringify({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) }));
    },

    raw(line) {
      write(line);
    },

    stdoutLines: () => [...stdout],
    stderrLines: () => [...stderr],
    stderrLogs: () =>
      stderr
        .map((line) => {
          try {
            return JSON.parse(line) as Record<string, unknown>;
          } catch {
            return undefined;
          }
        })
        .filter((entry): entry is Record<string, unknown> => entry !== undefined),

    async waitForStdout(predicate, timeoutMs = 5_000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const found = responses.find(predicate);
        if (found !== undefined) return found;
        if (Date.now() > deadline) return undefined;
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
      }
    },

    async initialize(params) {
      const response = await client.request(
        'initialize',
        params ?? {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'vitest', version: '1.0.0' }
        }
      );
      client.notify('notifications/initialized');
      return response;
    },

    async exit() {
      if (!exited) child.stdin.end();
      return client.waitForExit();
    },

    async waitForExit(timeoutMs = 10_000) {
      const deadline = Date.now() + timeoutMs;
      while (!exited && Date.now() < deadline) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
      }
      return exitCode;
    },

    async close() {
      if (!exited) {
        child.stdin.end();
        child.kill('SIGKILL');
      }
    }
  };

  return client;
}
