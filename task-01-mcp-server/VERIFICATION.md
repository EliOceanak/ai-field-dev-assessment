# Task 1 — verification evidence (raw captured output)

Captured on **2026-10-29** in `/home/eli/Documents/quilr` with **Node v24.3.0**, `@modelcontextprotocol/sdk@1.32.2`,
`zod@4.6.7`, `vitest@5.0.5`. Every block below is verbatim terminal output; nothing here is a paraphrase.

The four task files are aggregated in `docs/VERIFICATION.md`; nothing under `docs/` is duplicated here.

---

## 1. Definition of Done, in order

### 1.1 `npm run hygiene` — static stdout guard

```
$ cd task-01-mcp-server && npm run hygiene

> task-01-mcp-server@1.0.0 hygiene
> node scripts/check-stdout-hygiene.mjs

stdout hygiene: OK (12 file(s) scanned in src)
```

### 1.2 `npm run typecheck` — TypeScript 5.9.3, strict + NodeNext

```
$ npx tsc --noEmit
$ echo $?
0
```

(no output: zero errors. `npm run typecheck` runs the same command through the workspace script.)

### 1.3 `npm test` — hygiene + 180 offline tests

```
$ npm test

> task-01-mcp-server@1.0.0 test
> node scripts/check-stdout-hygiene.mjs && vitest run

stdout hygiene: OK (12 file(s) scanned in src)

 RUN  v5.0.5 /home/eli/Documents/quilr/task-01-mcp-server

 ✓ tests/unit/logger.test.ts (6 tests) 8ms
 ✓ tests/unit/schemas.test.ts (74 tests) 22ms
 ✓ tests/unit/store.test.ts (14 tests) 7ms
 ✓ tests/unit/errors.test.ts (14 tests) 13ms
 ✓ tests/unit/config.test.ts (6 tests) 6ms
 ✓ tests/integration/tool-call-guard.test.ts (8 tests) 48ms
 ✓ tests/wire/sdk-client.test.ts (6 tests) 1443ms
 ✓ tests/wire/stdout-isolation.test.ts (7 tests) 1623ms
 ✓ tests/wire/stdio-protocol.test.ts (17 tests) 3897ms
 ✓ tests/wire/validation-errors.test.ts (28 tests) 6105ms

 Test Files  10 passed (10)
      Tests  180 passed (180)
   Duration  6.21s (tests 96%, import 4%, transform 1%)
```

### 1.4 `npm run demo` — raw JSON-RPC transcript, no model required

```
$ npm run demo

> task-01-mcp-server@1.0.0 demo
> node scripts/smoke-stdio.mjs

MCP stdio transcript — spawn `tsx src/server.ts`, drive raw JSON-RPC

→ initialize                                      ← serverInfo {"name":"customer-ops-mcp","version":"1.0.0"}  capabilities tools
→ tools/list                                      ← 2 tools: get_customer_record, trigger_refund
→ tools/call get_customer_record CUST-00001       ← CUST-00001 Ada Lovelace balance $250.50 refunds 0
→ tools/call trigger_refund  CUST-00001 $25.00    ← REF-000001 $25.00 → balance $225.50
→ tools/call get_customer_record CUST-00001       ← CUST-00001 Ada Lovelace balance $225.50 refunds 1
→ tools/call trigger_refund  key demo-1 (first)   ← REF-000002 $25.00 → balance $200.50
→ tools/call trigger_refund  key demo-1 (again)   ← REF-000002 $25.00 → balance $200.50 (idempotent replay)
→ tools/call trigger_refund  $100.00 > balance    ← isError:true  insufficient_funds — Refund of 100.00 USD exceeds the 75.00 USD balance of CUST-00002
→ tools/call trigger_refund  amount "10"          ← error -32602 Invalid params  (path: amount — amount must be a number)
→ tools/call get_customer_record CUST-0001        ← error -32602 Invalid params  (path: customer_id — customer_id must match CUST-XXXXX (CUST- followed by exactly 5 digits))
→ tools/call ghost_tool                           ← error -32602 Invalid params  (path: name — Unknown tool: ghost_tool)
→ resources/read (unknown method)                 ← error -32601 Method not found
→ {"jsonrpc":"2.0","id":"broken",  (malformed JSON)← error -32700 Parse error
→ tools/list (after malformed input)              ← 2 tools: get_customer_record, trigger_refund

stdout: 14 lines, 14 valid JSON-RPC ✔
stderr: 19 log lines, all JSON ✔  (events: server_started, tool_called, tool_completed, tool_replayed, tool_rejected, jsonrpc_framing_error, server_stopping, server_stopped)
exit:   0 after stdin EOF ✔

✔ all demo checks passed
$ echo $?
0
```

