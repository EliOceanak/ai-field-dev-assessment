#!/usr/bin/env node
/**
 * `npm run demo:live` — the same router against the **real** local model server (llama.cpp,
 * `http://127.0.0.1:8080/v1`, `qwen3.8-turbo` by default). Point it at any other OpenAI-compatible
 * server with `LIVE_OPENAI_BASE_URL` / `LIVE_OPENAI_MODEL` (or `ROUTER_LIVE_BASE_URL` /
 * `ROUTER_LIVE_MODEL` for this demo alone), from the process environment or the repo-root `.env`.
 *
 * Three live scenarios:
 *   1. buffered completion through the gateway — tokens reconciled from the provider's `usage`;
 *   2. streamed completion — the pass-through usage scanner reconciles from the final chunk;
 *   3. failover with a **dead primary** and the real model as the secondary, so the failover path is
 *      proven end-to-end (not just with mocks).
 *
 * Exits 0 with a clear message when no model server is reachable, so a reviewer without a GPU can
 * still run it.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { register } from 'tsx/esm/api';
import { deadProviderUrl } from './lib/mock-provider.mjs';

register();
const { createGateway } = await import('../src/server.ts');
const { loadConfig, loadDotEnv } = await import('../src/config.ts');

loadDotEnv();
// `||`, not `??`: an empty value (a blank line in `.env`) means unset.
const BASE = process.env.ROUTER_LIVE_BASE_URL || process.env.LIVE_OPENAI_BASE_URL || 'http://127.0.0.1:8080/v1';
const MODEL = process.env.ROUTER_LIVE_MODEL || process.env.LIVE_OPENAI_MODEL || 'qwen3.8-turbo';
const dir = mkdtempSync(join(tmpdir(), 'task04-live-'));

const line = (label) => `\n${label}\n${'-'.repeat(label.length)}`;
const short = (value, max = 160) => {
  const text = String(value).replace(/\s+/g, ' ');
  return text.length > max ? `${text.slice(0, max)}…` : text;
};

let failures = 0;
const check = (label, condition, detail = '') => {
  if (condition) return;
  failures += 1;
  console.log(`   !! FAILED: ${label}${detail === '' ? '' : ` (${detail})`}`);
};

try {
  // `GET /models` is the one probe every OpenAI-compatible server answers (llama.cpp, Ollama, vLLM, LM
  // Studio); `/health` is llama.cpp's own.
  const models = await fetch(`${BASE}/models`, { signal: AbortSignal.timeout(5_000) });
  if (!models.ok) throw new Error(`GET /models answered ${models.status}`);
} catch (error) {
  console.log(`No model server at ${BASE} (${error instanceof Error ? error.message : String(error)}).`);
  console.log('Start one (or set LIVE_OPENAI_BASE_URL / LIVE_OPENAI_MODEL) and re-run `npm run demo:live`.');
  process.exit(0);
}

const config = loadConfig({
  ROUTER_DB_PATH: join(dir, 'live.db'),
  ROUTER_PRIMARY_BASE_URL: BASE,
  ROUTER_SECONDARY_BASE_URL: BASE,
  ROUTER_PRIMARY_MODEL: MODEL,
  ROUTER_SECONDARY_MODEL: MODEL,
  ROUTER_PRIMARY_TIMEOUT_MS: '60000',
  ROUTER_SECONDARY_TIMEOUT_MS: '60000',
  ROUTER_LOG_LEVEL: 'warn'
});
const gateway = createGateway({ config });
const port = await gateway.listen(0);
const base = `http://127.0.0.1:${port}`;

async function call(body, key) {
  const startedAt = Date.now();
  const response = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify(body)
  });
  const text = await response.text();
  return { status: response.status, elapsedMs: Date.now() - startedAt, text, header: (name) => response.headers.get(name) };
}

console.log('Task 4 — live demo against the local OpenAI-compatible server');
console.log(`model ${BASE} → gateway http://127.0.0.1:${port}   sqlite ${join(dir, 'live.db')}`);
console.log('note: every request sends an explicit max_tokens (llama.cpp defaults to -1 = unbounded)');

// 1 ---------------------------------------------------------------------------------------------
console.log(line('1. buffered completion (max_tokens 512)'));
const buffered = await call(
  { messages: [{ role: 'user', content: 'Reply with exactly the word: pong' }], max_tokens: 512, reasoning_effort: 'none' },
  'live-buffered'
);
console.log(`   → ${buffered.status} after ${buffered.elapsedMs} ms  X-Gateway-Provider: ${buffered.header('x-gateway-provider')}`);
console.log(`   X-RateLimit-Remaining-Tokens: ${buffered.header('x-ratelimit-remaining-tokens')}`);
console.log(`   body: ${short(buffered.text, 220)}`);
check('served by the primary', buffered.status === 200 && buffered.header('x-gateway-provider') === 'primary');

// 2 ---------------------------------------------------------------------------------------------
console.log(line('2. streamed completion (stream_options.include_usage)'));
const streamed = await call(
  {
    messages: [{ role: 'user', content: 'Count from 1 to 5, one number per line.' }],
    max_tokens: 512,
    stream: true,
    stream_options: { include_usage: true },
    reasoning_effort: 'none'
  },
  'live-streamed'
);
const frames = streamed.text.split('\n\n').filter((frame) => frame.startsWith('data: '));
console.log(`   → ${streamed.status}  content-type: ${streamed.header('content-type')}  frames: ${frames.length}`);
console.log(`   terminator: ${streamed.text.trimEnd().endsWith('data: [DONE]') ? '[DONE] present' : 'MISSING'}`);
check('streamed through the gateway', streamed.status === 200 && frames.length > 2);

// 3 ---------------------------------------------------------------------------------------------
console.log(line('3. failover: dead primary, real model as secondary'));
const dead = await deadProviderUrl();
const failoverConfig = loadConfig({
  ROUTER_DB_PATH: join(dir, 'live-failover.db'),
  ROUTER_PRIMARY_BASE_URL: dead,
  ROUTER_SECONDARY_BASE_URL: BASE,
  ROUTER_SECONDARY_MODEL: MODEL,
  ROUTER_PRIMARY_TIMEOUT_MS: '1000',
  ROUTER_SECONDARY_TIMEOUT_MS: '60000',
  ROUTER_LOG_LEVEL: 'warn'
});
const failoverGateway = createGateway({ config: failoverConfig });
const failoverPort = await failoverGateway.listen(0);
const response = await fetch(`http://127.0.0.1:${failoverPort}/v1/chat/completions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer live-failover' },
  body: JSON.stringify({ messages: [{ role: 'user', content: 'Reply with exactly the word: pong' }], max_tokens: 512, reasoning_effort: 'none' })
});
const failoverText = await response.text();
console.log(`   → ${response.status}  X-Gateway-Provider: ${response.headers.get('x-gateway-provider')}  X-Gateway-Fallback: ${response.headers.get('x-gateway-fallback')}  attempts: ${response.headers.get('x-gateway-attempts')}`);
console.log(`   body: ${short(failoverText, 220)}`);
check('served by the real model as the secondary', response.status === 200 && response.headers.get('x-gateway-provider') === 'secondary');
check('the fallback flag is set', response.headers.get('x-gateway-fallback') === 'true');

// 4 ---------------------------------------------------------------------------------------------
console.log(line('4. token accounting from SQLite'));
await failoverGateway.close();
await gateway.close();
const { inspectDatabase } = await import('./lib/inspect.mjs');
const report = inspectDatabase(join(dir, 'live.db'), { now: Date.now() });
console.log(report.sections.join('\n'));
const actual = report.data.events.filter((row) => row.kind === 'actual');
check('real usage was reconciled for every served request', actual.length === 2 && actual.every((row) => row.tokens > 0));

rmSync(dir, { recursive: true, force: true });
console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${failures === 0 ? 'the router served, streamed and failed over against the real model' : `${failures} check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
