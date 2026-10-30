#!/usr/bin/env node
/**
 * Offline demo — no model, no network, no GPU.
 *
 * Starts the mock downstream and the **real gateway process** (via `tsx`) on
 * ephemeral ports and drives them over HTTP, exactly as a grader would. Tokens are
 * minted with the shipped CLI (`scripts/mint-token.mjs`), so the demo also proves
 * that the CLI and the gateway's verifier agree.
 *
 *   npm run demo
 *
 * The decisive line is scenario 2: a viewer is denied `admin_reset_key` with
 * JSON-RPC `-32001` **and the downstream call counter does not move**.
 *
 * Exit code 0 only if every expectation holds.
 */
import { execFile, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const PACKAGE_ROOT = resolve(import.meta.dirname, '..');
const TSX = require.resolve('tsx/cli');

const SECRET = 'demo-secret-value';
const STARTUP_TIMEOUT_MS = 20_000;

const children = [];
const failures = [];

function log(line = '') {
  process.stdout.write(`${line}\n`);
}

/** Start a child process and wait until it announces its URL on the given stream. */
function startAndWait(script, env, { stream, match }) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [TSX, script], {
      cwd: PACKAGE_ROOT,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    children.push(child);

    let buffer = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error(`${script} did not announce a URL within ${STARTUP_TIMEOUT_MS} ms`));
      }
    }, STARTUP_TIMEOUT_MS);

    const inspect = (chunk) => {
      buffer += String(chunk);
      for (const line of buffer.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('{')) continue;
        let parsed;
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          continue;
        }
        const found = match(parsed);
        if (found !== undefined && !settled) {
          settled = true;
          clearTimeout(timer);
          resolvePromise(found);
        }
      }
    };

    if (stream === 'stdout') {
      child.stdout.on('data', inspect);
      child.stderr.resume();
    } else {
      child.stderr.on('data', inspect);
      child.stdout.resume();
    }
    child.on('exit', (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(`${script} exited with code ${code} before announcing a URL`));
      }
    });
  });
}

async function mint(role) {
  const { stdout } = await execFileAsync(
    process.execPath,
    [resolve(PACKAGE_ROOT, 'scripts/mint-token.mjs'), '--role', role, '--ttl', '3600', '--secret', SECRET],
    { cwd: PACKAGE_ROOT }
  );
  return stdout.trim();
}

function check(condition, description) {
  if (!condition) failures.push(description);
  return condition;
}

async function callMcp(url, body, token) {
  const headers = { 'content-type': 'application/json' };
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await response.text();
  let json;
  try {
    json = text === '' ? undefined : JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: response.status, headers: response.headers, text, json };
}

async function downstreamCalls(mockBaseUrl) {
  const response = await fetch(`${mockBaseUrl}/__calls`);
  return (await response.json()).count;
}

async function resetCalls(mockBaseUrl) {
  await fetch(`${mockBaseUrl}/__reset`, { method: 'POST' });
}

function shutdown() {
  for (const child of children) {
    if (child.exitCode === null) child.kill('SIGTERM');
  }
}

/**
 * Reserve a free port for the gateway.
 *
 * `GATEWAY_PORT=0` is rejected by the config schema (a listen port must be
 * connectable), so the demo asks the OS for a free port and releases it before
 * handing it to the gateway process.
 */
async function freePort() {
  const probe = createServer();
  await new Promise((resolveListen) => probe.listen(0, '127.0.0.1', resolveListen));
  const { port } = probe.address();
  await new Promise((resolveClose) => probe.close(resolveClose));
  return port;
}

