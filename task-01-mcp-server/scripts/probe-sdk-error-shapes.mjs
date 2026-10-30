#!/usr/bin/env node
/**
 * Measurement harness: what does the installed SDK *actually* do on the wire?
 *
 * Measures the SDK's real validation/error behaviour instead of assuming it
 * before choosing between "rely on the SDK" and "add an explicit second layer".
 * This script answers that with raw JSON-RPC over a real spawned process:
 *
 *   node scripts/probe-sdk-error-shapes.mjs
 *
 * It runs two servers:
 *   A. the production server (src/server.ts)                        -> observed behaviour
 *   B. a baseline McpServer that does NOT install the tool-call guard -> SDK default
 *
 * Findings are recorded in README.md ("Design notes") and VERIFICATION.md.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, '..');
const REPO_ROOT = resolve(PACKAGE_ROOT, '..');

/** Minimal line-oriented JSON-RPC driver over a child process' stdio. */
function drive(command, args, cwd) {
  const child = spawn(command, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  const stdout = [];
  const stderr = [];
  let buffer = '';
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let index;
    while ((index = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (line.trim() !== '') stdout.push(line);
    }
  });
  child.stderr.on('data', (chunk) => stderr.push(chunk.toString('utf8')));

  const waiters = new Map();
  const inbox = [];
  const pump = () => {
    for (let i = 0; i < stdout.length; i += 1) {
      let parsed;
      try {
        parsed = JSON.parse(stdout[i]);
      } catch {
        continue;
      }
      if (parsed && Object.prototype.hasOwnProperty.call(parsed, 'id')) inbox.push(parsed);
    }
    for (const [id, resolveFn] of waiters) {
      const found = inbox.find((message) => message.id === id);
      if (found) {
        waiters.delete(id);
        resolveFn(found);
      }
    }
  };
  child.stdout.on('data', pump);

  return {
    request(method, params, id) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })}\n`);
      return new Promise((resolveFn) => {
        waiters.set(id, resolveFn);
        setTimeout(() => {
          if (waiters.delete(id)) resolveFn({ timeout: true });
        }, 5000);
      });
    },
    raw(line) {
      child.stdin.write(`${line}\n`);
    },
    async waitFor(predicate, ms = 2000) {
      const started = Date.now();
      while (Date.now() - started < ms) {
        const found = stdout.map((l) => { try { return JSON.parse(l); } catch { return null; } }).find(predicate);
        if (found) return found;
        await new Promise((r) => setTimeout(r, 25));
      }
      return undefined;
    },
    stdoutLines: () => [...stdout],
    stderrLines: () => stderr.join('').split('\n').filter((l) => l !== ''),
    close() {
      child.stdin.end();
      return new Promise((resolveFn) => child.once('exit', () => resolveFn()));
    }
  };
}

const show = (label, value) => console.log(`${label}\n${JSON.stringify(value, null, 2)}\n`);

const baselineSource = `
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
const server = new McpServer({ name: 'baseline', version: '0.0.0' }, { capabilities: { tools: {} } });
server.registerTool('echo', { description: 'echo', inputSchema: { name: z.string().min(1) } }, async (args) => ({
  content: [{ type: 'text', text: String(args.name) }]
}));
await server.connect(new StdioServerTransport());
`;

async function probe(label, command, args, cwd, spec) {
  console.log(`\n================ ${label} ================`);
  const client = drive(command, args, cwd);
  await client.request(
    'initialize',
    { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'probe', version: '0.0.0' } },
    'init'
  );
  client.raw(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));

  show('tools/list →', await client.request('tools/list', {}, 'list'));
  show('tools/call valid arguments →', await client.request('tools/call', { name: spec.toolName, arguments: spec.validArgs }, 'valid'));
  show('tools/call invalid arguments →', await client.request('tools/call', { name: spec.toolName, arguments: spec.invalidArgs }, 'invalid'));
  show('tools/call unknown field →', await client.request('tools/call', { name: spec.toolName, arguments: spec.strictArgs }, 'strict'));
  show('tools/call unknown tool →', await client.request('tools/call', { name: 'nope', arguments: {} }, 'unknown-tool'));
  show('unknown method →', await client.request('resources/read', { uri: 'file:///nope' }, 'unknown-method'));

  client.raw('{"jsonrpc":"2.0","id":"broken","method":"tools/list"');
  const parseError = await client.waitFor((m) => m && m.error && m.error.code === -32700, 1500);
  show('malformed JSON →', parseError ?? 'NO RESPONSE (silent)');
  show('still serving after malformed JSON →', await client.request('tools/list', {}, 'after-broken'));

  client.raw('{"jsonrpc":"2.0","id":"bad-params","method":"tools/call","params":42}');
  show('non-object params →', await client.waitFor((m) => m && m.error && m.error.code === -32600, 1500) ?? 'NO RESPONSE (silent)');

  console.log(`stdout lines: ${client.stdoutLines().length} | stderr lines: ${client.stderrLines().length}`);
  await client.close();
}

await probe('A. baseline SDK server (no guard, no schema strictness)', process.execPath, ['--input-type=module', '-e', baselineSource], REPO_ROOT, {
  toolName: 'echo',
  validArgs: { name: 'ok' },
  invalidArgs: { name: '' },
  strictArgs: { name: 'ok', extra: 1 }
});
await probe('B. this package (tool-call guard + strict schemas)', process.execPath, ['--import', 'tsx', resolve(PACKAGE_ROOT, 'src/server.ts')], PACKAGE_ROOT, {
  toolName: 'trigger_refund',
  validArgs: { customer_id: 'CUST-00001', amount: 25, reason: 'service outage credit' },
  invalidArgs: { customer_id: 'CUST-00001', amount: 'ten', reason: 'short' },
  strictArgs: { customer_id: 'CUST-00001', amount: 25, reason: 'service outage credit', admin: true }
});