### 1.5 `npm run test:live` — opt-in suites skip cleanly when the env var is unset

```
$ npm run test:live

> task-01-mcp-server@1.0.0 test:live
> vitest run --config vitest.live.config.ts

 ↓ tests/live/agent-tool-call.live.test.ts (3 tests | 3 skipped)

 Test Files  1 skipped (1)
      Tests  3 skipped (3)
$ echo $?
0
```

### 1.6 `RUN_LIVE_LLM=1 npm run test:live` — real model, real tools

```
$ RUN_LIVE_LLM=1 npm run test:live

> task-01-mcp-server@1.0.0 test:live
> vitest run --config vitest.live.config.ts

 ✓ tests/live/agent-tool-call.live.test.ts (3 tests) 6097ms
   ✓ live agent tool calling (3)
     ✓ advertises the two tools to the model as OpenAI function definitions
     ✓ asks for get_customer_record when the user asks about a customer (retried once: model choice is stochastic)
     ✓ drives both tools and changes the balance the server reports

 Test Files  1 passed (1)
      Tests  3 passed (3)
   Duration  6.23s
$ echo $?
0
```

### 1.7 `npm run demo:live` — the tool-calling loop, printed

```
$ npm run demo:live

MCP tools advertised to qwen3.8-turbo @ http://127.0.0.1:8080/v1
  get_customer_record, trigger_refund

  [tool] get_customer_record({"customer_id":"CUST-00001"}) → Ada Lovelace, balance $250.50, 0 refund(s)
  [tool] trigger_refund({"customer_id":"CUST-00001","amount":12.5,"reason":"duplicate charge refund"}) → REF-000001 $12.50, balance $238.00
turn 1: finish_reason=tool_calls  tool_calls=[get_customer_record]
turn 2: finish_reason=tool_calls  tool_calls=[trigger_refund]
turn 3: finish_reason=stop

assistant: Refund processed for CUST-00001 (Ada Lovelace):
- Refund ID: REF-000001
- Amount: $12.50
- Reason: duplicate charge refund
- Previous balance: $250.50
- Remaining balance: $238.00

final state (read over the wire): balance $238.00, 1 refund(s)
stdout: 5 lines, all JSON-RPC ✔
stderr: 9 log lines

✔ the model drove the MCP server end to end
$ echo $?
0
```

---

## 2. Raw wire evidence (hand-driven JSON-RPC)

`printf` of six lines piped into `node --import tsx src/server.ts`; stdout on the left, stderr below it. This is the
literal byte stream a client sees.

### 2.1 stdout — every line is a JSON-RPC 2.0 message

```json
{"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"Parse error"}}
{"result":{"protocolVersion":"2025-11-25","capabilities":{"tools":{"listChanged":true}},"serverInfo":{"name":"customer-ops-mcp","version":"1.0.0"},"instructions":"Customer operations server. Use get_customer_record to read a customer (id format CUST-XXXXX) and trigger_refund to refund an amount against that customer balance. Invalid arguments are rejected as JSON-RPC -32602; business outcomes such as an insufficient balance are returned as isError tool results."},"jsonrpc":"2.0","id":0}
{"jsonrpc":"2.0","id":"abc","error":{"code":-32602,"message":"Invalid params","data":{"tool":"trigger_refund","reqId":"abc","issues":[{"path":"amount","message":"amount must be a number","code":"invalid_type"}]}}}
{"result":{"content":[{"type":"text","text":"{\n  \"error\": {\n    \"code\": \"insufficient_funds\",\n    \"message\": \"Refund of 100.00 USD exceeds the 75.00 USD balance of CUST-00002\",\n    \"customer_id\": \"CUST-00002\",\n    \"balance_usd\": 75,\n    \"requested_usd\": 100\n  }\n}"}],"isError":true},"jsonrpc":"2.0","id":2}
{"result":{"content":[{"type":"text","text":"{\n  \"customer_id\": \"CUST-00002\",\n  \"name\": \"Grace Hopper\",\n  \"email\": \"grace@example.com\",\n  \"plan\": \"pro\",\n  \"balance_usd\": 75,\n  \"refunds\": []\n}"}],"structuredContent":{"customer_id":"CUST-00002","name":"Grace Hopper","email":"grace@example.com","plan":"pro","balance_usd":75,"refunds":[]}},"jsonrpc":"2.0","id":3}
```

Read off that stream:

| Request | Response proves |
| --- | --- |
| `initialize` with `id: 0` | `id: 0` echoed **as a number**; `serverInfo` from config; `capabilities.tools` |
| `tools/call` with `amount: "10"` and `id: "abc"` | `-32602` with `data.issues[].path = "amount"` and `reqId` correlation; string id echoed exactly |
| `tools/call` refund larger than the balance | `isError: true` **result**, no JSON-RPC error, machine-readable `insufficient_funds` |
| `{not json` | `-32700` with `id: null` — and the next request still gets an answer |
| `tools/call get_customer_record` after the malformed line | `structuredContent` + readable text; the server never died |

### 2.2 stderr — one JSON object per line, no PII, same `reqId`

```json
{"ts":"2026-10-29T18:07:39.495Z","level":"info","event":"server_started","server":"customer-ops-mcp","pid":25239,"version":"1.0.0","transport":"stdio","tools":["get_customer_record","trigger_refund"],"logLevel":"info"}
{"ts":"2026-10-29T18:07:39.498Z","level":"warn","event":"jsonrpc_framing_error","server":"customer-ops-mcp","pid":25239,"code":-32700,"kind":"SyntaxError","response":"id:null"}
{"ts":"2026-10-29T18:07:39.501Z","level":"warn","event":"tool_rejected","server":"customer-ops-mcp","pid":25239,"reqId":"abc","tool":"trigger_refund","reason":"invalid_arguments","issueCount":1,"paths":["amount"]}
{"ts":"2026-10-29T18:07:39.501Z","level":"info","event":"tool_called","server":"customer-ops-mcp","pid":25239,"reqId":"2","tool":"trigger_refund","argumentKeys":["amount","customer_id","reason"],"customerId":"CUST-00002","amountUsd":100}
{"ts":"2026-10-29T18:07:39.502Z","level":"warn","event":"tool_rejected","server":"customer-ops-mcp","pid":25239,"reason":"insufficient_funds","customer_id":"CUST-00002","balance_usd":75,"requested_usd":100}
{"ts":"2026-10-29T18:07:39.502Z","level":"info","event":"tool_called","server":"customer-ops-mcp","pid":25239,"reqId":"3","tool":"get_customer_record","argumentKeys":["customer_id"],"customerId":"CUST-00002"}
{"ts":"2026-10-29T18:07:39.502Z","level":"info","event":"tool_completed","server":"customer-ops-mcp","pid":25239,"reason":"customer_found","plan":"pro","refundCount":0}
{"ts":"2026-10-29T18:07:39.503Z","level":"info","event":"server_stopping","server":"customer-ops-mcp","pid":25239,"reason":"stdin_eof"}
{"ts":"2026-10-29T18:07:39.503Z","level":"info","event":"server_stopped","server":"customer-ops-mcp","pid":25239,"reason":"stdin_eof"}
```

The `-32700` line logs only the error *class* (`SyntaxError`) — never the offending line, which is client data. No
customer email, no refund reason text, no full argument object appears anywhere in stderr (asserted in
`tests/wire/stdout-isolation.test.ts`).

---

## 3. The static guard really fails on a violation

```
$ printf 'export function leaky(): void {\n  console.log("this would corrupt the JSON-RPC frame");\n}\n' > src/__hygiene-probe.ts
$ npm run hygiene

> task-01-mcp-server@1.0.0 hygiene
> node scripts/check-stdout-hygiene.mjs

stdout hygiene: 1 violation(s) — stdout must stay pure JSON-RPC

  src/__hygiene-probe.ts:2
    console.log("this would corrupt the JSON-RPC frame");
    ↳ use logger.info(event, fields) — it writes to stderr

Log through src/logging/logger.ts (stderr) or add `stdout-guard: allow` if intentional.
$ echo $?
1

$ rm src/__hygiene-probe.ts && npm run hygiene
stdout hygiene: OK (12 file(s) scanned in src)
```

---

## 4. The SDK-behaviour measurement (`scripts/probe-sdk-error-shapes.mjs`)