async function main() {
  log('MCP security gateway — offline demo');
  log('===================================');

  const mockUrl = await startAndWait('mock/downstream.ts', { MOCK_PORT: '0' }, {
    stream: 'stdout',
    match: (line) => (line.event === 'mock_listening' ? line.url : undefined)
  });
  const mockBaseUrl = new URL(mockUrl).origin;
  log(`downstream mock : ${mockUrl}`);

  const gatewayUrl = await startAndWait(
    'src/server.ts',
    {
      GATEWAY_PORT: String(await freePort()),
      GATEWAY_DOWNSTREAM_URL: mockUrl,
      GATEWAY_TOKEN_SECRET: SECRET,
      GATEWAY_DEV_TOKENS: '',
      GATEWAY_LOG_LEVEL: 'info'
    },
    { stream: 'stderr', match: (line) => (line.event === 'server_listening' ? line.url : undefined) }
  );
  log(`gateway         : ${gatewayUrl}`);

  const viewerToken = await mint('viewer');
  const adminToken = await mint('admin');
  log('tokens          : minted with scripts/mint-token.mjs (viewer, admin; 1 h ttl)');
  log();

  let denials = 0;
  let unauthorizedUpstreamCalls = 0;
  let calls = await downstreamCalls(mockBaseUrl);

  // 1 — transparent tools/list for a viewer.
  {
    const response = await callMcp(gatewayUrl, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }, viewerToken);
    const tools = response.json?.result?.tools?.map((tool) => tool.name) ?? [];
    const ok =
      check(response.status === 200, 'scenario 1: expected HTTP 200') &&
      check(tools.length === 4, 'scenario 1: expected all 4 tools to be visible') &&
      check(tools.includes('admin_reset_key'), 'scenario 1: admin_reset_key must be visible (transparent)');
    calls = await downstreamCalls(mockBaseUrl);
    log(`1. viewer  → tools/list                 ← ${response.status}, ${tools.length} tools visible (transparent) ${ok ? '✔' : '✖'}`);
    log(`                                          downstream calls: ${calls}`);
  }

  // 2 — the decisive case: viewer denied, downstream never called.
  {
    await resetCalls(mockBaseUrl);
    const response = await callMcp(
      gatewayUrl,
      {
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/call',
        params: { name: 'admin_reset_key', arguments: { customer_id: 'CUST-00001' } }
      },
      viewerToken
    );
    const delta = (await downstreamCalls(mockBaseUrl)) - 0;
    unauthorizedUpstreamCalls += delta;
    denials += 1;
    const ok =
      check(response.status === 200, 'scenario 2: a policy denial must be HTTP 200, not 403') &&
      check(response.json?.error?.code === -32001, 'scenario 2: expected JSON-RPC -32001') &&
      check(response.json?.id === 7, 'scenario 2: expected the id to be echoed exactly') &&
      check(delta === 0, 'scenario 2: the downstream must NOT be called');
    log(
      `2. viewer  → tools/call admin_reset_key ← ${response.status} ` +
        `{"error":{"code":${response.json?.error?.code},"message":"${response.json?.error?.message}"}}` +
        `   downstream calls: ${delta} ${ok ? '✔' : '✖'}`
    );
  }

  // 3 — admin allowed.
  {
    const response = await callMcp(
      gatewayUrl,
      {
        jsonrpc: '2.0',
        id: 8,
        method: 'tools/call',
        params: { name: 'admin_reset_key', arguments: { customer_id: 'CUST-00001' } }
      },
      adminToken
    );
    calls = await downstreamCalls(mockBaseUrl);
    const ok =
      check(response.status === 200, 'scenario 3: expected HTTP 200') &&
      check(response.json?.result !== undefined, 'scenario 3: expected a result');
    log(`3. admin   → tools/call admin_reset_key ← ${response.status} {"result":…}   downstream calls: ${calls} ${ok ? '✔' : '✖'}`);
  }

  // 4 — admin, non-privileged tool.
  {
    const response = await callMcp(
      gatewayUrl,
      {
        jsonrpc: '2.0',
        id: 9,
        method: 'tools/call',
        params: {
          name: 'trigger_refund',
          arguments: { customer_id: 'CUST-00001', amount: 10, reason: 'goodwill gesture' }
        }
      },
      adminToken
    );
    calls = await downstreamCalls(mockBaseUrl);
    const ok = check(response.json?.result !== undefined, 'scenario 4: expected a result');
    log(`4. admin   → tools/call trigger_refund  ← ${response.status} {"result":…}   downstream calls: ${calls} ${ok ? '✔' : '✖'}`);
  }

  // 5 — no credentials.
  {
    const before = await downstreamCalls(mockBaseUrl);
    const response = await callMcp(gatewayUrl, { jsonrpc: '2.0', id: 10, method: 'tools/list', params: {} });
    unauthorizedUpstreamCalls += (await downstreamCalls(mockBaseUrl)) - before;
    const challenge = response.headers.get('www-authenticate');
    denials += 1;
    const ok =
      check(response.status === 401, 'scenario 5: expected HTTP 401') &&
      check(
        challenge === 'Bearer realm="mcp-gateway", error="invalid_token"',
        'scenario 5: expected the WWW-Authenticate challenge'
      );
    log(`5. no auth → tools/list                 ← ${response.status} WWW-Authenticate: ${challenge} ${ok ? '✔' : '✖'}`);
  }

  log();
  log(
    `summary: 5 scenarios, ${denials} denials, ${unauthorizedUpstreamCalls} unauthorized upstream calls ${
      unauthorizedUpstreamCalls === 0 ? '✔' : '✖'
    }`
  );
  if (failures.length > 0) {
    log();
    for (const failure of failures) log(`  ✖ ${failure}`);
  }
  return failures.length === 0 ? 0 : 1;
}

let exitCode = 1;
try {
  exitCode = await main();
} catch (error) {
  log(`demo failed: ${error instanceof Error ? error.message : String(error)}`);
  exitCode = 1;
} finally {
  shutdown();
}
process.exit(exitCode);

