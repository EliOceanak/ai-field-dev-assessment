/**
 * Process-level behaviour of `src/server.ts`.
 *
 * These tests spawn the real entry point (`tsx src/server.ts`), because the bugs they
 * guard against only exist in the process wiring:
 *
 *  - `GATEWAY_PORT` must actually be honoured (binding an ephemeral port instead would
 *    silently ignore the setting the config table documents);
 *  - an invalid configuration must fail fast with a readable multi-line message;
 *  - `SIGTERM` must shut the listener down cleanly.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const PACKAGE_ROOT = resolve(import.meta.dirname, '../..');
const TSX = require.resolve('tsx/cli');

interface Spawned {
  stdout: () => string;
  stderr: () => string;
  lines: () => Record<string, unknown>[];
  waitForLine: (predicate: (line: Record<string, unknown>) => boolean) => Promise<Record<string, unknown>>;
  exit: () => Promise<number | null>;
  signal: (signal: NodeJS.Signals) => void;
}

function spawnServer(env: Record<string, string>): Spawned {
  const child = spawn(process.execPath, [TSX, 'src/server.ts'], {
    cwd: PACKAGE_ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  const waiters: { predicate: (line: Record<string, unknown>) => boolean; resolve: (line: Record<string, unknown>) => void }[] = [];

  const push = (chunk: Buffer): void => {
    for (const raw of String(chunk).split('\n')) {
      const trimmed = raw.trim();
      if (!trimmed.startsWith('{')) continue;
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        continue;
      }
      for (const waiter of [...waiters]) {
        if (waiter.predicate(parsed)) {
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.resolve(parsed);
        }
      }
    }
  };

  child.stdout.on('data', (chunk: Buffer) => {
    stdout += String(chunk);
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += String(chunk);
    push(chunk);
  });

  return {
    stdout: () => stdout,
    stderr: () => stderr,
    lines: () =>
      stderr
        .split('\n')
        .filter((line) => line.trim().startsWith('{'))
        .map((line) => JSON.parse(line) as Record<string, unknown>),
    waitForLine: (predicate) =>
      new Promise((resolveLine, rejectLine) => {
        const timer = setTimeout(() => rejectLine(new Error('timed out waiting for a log line')), 15_000);
        waiters.push({
          predicate,
          resolve: (line) => {
            clearTimeout(timer);
            resolveLine(line);
          }
        });
      }),
    exit: () =>
      new Promise((resolveExit) => {
        child.on('exit', (code) => resolveExit(code));
      }),
    signal: (signal) => child.kill(signal)
  };
}

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolveListen) => probe.listen(0, '127.0.0.1', resolveListen));
  const address = probe.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  await new Promise<void>((resolveClose) => probe.close(() => resolveClose()));
  return port;
}

describe('server process lifecycle', () => {
  it('binds the configured GATEWAY_PORT, serves /health and shuts down on SIGTERM', async () => {
    const port = await freePort();
    const server = spawnServer({ GATEWAY_PORT: String(port), GATEWAY_LOG_LEVEL: 'info' });

    const announced = await server.waitForLine((line) => line.event === 'server_listening');
    expect(announced.port).toBe(port);
    expect(announced.url).toBe(`http://127.0.0.1:${port}/mcp`);
    // The downstream URL is logged as host + path only — never as a full URL on a
    // client-visible surface.
    expect(announced).not.toHaveProperty('downstreamUrl');

    const health = await fetch(`http://127.0.0.1:${port}/health`);
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toMatchObject({ status: 'ok', service: 'mcp-gateway' });

    server.signal('SIGTERM');
    await expect(server.exit()).resolves.toBe(0);
    expect(server.lines().some((line) => line.event === 'shutdown' && line.signal === 'SIGTERM')).toBe(true);
  });

  it('fails fast with a readable multi-line message when the configuration is invalid', async () => {
    const server = spawnServer({ GATEWAY_PORT: '0', GATEWAY_DOWNSTREAM_URL: 'not-a-url' });

    await expect(server.exit()).resolves.not.toBe(0);
    const stderr = server.stderr();
    expect(stderr).toContain('Invalid MCP gateway configuration:');
    expect(stderr).toContain('- port:');
    expect(stderr).toContain('- downstreamUrl:');
    expect(server.stdout()).toBe('');
  });
});
