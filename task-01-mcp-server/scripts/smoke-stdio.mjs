#!/usr/bin/env node
/**
 * `npm run demo` — a readable raw-JSON-RPC transcript against the real server.
 *
 * No model, no network: this spawns `tsx src/server.ts`, drives the wire by hand
 * and prints what a reviewer needs to see — the happy path, both JSON-RPC error
 * classes, the `-32700` recovery, and the stdout/stderr audit. Exits non-zero if
 * any stdout line is not a valid JSON-RPC message.
 */
import { auditStdout, spawnMcpServer } from './lib/mcp-child.mjs';

const money = (value) => `$${Number(value).toFixed(2)}`;
const arrow = (label, detail) => console.log(`→ ${label.padEnd(48)}${detail === undefined ? '' : `← ${detail}`}`);

/** Compact, human-readable summary of one response. */
function summarise(response) {
  if (response.error !== undefined) {
    const issues = response.error.data?.issues ?? [];
    const detail = issues.map((issue) => `path: ${issue.path} — ${issue.message}`).join('; ');
    return `error ${response.error.code} ${response.error.message}${detail === '' ? '' : `  (${detail})`}`;
  }
  const result = response.result ?? {};
  if (Array.isArray(result.tools)) {
    return `${result.tools.length} tools: ${result.tools.map((tool) => tool.name).join(', ')}`;
  }
  if (result.serverInfo !== undefined) {
    return `serverInfo ${JSON.stringify(result.serverInfo)}  capabilities ${Object.keys(result.capabilities ?? {}).join(',')}`;
  }
  if (result.structuredContent !== undefined) {
    const content = result.structuredContent;
    if (content.refund_id !== undefined) {
      return `${content.refund_id} ${money(content.amount_usd)} → balance ${money(content.new_balance_usd)}${content.idempotent_replay ? ' (idempotent replay)' : ''}`;
    }
    return `${content.customer_id} ${content.name} balance ${money(content.balance_usd)} refunds ${content.refunds.length}`;
  }
  if (result.isError === true) {
    const parsed = JSON.parse(result.content?.[0]?.text ?? '{}');
    return `isError:true  ${parsed.error.code} — ${parsed.error.message}`;
  }
  if (result.content !== undefined) return `content[0] ${String(result.content[0]?.text).slice(0, 60)}…`;
  return JSON.stringify(result);
}

const call = (server, name, args) => server.request('tools/call', { name, arguments: args });

const server = spawnMcpServer();
let failures = 0;

const check = (condition, message) => {
  if (!condition) {
    failures += 1;
    console.log(`   ✖ ${message}`);
  }
  return condition;
};

console.log('MCP stdio transcript — spawn `tsx src/server.ts`, drive raw JSON-RPC\n');

const init = await server.initialize();
arrow('initialize', summarise(init));
check(init.result?.serverInfo?.name === 'customer-ops-mcp', 'initialize must report serverInfo');

const list = await server.request('tools/list');
arrow('tools/list', summarise(list));
check(list.result?.tools?.length === 2, 'tools/list must advertise exactly two tools');

const before = await call(server, 'get_customer_record', { customer_id: 'CUST-00001' });
arrow('tools/call get_customer_record CUST-00001', summarise(before));

const refund = await call(server, 'trigger_refund', {
  customer_id: 'CUST-00001',
  amount: 25,
  reason: 'service outage credit'
});
arrow('tools/call trigger_refund  CUST-00001 $25.00', summarise(refund));
check(refund.result?.structuredContent?.refund_id === 'REF-000001', 'the first refund must be REF-000001');

const after = await call(server, 'get_customer_record', { customer_id: 'CUST-00001' });
arrow('tools/call get_customer_record CUST-00001', summarise(after));
check(after.result?.structuredContent?.balance_usd === 225.5, 'the balance must drop to 225.50');

