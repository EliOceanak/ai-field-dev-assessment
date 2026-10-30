#!/usr/bin/env node
/**
 * `npm run demo` — offline end-to-end transcript. No model server, no network.
 *
 * Five scenarios against scripted providers, in a fixed order:
 *   1. healthy primary            → 200, served by the primary
 *   2. primary returns 429        → 200, served by the secondary, X-Gateway-Fallback: true
 *   3. primary hangs              → failover after the configured 3000 ms (timing printed)
 *   4. both providers fail        → 503 sanitized envelope (and a variant with two dead ports)
 *   5. burst of 12 × 6 000 tokens → 3 × 200 and 9 × 429 with Retry-After, against a 20 000 limit
 * then it dumps the on-disk SQLite state (tenants, token_events, request_log) via `scripts/lib/inspect.mjs`
 * and, when the `sqlite3` CLI is present, the raw `sqlite3` query for the same rows.
 *
 * `src/` is TypeScript, so the script registers tsx's ESM loader and imports it directly.
 */
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { register } from 'tsx/esm/api';
import { deadProviderUrl, startScriptedProvider, SECRET_PROVIDER_BODY_SENTINEL } from './lib/mock-provider.mjs';
import { inspectDatabase, sqlite3Dump } from './lib/inspect.mjs';

register();
const { createGateway } = await import('../src/server.ts');
const { loadConfig } = await import('../src/config.ts');
const { tenantIdForKey } = await import('../src/router/tenant.ts');

const DATA_DIR = resolve(import.meta.dirname, '..', 'data');
// `npm run inspect-db` reads ./data/router.db by default, so the demo writes exactly that file.
const DB_PATH = resolve(DATA_DIR, 'router.db');
const LIMIT = 20_000;
const TOKENS_EACH = 6_000;
const BURST = 12;

for (const suffix of ['', '-wal', '-shm']) rmSync(`${DB_PATH}${suffix}`, { force: true });

/** A body that estimates to exactly `tokens` (role + content + per-message overhead, chars/4). */
const bodyOf = (tokens) => ({ messages: [{ role: 'user', content: 'a'.repeat(Math.max(0, tokens - 5) * 4) }] });
const SMALL = { messages: [{ role: 'user', content: 'Where is my order ORD-10234?' }] };

let failures = 0;
const check = (label, condition, detail = '') => {
  if (condition) return true;
  failures += 1;
  console.log(`   !! FAILED: ${label}${detail === '' ? '' : ` (${detail})`}`);
  return false;
};

const primary = await startScriptedProvider({ name: 'primary' });
const secondary = await startScriptedProvider({ name: 'secondary' });