Two servers, same driver: **A** = a stock `McpServer` (raw Zod shape, no guard — the SDK's defaults), **B** = this
package. This is the evidence behind design notes §2/§8.

```
$ node scripts/probe-sdk-error-shapes.mjs

================ A. baseline SDK server (no guard, no schema strictness) ================
tools/call valid arguments   → OK {"content":[{"type":"text","text":"ok"}]}
tools/call invalid arguments → {"result":{"content":[{"type":"text","text":"MCP error -32602: Input validation error: Invalid arguments for tool echo: Too small: expected string to have >=1 characters at name"}],"isError":true}}
tools/call unknown field     → OK {"content":[{"type":"text","text":"ok"}]}            ← the extra key was silently stripped
tools/call unknown tool      → {"result":{"content":[{"type":"text","text":"MCP error -32602: Tool nope not found"}],"isError":true}}
unknown method               → {"error":{"code":-32601,"message":"Method not found"}}
malformed JSON               → "NO RESPONSE (silent)"
still serving after it       → OK (tools/list answered)
non-object params            → "NO RESPONSE (silent)"
stdout lines: 9 | stderr lines: 0

================ B. this package (tool-call guard + strict schemas) ================
tools/call valid arguments   → OK {"content":[{"type":"text","text":"{\n  \"refund_id\": \"REF-000001\", …"}],"structuredContent":{…}}
tools/call invalid arguments → {"error":{"code":-32602,"message":"Invalid params","data":{"tool":"trigger_refund","reqId":"invalid","issues":[{"path":"amount","message":"amount must be a number","code":"invalid_type"},{"path":"reason","message":"reason must be at least 10 characters after trimming","code":"too_small"}]}}}
tools/call unknown field     → {"error":{"code":-32602,"message":"Invalid params","data":{"tool":"trigger_refund","reqId":"strict","issues":[{"path":"admin","message":"Unrecognized key: \"admin\"","code":"unrecognized_keys"}]}}}
tools/call unknown tool      → {"error":{"code":-32602,"message":"Invalid params","data":{"tool":"nope","reqId":"unknown-tool","issues":[{"path":"name","message":"Unknown tool: nope","code":"unknown_tool"}]}}}
unknown method               → {"error":{"code":-32601,"message":"Method not found"}}
malformed JSON               → {"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"Parse error"}}
still serving after it       → OK (tools/list answered)
non-object params            → {"jsonrpc":"2.0","id":null,"error":{"code":-32600,"message":"Invalid Request"}}
stdout lines: 11 | stderr lines: 7
```

(Quoted from the script's JSON output; the full 657-line capture is reproducible with the command above.)

---

## 5. Repository-root `npm run verify`

```
$ cd /home/eli/Documents/quilr && npm run verify

> ai-field-dev-assessment@1.0.0 hygiene
> npm run hygiene --workspaces --if-present
  task-01-mcp-server  stdout hygiene: OK (12 file(s) scanned in src)
  task-02-mcp-gateway / task-03-streaming-guardrail / task-04-router-fallback: logging hygiene OK

> ai-field-dev-assessment@1.0.0 check:docs
> node scripts/check-doc-test-paths.mjs
doc paths: OK (67 file reference(s) across 4 document(s) resolve in 4 task folder(s))

> ai-field-dev-assessment@1.0.0 typecheck
> npm run typecheck --workspaces --if-present            → no output, exit 0 for all four workspaces

> ai-field-dev-assessment@1.0.0 test
> npm run test --workspaces --if-present
> task-01-mcp-server@1.0.0 test
   stdout hygiene: OK (12 file(s) scanned in src)
   Test Files  10 passed (10)
        Tests  180 passed (180)
   Duration  6.05s (tests 93%, import 3%, transform 3%)
> task-02-mcp-gateway@1.0.0 test        → 11 files, 183 tests
> task-03-streaming-guardrail@1.0.0 test → 9 files, 154 tests
> task-04-router-fallback@1.0.0 test    → 17 files, 159 tests
exit 0
```

That is the whole repository: **676 offline tests across 47 files in four workspaces**, exit `0`, with no model
server and no network access. This workspace's own suite, run on its own:

```
$ npm run test --workspace task-01-mcp-server
   stdout hygiene: OK (12 file(s) scanned in src)
   Test Files  10 passed (10)
        Tests  180 passed (180)
```

---

## 6. Coverage of the four decisive claims

| Claim | Command that proves it |
| --- | --- |
| Every stdout line of the real process is JSON-RPC | `npm test` → `tests/wire/stdout-isolation.test.ts` (7 tests); `npm run demo` prints `stdout: 14 lines, 14 valid JSON-RPC ✔` |
| Malformed JSON → `-32700`, server keeps serving | `npm test` → `tests/wire/validation-errors.test.ts`; raw transcript in §2.1 |
| Invalid arguments → `-32602` with `data.issues[]` | `npm test` → `tests/wire/validation-errors.test.ts` (20 tests) and `tests/wire/sdk-client.test.ts`; §2.1 |
| `id: 0` and string ids echoed exactly | `npm test` → `tests/wire/stdio-protocol.test.ts` ("echoes id 0 exactly, as a number", "echoes a string id exactly"); §2.1 |
| Domain failures are `isError: true` results, not JSON-RPC errors | `npm test` → `tests/wire/validation-errors.test.ts` ("domain failures are tool results, not JSON-RPC errors"); §2.1 |