const keyed = await call(server, 'trigger_refund', {
  customer_id: 'CUST-00001',
  amount: 25,
  reason: 'service outage credit',
  idempotency_key: 'demo-1'
});
arrow('tools/call trigger_refund  key demo-1 (first)', summarise(keyed));

const replay = await call(server, 'trigger_refund', {
  customer_id: 'CUST-00001',
  amount: 25,
  reason: 'service outage credit',
  idempotency_key: 'demo-1'
});
arrow('tools/call trigger_refund  key demo-1 (again)', summarise(replay));
check(
  replay.result?.structuredContent?.refund_id === 'REF-000002' &&
    replay.result?.structuredContent?.idempotent_replay === true,
  'a repeated idempotency key must replay REF-000002 without moving the balance'
);

const domain = await call(server, 'trigger_refund', {
  customer_id: 'CUST-00002',
  amount: 100,
  reason: 'goodwill credit'
});
arrow('tools/call trigger_refund  $100.00 > balance', summarise(domain));
check(domain.result?.isError === true && domain.error === undefined, 'a domain failure must be an isError result');

const badAmount = await call(server, 'trigger_refund', {
  customer_id: 'CUST-00001',
  amount: '10',
  reason: 'service outage credit'
});
arrow('tools/call trigger_refund  amount "10"', summarise(badAmount));
check(badAmount.error?.code === -32602, 'a string amount must be -32602');

const badId = await call(server, 'get_customer_record', { customer_id: 'CUST-0001' });
arrow('tools/call get_customer_record CUST-0001', summarise(badId));
check(badId.error?.code === -32602, 'a four-digit id must be -32602');

const unknownTool = await call(server, 'ghost_tool', {});
arrow('tools/call ghost_tool', summarise(unknownTool));
check(unknownTool.error?.code === -32602, 'an unknown tool must be -32602');

const unknownMethod = await server.request('resources/read', { uri: 'file:///nope' });
arrow('resources/read (unknown method)', summarise(unknownMethod));
check(unknownMethod.error?.code === -32601, 'an unknown method must be -32601');

server.raw('{"jsonrpc":"2.0","id":"broken","method":"tools/list"');
await new Promise((resolvePromise) => setTimeout(resolvePromise, 300));
const parseError = server.stdoutLines
  .map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return undefined;
    }
  })
  .find((message) => message?.error?.code === -32700);
arrow(
  '{"jsonrpc":"2.0","id":"broken",  (malformed JSON)',
  parseError === undefined ? 'NO RESPONSE' : summarise(parseError)
);
check(parseError?.id === null, 'a parse error must answer with id null');

const stillAlive = await server.request('tools/list');
arrow('tools/list (after malformed input)', summarise(stillAlive));
check(stillAlive.result?.tools?.length === 2, 'the server must keep serving after malformed input');

const exitCode = await server.close();

const audit = auditStdout(server.stdoutLines);
const stderrLogs = server.stderrLogs();

console.log(
  `\nstdout: ${audit.total} lines, ${audit.total - audit.invalid.length} valid JSON-RPC ${audit.invalid.length === 0 ? '✔' : '✖'}`
);
for (const violation of audit.invalid) console.log(`   ✖ ${violation.reason}: ${violation.line}`);
console.log(
  `stderr: ${stderrLogs.length} log lines, all JSON ${stderrLogs.length === server.stderrLines.length ? '✔' : '✖'}  (events: ${[...new Set(stderrLogs.map((line) => line.event))].join(', ')})`
);
console.log(`exit:   ${exitCode} after stdin EOF ${exitCode === 0 ? '✔' : '✖'}`);

check(audit.invalid.length === 0, 'every stdout line must be a JSON-RPC message');
check(stderrLogs.length === server.stderrLines.length, 'every stderr line must be a JSON log object');
check(exitCode === 0, 'the server must exit 0 on stdin EOF');

if (failures > 0) {
  console.error(`\n✖ ${failures} demo check(s) failed`);
  process.exit(1);
}
console.log('\n✔ all demo checks passed');