const config = loadConfig({
  ROUTER_DB_PATH: DB_PATH,
  ROUTER_PRIMARY_BASE_URL: primary.url,
  ROUTER_SECONDARY_BASE_URL: secondary.url,
  ROUTER_LIMIT_TOKENS: String(LIMIT),
  ROUTER_WINDOW_MS: '60000',
  // The burst below is arithmetic: each body estimates to exactly TOKENS_EACH, so the output reserve
  // (on by default) is switched off to keep the numbers the demo prints exactly reproducible.
  ROUTER_OUTPUT_RESERVE_TOKENS: '0',
  ROUTER_MAX_OUTPUT_RESERVE_TOKENS: '0',
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
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return {
    status: response.status,
    elapsedMs: Date.now() - startedAt,
    text,
    json,
    header: (name) => response.headers.get(name)
  };
}

const line = (label) => `\n${label}\n${'-'.repeat(Math.max(label.length, 8))}`;
const short = (value, max = 150) => {
  const text = String(value).replace(/\s+/g, ' ');
  return text.length > max ? `${text.slice(0, max)}…` : text;
};

console.log('Task 4 — rate-limiting & model fallback router: offline demo (scripted providers, no model server)');
console.log(`gateway   ${base}   sqlite ${DB_PATH} (WAL, limit ${LIMIT} tokens / 60 s per tenant key)`);
console.log(`primary   ${primary.url}   secondary ${secondary.url}`);
console.log('note      provider errors carry sentinel strings; the demo checks they never reach a client');

// 1 ---------------------------------------------------------------------------------------------
console.log(line('1. healthy primary'));
const healthy = await call(SMALL, 'demo-healthy');
console.log(`   → ${healthy.status}  X-Gateway-Provider: ${healthy.header('x-gateway-provider')}  X-Gateway-Fallback: ${healthy.header('x-gateway-fallback')}  attempts: ${healthy.header('x-gateway-attempts')}`);
console.log(`   X-RateLimit-Limit-Tokens: ${healthy.header('x-ratelimit-limit-tokens')}  Remaining: ${healthy.header('x-ratelimit-remaining-tokens')}  Reset: ${healthy.header('x-ratelimit-reset')}`);
console.log(`   body: ${short(healthy.text, 120)}`);
check('served by the primary', healthy.status === 200 && healthy.header('x-gateway-provider') === 'primary');

// 2 ---------------------------------------------------------------------------------------------
console.log(line('2. primary returns 429 → fail over'));
primary.setBehaviour('429');
const before = { primary: primary.callCount(), secondary: secondary.callCount() };
const failedOver = await call(SMALL, 'demo-failover-429');
console.log(`   primary calls: ${primary.callCount() - before.primary}   secondary calls: ${secondary.callCount() - before.secondary}`);
console.log(`   → ${failedOver.status}  X-Gateway-Provider: ${failedOver.header('x-gateway-provider')}  X-Gateway-Fallback: ${failedOver.header('x-gateway-fallback')}  attempts: ${failedOver.header('x-gateway-attempts')}`);
check(
  'failover to the secondary',
  failedOver.status === 200 && failedOver.header('x-gateway-provider') === 'secondary' && failedOver.header('x-gateway-fallback') === 'true'
);
check('the upstream 429 body never reached the client', !failedOver.text.includes(SECRET_PROVIDER_BODY_SENTINEL));

// 3 ---------------------------------------------------------------------------------------------
console.log(line('3. primary hangs (no response) → timeout → fail over'));
primary.setBehaviour('hang');
const timed = await call(SMALL, 'demo-timeout');
console.log(`   → ${timed.status} after ${timed.elapsedMs} ms (configured primary timeout: ${config.providers.primary.timeoutMs} ms)`);
console.log(`   X-Gateway-Provider: ${timed.header('x-gateway-provider')}  X-Gateway-Fallback: ${timed.header('x-gateway-fallback')}`);
check('failover after the 3000 ms deadline', timed.status === 200 && timed.elapsedMs >= 2_900 && timed.elapsedMs < 5_000, `${timed.elapsedMs} ms`);
check('served by the secondary after the timeout', timed.header('x-gateway-provider') === 'secondary');
primary.setBehaviour('ok');

// 4 ---------------------------------------------------------------------------------------------
console.log(line('4. both providers fail → sanitized 503'));
primary.setBehaviour('500');
secondary.setBehaviour('500');
const bothFailed = await call(SMALL, 'demo-both-failed');
console.log(`   → ${bothFailed.status}  ${short(bothFailed.text, 200)}`);
check('503 upstream_unavailable', bothFailed.status === 503 && bothFailed.json?.error?.type === 'upstream_unavailable');
check('no upstream internals leaked', !bothFailed.text.includes(SECRET_PROVIDER_BODY_SENTINEL) && !bothFailed.text.includes('INTERNAL_STACK_TRACE'));
check('the envelope carries a request_id', /^req_[0-9a-f-]{36}$/.test(bothFailed.json?.error?.request_id ?? ''));

console.log('   same case with two closed ports (the `network` branch):');
const deadPrimary = await deadProviderUrl();
const deadSecondary = await deadProviderUrl();
const deadGateway = createGateway({
  config: loadConfig({
    ROUTER_DB_PATH: DB_PATH,
    ROUTER_PRIMARY_BASE_URL: deadPrimary,
    ROUTER_SECONDARY_BASE_URL: deadSecondary,
    ROUTER_LOG_LEVEL: 'warn'
  })
});
const deadPort = await deadGateway.listen(0);
const deadResponse = await fetch(`http://127.0.0.1:${deadPort}/v1/chat/completions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer demo-both-dead' },
  body: JSON.stringify(SMALL)
});
const deadText = await deadResponse.text();
console.log(`   → ${deadResponse.status}  ${short(deadText, 200)}`);
check('connection-refused also maps to 503', deadResponse.status === 503 && !deadText.includes('ECONNREFUSED'));
await deadGateway.close();
primary.setBehaviour('ok');
secondary.setBehaviour('ok');

// 5 ---------------------------------------------------------------------------------------------
console.log(line(`5. burst: ${BURST} × ${TOKENS_EACH} estimated tokens against a ${LIMIT}-token limit`));
primary.setDelay(250); // keeps the admitted reservations open while the whole burst arrives
const burst = await Promise.all(Array.from({ length: BURST }, () => call(bodyOf(TOKENS_EACH), 'demo-burst')));
const ok = burst.filter((result) => result.status === 200);
const limited = burst.filter((result) => result.status === 429);
console.log(`   → ${ok.length} × 200, ${limited.length} × 429`);
for (const result of limited.slice(0, 3)) {
  console.log(`   429: Retry-After=${result.header('retry-after')}s  X-RateLimit-Remaining-Tokens=${result.header('x-ratelimit-remaining-tokens')}  ${short(result.text, 140)}`);
}
console.log(`   tenant id for key "demo-burst": ${tenantIdForKey('demo-burst')}`);
check('exactly 3 of 12 admitted (3 × 6 000 = 18 000 ≤ 20 000)', ok.length === 3 && limited.length === BURST - 3, `${ok.length}/${BURST}`);
check('every rejection carries Retry-After', limited.every((result) => /^\d+$/.test(result.header('retry-after') ?? '')));
primary.setDelay(0);

// 6 ---------------------------------------------------------------------------------------------
console.log(line('6. counters (GET /stats)'));
const stats = await (await fetch(`${base}/stats`)).json();
console.log(`   requests=${stats.counters.requests} admitted=${stats.counters.admitted} rate_limited=${stats.counters.rate_limited}`);
console.log(`   provider_primary=${stats.counters.provider_primary} provider_secondary=${stats.counters.provider_secondary} failovers=${stats.counters.failovers}`);
console.log(`   upstream_errors=${stats.counters.upstream_errors} upstream_timeouts=${stats.counters.upstream_timeouts} reservations_released=${stats.counters.reservations_released}`);
console.log(`   tokens_reserved=${stats.counters.tokens_reserved} tokens_actual=${stats.counters.tokens_actual}`);
console.log(`   window: ${stats.config.limitTokens} tokens / ${stats.config.windowMs} ms, driver=${stats.config.driver}, failoverOn=[${stats.config.failoverOn.join(',')}]`);
// 4 single requests on this gateway (steps 1-4) + the 12-request burst; step 4b used another instance.
check('the limiter counted every request', stats.counters.requests === BURST + 4, String(stats.counters.requests));

const metrics = await (await fetch(`${base}/metrics`)).text();
console.log(`   GET /metrics (Prometheus): ${metrics.split('\n').filter((row) => /^gateway_(requests|admitted|rate_limited|failovers)_total /.test(row)).join('  ')}`);

// 7 ---------------------------------------------------------------------------------------------
console.log(line('7. on-disk SQLite state'));
await gateway.close(); // release the write connection so the dump below is a clean read
const report = inspectDatabase(DB_PATH);
console.log(report.sections.join('\n'));
console.log('');
console.log(`$ sqlite3 ${DB_PATH} 'SELECT tenant_id, kind, tokens FROM token_events ORDER BY id;'`);
const dump = sqlite3Dump(DB_PATH, 'SELECT tenant_id, kind, tokens FROM token_events ORDER BY id;');
console.log(dump === null ? '  (sqlite3 CLI not available — see the tables above)' : dump);
check('the database really is on disk with reservations recorded', report.ok && report.data.events.length > 0);

await primary.close();
await secondary.close();

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${failures === 0 ? 'all scenarios behaved as specified' : `${failures} check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
