/**
 * Shared helper for the runnable scripts (`smoke-stdio.mjs`, `agent-demo.mjs`,
 * `probe-sdk-error-shapes.mjs`).
 *
 * Spawns the real server (`tsx src/server.ts`) with piped stdio and exposes a
 * line-oriented JSON-RPC driver. Scripts are allowed to print to stdout — that
 * is their whole job — so the stdout hygiene guard only scans `src/`.
 */
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const SERVER_ENTRY = resolve(PACKAGE_ROOT, 'src/server.ts');

export function spawnMcpServer({ env = {}, cwd = PACKAGE_ROOT } = {}) {
  const child = spawn(process.execPath, ['--import', 'tsx', SERVER_ENTRY], {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...env }
  });

  const stdoutLines = [];
  const stderrLines = [];
  const responses = [];
  const waiters = new Map();
  let buffer = '';

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let index = buffer.indexOf('\n');
    while (index !== -1) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (line.trim() !== '') {
        stdoutLines.push(line);
        try {
          const parsed = JSON.parse(line);
          responses.push(parsed);
          const waiter = waiters.get(String(parsed.id));
          if (waiter !== undefined) {
            waiters.delete(String(parsed.id));
            waiter(parsed);
          }
        } catch {
          // Not JSON: the transcript driver reports it as a hygiene failure.
        }
      }
      index = buffer.indexOf('\n');
    }
  });

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    for (const line of chunk.split('\n')) if (line.trim() !== '') stderrLines.push(line);
  });

  let counter = 0;

  return {
    child,
    stdoutLines,
    stderrLines,
    stderrLogs: () =>
      stderrLines
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return undefined;
          }
        })
        .filter((entry) => entry !== undefined),

    /** Send a request and resolve with the matching response. */
    request(method, params, requestId) {
      const id = requestId ?? (counter += 1);
      const key = String(id);
      const promise = new Promise((resolvePromise, rejectPromise) => {
        waiters.set(key, resolvePromise);
        setTimeout(() => {
          if (waiters.delete(key)) rejectPromise(new Error(`timeout waiting for ${method}`));
        }, 15_000).unref();
      });
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })}\n`
      );
      return promise;
    },

    notify(method, params) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) })}\n`);
    },

    raw(line) {
      child.stdin.write(`${line}\n`);
    },

    async initialize() {
      const response = await this.request('initialize', {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'smoke-script', version: '1.0.0' }
      });
      this.notify('notifications/initialized');
      return response;
    },

    async close() {
      child.stdin.end();
      return new Promise((resolvePromise) => child.once('exit', (code) => resolvePromise(code ?? 0)));
    }
  };
}

/** Every stdout line must be a JSON-RPC 2.0 message; returns a report. */
export function auditStdout(lines) {
  const invalid = [];
  for (const line of lines) {
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      invalid.push({ line, reason: 'not JSON' });
      continue;
    }
    if (parsed?.jsonrpc !== '2.0') {
      invalid.push({ line, reason: 'missing jsonrpc: "2.0"' });
      continue;
    }
    const isResponse = Object.prototype.hasOwnProperty.call(parsed, 'id');
    const isNotification = typeof parsed.method === 'string' && !isResponse;
    if (!isResponse && !isNotification) invalid.push({ line, reason: 'neither response nor notification' });
    else if (isResponse && parsed.result === undefined && parsed.error === undefined) {
      invalid.push({ line, reason: 'response without result or error' });
    }
  }
  return { total: lines.length, invalid };
}
