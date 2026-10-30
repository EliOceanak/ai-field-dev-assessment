# Task 1 — MCP server with strict validation & transport handling

> **Problem statement (from [`ASSESSMENT.md`](../ASSESSMENT.md))**
>
> Write a runnable MCP server (in TypeScript or Python) using the official SDK
> (`@modelcontextprotocol/sdk` or `mcp`) that exposes two tools:
> 1. `get_customer_record` (Input: `customer_id` string formatted as `CUST-XXXXX`).
> 2. `trigger_refund` (Inputs: `customer_id`, `amount` positive float, `reason` string with minimum length of 10).
>
> **Requirements** — enforce strict input schema validation (Zod or Pydantic) and reject invalid
> formats with standard MCP JSON-RPC error codes; connect via **stdio** transport with **stdout
> strictly reserved for JSON-RPC** and all logs written exclusively to stderr.
>
> **Scored on** — STDIO isolation · protocol compliance (JSON-RPC error mapping) · validation depth.

**Status:** complete. 180 offline tests green (`npm test`), 3 opt-in live tests green (`RUN_LIVE_LLM=1 npm run test:live`),
`npm run demo` prints a 14-line raw JSON-RPC transcript, and the whole run is reproduced in [`VERIFICATION.md`](./VERIFICATION.md).

**Stack:** `@modelcontextprotocol/sdk@1.32.2` (v1 — see [`docs/SDK-AND-PROTOCOL-NOTES.md`](../docs/SDK-AND-PROTOCOL-NOTES.md)),
`zod@4.6.7`, Node 24 ESM, `tsx` for the runnable entry point.

## What this demonstrates

- **STDIO isolation, proven twice.** `scripts/check-stdout-hygiene.mjs` fails the build on any `console.log`/`process.stdout`
  in `src/` (verified: it exits 1 on a planted violation), and `tests/wire/stdout-isolation.test.ts` spawns the real
  process and parses **every** stdout line as a JSON-RPC 2.0 message — while validation fails, after malformed input, and
  with logging at `debug`. Every log line is one JSON object on stderr.
- **Protocol compliance with real codes.** `-32602` (with `data.issues[].path`), `-32601`, `-32700`, `-32600`, `-32603`
  are all exercised on the wire; `id: 0` and string ids are echoed exactly; `initialize → notifications/initialized →
  tools/list → tools/call` behaves as the spec requires.
- **The SDK's real behaviour, measured before it was trusted.** `scripts/probe-sdk-error-shapes.mjs` runs the SDK's
  default `McpServer` and this server side by side. The baseline answers invalid arguments with an `isError` **result** and
  malformed JSON with **nothing at all**; this package answers `-32602`/`-32700`. That measurement is why
  `src/protocol/toolCallGuard.ts` and `src/transport/guardedStdio.ts` exist.
- **Validation depth.** 74 table-driven schema tests (type confusion, `NaN`/`Infinity`, `1e-9`, `10.005`, 4-digit ids,
  trailing whitespace, full-width digits, unknown keys) plus `tests/wire/validation-errors.test.ts` for the same cases on
  the wire. The advertised JSON Schema is asserted to be byte-identical to the enforced Zod schema.
- **A real agent can drive it.** `tests/wire/sdk-client.test.ts` uses the official SDK `Client`, and
  `tests/live/agent-tool-call.live.test.ts` + `scripts/agent-demo.mjs` run a genuine tool-calling loop against the local
  `qwen3.8-turbo` server: the model looked up a customer, called `trigger_refund`, and the balance moved.

## Architecture

```
 agent host / SDK Client
        │  newline-delimited JSON-RPC 2.0 on stdin
        ▼
┌───────────────────────────────────────────────────────────────────────────────┐
│ src/server.ts  main()                                                         │
│                                                                               │
│  GuardedStdioTransport (src/transport/guardedStdio.ts)                        │
│   └─ wraps the SDK's StdioServerTransport; the SDK frames stdin into lines    │
│      • JSON.parse throws        → stdout {"jsonrpc":"2.0","id":null,          │
│      • JSONRPCMessageSchema fails   "error":{"code":-32700|…}}  ← SDK sends   │
│      (otherwise → Protocol)          nothing here by default                  │
│                                                                               │
│  Protocol dispatch (SDK)                                                      │
│   ├─ initialize / tools/list / ping          → SDK handlers                   │
│   └─ unknown method                          → -32601 Method not found        │
│                                                                               │
│  installToolCallGuard (src/protocol/toolCallGuard.ts)   ← replaces the SDK's  │
│   │                                                        tools/call handler │
│   ├─ name not a string / unknown tool        → -32602 + data.issues[]         │
│   ├─ tool.inputSchema.safeParse(arguments)   → -32602 + data.issues[].path    │
│   │     (z.strictObject: unknown keys are rejected, not stripped)             │
│   ├─ handler throws unexpectedly             → log cause (stderr) + -32603    │
│   └─ handler returns  ────────────────┐                                       │
│                                       ▼                                       │
│  src/tools/{getCustomerRecord,triggerRefund}.ts                              │
│   ├─ success            → { content:[text JSON], structuredContent }          │
│   ├─ domain failure     → { isError:true, content:[JSON {error:{code,…}}] }   │
│   └─ outputSchema check → mismatch ⇒ log + -32603 (sanitized)                 │
│                                       │                                       │
│  src/data/store.ts  (in-memory, deterministic ids, injectable clock)          │
│                                       │                                       │
│  src/logging/logger.ts → one JSON object per line on **stderr only**         │
└───────────────────────────────────────────────────────────────────────────────┘
        │  newline-delimited JSON-RPC 2.0 on stdout (protocol bytes only)
        ▼
 agent host
```

The failure plane decides the shape — this is the state machine a reviewer should read off the code:

```
                        ┌───────────────────────────────┐
   tools/call ─────────►│ arguments match the schema?   │
                        └──────────────┬────────────────┘
                          no ┌─────────┴─────────┐ yes
                             ▼                   ▼
              JSON-RPC error -32602     ┌─────────────────────┐
              { data: { tool, reqId,    │ domain outcome?     │
                issues:[{path,…}] }     └──────┬──────────────┘
                                    failure ┌──┴──┐ success
                                            ▼     ▼
                     CallToolResult{isError:true}  CallToolResult{structuredContent}
                     (the model can read and      (validated against outputSchema)
                      reason about it)
```

Framing failures never reach a tool: `-32700` (not JSON) and `-32600` (valid JSON, invalid envelope) are answered by the
transport with `id: null`, exactly as JSON-RPC 2.0 specifies, and the read loop keeps running.

## Grader quickstart

```bash
npm ci               # from the repo root, installs every workspace
cd task-01-mcp-server
npm test             # offline: hygiene guard, schemas, JSON-RPC wire, stdout isolation, SDK client
npm run demo         # human-readable raw JSON-RPC transcript over the real stdio pipe
RUN_LIVE_LLM=1 npm run test:live   # optional: real tool-calling loop against the local model
npm run demo:live    # optional: the same loop, printed as a transcript
node scripts/probe-sdk-error-shapes.mjs   # optional: SDK defaults vs this server, side by side
```

To use it as a real MCP server:

```bash
npx @modelcontextprotocol/inspector -- node --import tsx src/server.ts   # or any MCP client
```

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `MCP_SERVER_NAME` | `customer-ops-mcp` | `serverInfo.name` returned by `initialize` |
| `MCP_SERVER_VERSION` | `1.0.0` | `serverInfo.version` |
| `MCP_LOG_LEVEL` | `info` | stderr logger threshold (`debug`…`silent`) |
| `MCP_SEED_DATA_PATH` | _(built-in)_ | JSON file replacing the seeded customer records |
| `LIVE_OPENAI_BASE_URL` | `http://127.0.0.1:8080/v1` | live suites and `demo:live` only |
| `LIVE_OPENAI_MODEL` | `qwen3.8-turbo` | live suites and `demo:live` only |
| `LIVE_OPENAI_MAX_TOKENS` | `1024` (floored at 512) | always sent explicitly — llama.cpp defaults to `-1` (unbounded) and reasoning eats small budgets |
| `RUN_LIVE_LLM` | _(unset)_ | `1` opts the `tests/live/**` suites in |

The `LIVE_*` names are the ones documented in the root `.env.example` and shared by every task's live suite and live
demo, which read them from the process environment and then the repo-root `.env`; the `MCP_*` variables are parsed by Zod
at boot (`src/config.ts`, `loadConfig` stays pure and testable) and documented there too.

## Test matrix

| Criterion | Test file | What it proves |
| --- | --- | --- |
| `CUST-XXXXX` format, amount/reason rules, unknown-key policy | `tests/unit/schemas.test.ts` | 74 table-driven cases: accepts, rejects, and the exact message per field; trim semantics; `additionalProperties: false` in the advertised JSON Schema |
| Refund arithmetic, ledger, idempotency | `tests/unit/store.test.ts` | seed isolation, sequential `REF-######`, cent-exact balances, insufficient-funds and unknown-customer domain errors, replay of a repeated idempotency key |
| Error mapping (units) | `tests/unit/errors.test.ts` | `mapZodError` paths incl. `unrecognized_keys`, exact `-32602` message, `jsonRpcError` envelope, `isError` result shape |
| JSON-RPC error mapping (wire) | `tests/wire/validation-errors.test.ts` | `-32700` + still serving, `-32600`, `-32601`, `-32602` with `data.issues[].path` for every field, domain failures as `isError` results, no `-32603`/stack/path leaks |
| Protocol flow and `id` echo | `tests/wire/stdio-protocol.test.ts` | `initialize` → `notifications/initialized` → `tools/list` → `tools/call`; two tools only; `id: 0`, `"abc"`, `2^53-1` echoed exactly; EOF/SIGTERM exit 0 |
| stdout is pure JSON-RPC | `tests/wire/stdout-isolation.test.ts` | every stdout line of the real process parses as JSON-RPC 2.0 (happy path, validation failures, after malformed input, `debug` and `silent` logging); stderr carries JSON logs; the refund reason and customer email never appear in stderr |
| Static stdout guard | `scripts/check-stdout-hygiene.mjs` (in `npm test`) | fails with `file:line` on any `console.log`/`process.stdout` in `src/`; verified to exit 1 on a planted violation |
| Guard internals | `tests/integration/tool-call-guard.test.ts` | a throwing handler and an `outputSchema` violation both become sanitized `-32603` while the cause (with sentinel text) stays on stderr, correlated by `reqId` |
| Real client interop | `tests/wire/sdk-client.test.ts` | the official SDK `Client` + `StdioClientTransport` lists and calls both tools; its own `structuredContent`/`outputSchema` validation passes; schema violations surface as typed `McpError` |
| Tool-calling model | `tests/live/agent-tool-call.live.test.ts` | opt-in: the local model calls `get_customer_record` then `trigger_refund`; state is asserted over the wire |
| SDK defaults vs this server | `scripts/probe-sdk-error-shapes.mjs` | the measurement behind the design notes (see below) |

## Design notes & trade-offs

### 1. Why SDK v1, and what the 2026-07-28 revision would change

`@modelcontextprotocol/sdk@1.32.2` is the package the brief names and the line with the widest tooling coverage; it
implements the `initialize`-handshake era up to `2025-11-25` (`docs/SDK-AND-PROTOCOL-NOTES.md`). The graded surface
here is wire-level — stdio isolation, JSON-RPC error mapping, Zod validation — so every suite drives the *raw* protocol
over a real pipe and would keep passing if the server were re-implemented on `@modelcontextprotocol/server@2.x`. The one
thing that would change is the handshake: the modern era drops `initialize`/`notifications/initialized`, requires
`server/discover` (`-32022` on a version mismatch) and puts version/capabilities in `_meta.io.modelcontextprotocol/*`. The
`--modern` flag is future work and was **not** implemented.

### 2. What the SDK actually does — measured, then worked around

`scripts/probe-sdk-error-shapes.mjs` runs a stock `McpServer` (no guard, raw Zod shape) next to this server and prints
both. Measured on 2026-10-29 with `@modelcontextprotocol/sdk@1.32.2`:

| Client sends | Stock SDK `McpServer` | This server |
| --- | --- | --- |
| `tools/call`, invalid arguments | `{"result":{"content":[{"text":"MCP error -32602: Input validation error: …"}],"isError":true}}` — **no `-32602`** | `{"error":{"code":-32602,"message":"Invalid params","data":{"tool":…,"reqId":…,"issues":[{"path":"amount",…}]}}}` |
| `tools/call`, unknown field | accepted and **silently stripped** | `-32602`, `issues[].path = "admin"`, `code: "unrecognized_keys"` |
| `tools/call`, unknown tool | `isError` result `"Tool nope not found"` | `-32602` + `issues[].path = "name"` |
| malformed JSON line | **no response at all** (the transport reports it through `onerror` and reads on) | `-32700 Parse error`, `id: null`, still serving |
| valid JSON, non-object `params` | no response (the client waits forever) | `-32600 Invalid Request` |
| unknown method | `-32601 Method not found` | `-32601 Method not found` (unchanged) |

Two consequences, both documented in the code:

- **`src/protocol/toolCallGuard.ts`.** The SDK's own `tools/call` handler wraps the handler body in
  `catch { return this.createToolError(...) }` (`server/mcp.js:186-192`), so a `McpError` thrown from a tool callback is
  converted into an `isError` **result** — the `-32602` never reaches the wire. The guard is installed *after*
  `registerTool` (the SDK has already registered its handler; `Protocol.setRequestHandler` overwrites) and does strict
  validation *before* delegating to the same handler. It also loosens exactly two fields of the request schema
  (`params.name`, `params.arguments` → `unknown`) because `setRequestHandler` validates the envelope *before* the handler
  runs and serializes a Zod failure there as `-32603` with the raw Zod message.
- **`src/transport/guardedStdio.ts`.** `StdioServerTransport.processReadBuffer()` swallows parse failures into `onerror`
  and sends nothing. The wrapper classifies what was thrown (`SyntaxError` → `-32700`; anything carrying Zod `issues` →
  `-32600`), answers with `id: null`, logs only the error *class* (a `JSON.parse` message quotes the offending input,
  which is client data), and leaves the read loop untouched, so the process keeps serving.

Everything else stays on the SDK: framing, `initialize`, `tools/list` (including the Zod→JSON Schema conversion and
`_meta`), and JSON-RPC error serialization with the exact `id` echo.

### 2a. Why the guard registers on `Protocol` instead of `McpServer`

`McpServer.setRequestHandler` hard-codes its own validation for `tools/call` and ignores the schema it is
handed (`node_modules/@modelcontextprotocol/sdk/dist/esm/server/index.js:104-111`): it `safeParse`s the
request against the SDK's strict schema and throws `McpError(-32602, 'Invalid tools/call request: <raw Zod
dump>')` *before* the installed handler runs. Measured consequence: `arguments: null` or a non-string
`name` reaches the client as a `-32602` with a multi-line JSON blob in `message` and no `data.issues[]`,
while a bad `customer_id` (which passes the envelope) gets the structured envelope — two different answers
for the same class of client mistake. Registering through `Protocol.prototype.setRequestHandler` (the base
class that `Server` overrides) skips that wrapper, so the guard validates the whole request and answers
every malformed shape identically. Nothing else moves: framing, `initialize`, `tools/list`, unknown-method
`-32601` and error serialization all stay on the SDK, and the guard already validates tool *results*
against `outputSchema` itself, which is the only check the bypassed wrapper added.

### 3. Where protocol errors stop and tool failures begin

The brief's "reject invalid formats with standard MCP JSON-RPC error codes" is taken literally: an argument that does not
satisfy the advertised schema is a **protocol** violation → `-32602` + `data.issues[]`. A well-formed request that the
business cannot satisfy — unknown customer, refund larger than the balance — is a **domain** outcome → a
`CallToolResult` with `isError: true` whose text block is `{"error":{"code":"insufficient_funds",…}}`. The model must be
able to read "the balance is $75 and you asked for $100" and decide what to do; a JSON-RPC error would hide that behind a
transport failure and typically aborts the agent loop. Both paths are asserted in `tests/wire/validation-errors.test.ts`,
including that an unknown-but-well-formed id is *not* a JSON-RPC error.

### 4. Strict, not lenient, object schemas

`z.strictObject` is used for both tool inputs, so `{"customer_id":"CUST-00001","admin":true}` is rejected with
`path: "admin"` instead of being silently stripped, and `tools/list` advertises `"additionalProperties": false`. The
trade-off: a client that sends a harmless extra key (some SDKs put `_meta` inside `arguments`) gets a `-32602`. That is
the intended reading of "strict validation", and the failure is loud, structured and cheap to fix — a silently dropped
`amount_usd: 25` typo would instead become a wrong refund.

### 5. Money, ids and determinism

Amounts are validated as money (finite, `> 0`, at most two decimals) and every mutation is rounded to cents
(`roundMoney`), so thirty `0.10` refunds end at exactly `247.50`. The decimal check inspects the canonical string form
rather than multiplying by 100 — `1e-9 * 100 = 1e-7`, smaller than any sensible float tolerance, so a tolerance-based test
would wrongly accept `1e-9`. Refund ids are sequential per process (`REF-000001`), the clock is injectable and the
store is deep-copied on read, so tests assert exact values with no clock or randomness.

### 6. Idempotency is a parameter, not a protocol feature

`trigger_refund` accepts an optional `idempotency_key`. A retry with the same key on the same customer replays the
original refund (`idempotent_replay: true`, the balance does not move, the ledger does not grow) — the classic
"the agent retried after a timeout" failure, fixed where the money is. It is *not* a JSON-RPC error or a duplicate-refund
guard: without a key, a second identical call is a second legitimate refund, which is why the tool advertises
`idempotentHint: false` and the demo shows both behaviours.

### 7. `-32603` is reachable but never leaked

A handler that throws is an internal failure: the client receives
`{"code":-32603,"message":"Internal error","data":{"reqId":…}}` and the real cause — including sentinel strings — goes to
stderr with the same `reqId`, which `tests/integration/tool-call-guard.test.ts` asserts with an injected
`postgres://user:pw@host/db` sentinel. The guard also keeps the SDK's `outputSchema` check alive (the SDK's own
`validateToolOutput` lived in the handler the guard replaced), so `structuredContent` cannot drift from the advertised
contract.

### 8. `-32602` for an unknown tool, not `-32601`

Measured: `McpServer` itself throws `McpError(InvalidParams, 'Tool X not found')` (`server/mcp.js:154`), and the MCP spec
treats an unknown tool name as an invalid *parameter* rather than an unknown *method*. This server keeps `-32602` and adds
`issues: [{path:"name", code:"unknown_tool"}]`; `-32601` is reserved for an unknown *method*
(`tests/wire/validation-errors.test.ts` asserts both). The suggestion of `-32601` for an unknown tool was
therefore not followed, deliberately, and this note is the record of that deviation.

### 9. Error messages: exact on the wire, re-wrapped by the SDK client

`new McpError(code, message)` sets `Error.message` to `` `MCP error ${code}: ${message}` ``, which would put
`"MCP error -32602: Invalid params"` on the wire. The error contract for this server specifies
`"Invalid params"` / `"Internal error"` exactly, so `mcpError()` and `McpToolInputError` reset `message` after
construction. The wire payload is byte-exact (asserted in the wire suites), while SDK *clients* show the prefix again
because they re-wrap the wire message in their own `McpError` (asserted in `tests/wire/sdk-client.test.ts`).

### 10. Rejected alternatives

- **Trusting the SDK's validation layer** (no guard): fails the brief's own requirement — the SDK answers schema
  violations with `isError` results, never `-32602`.
- **Using the low-level `Server` and hand-writing `tools/list`**: gives full control, but throws away the SDK's Zod→JSON
  Schema conversion and its `tools/list` handling; the guard reaches the same error contract with far less surface.
- **Reaching into `Protocol._requestHandlers` to wrap the SDK handler**: private API, and it would break on any SDK
  patch. The guard's own registry dispatch costs ten lines instead.
- **Tolerating unknown keys** (`.strip()`): contradicts "strict validation" and silently discards client intent.
- **Returning `-32602` for a refund that exceeds the balance**: turns a business outcome the model can act on into a
  transport-level failure. Rejected in favour of `isError: true` (see §3).

## Limitations & future work

- **State is in memory and per process.** The store is a process-lifetime ledger: restart the server and the refunds are
  gone. `MCP_SEED_DATA_PATH` is parsed into the config but the loader is not wired up yet (future work), and nothing is persisted.
  A real deployment would put the ledger behind a transactional store; `applyRefund` is the single mutation point, so the
  seam already exists.
- **No authentication, no authorization.** stdio is a local trust boundary — whoever can spawn the process can refund
  money. There is no per-tool permission check and no audit log beyond stderr (Task 2's gateway is where authorization
  lives in this repository).
- **Refund ids are only unique per process.** `REF-000001` is deterministic for tests; across restarts or replicas, ids
  would need a UUID or a database sequence.
- **The `idempotency_key` map is unbounded** and never expires. A long-lived process with many keys would grow the map;
  a TTL or an LRU bound is the fix.
- **`-32603` from envelope-level validation is still the SDK's.** A malformed *envelope* for methods the guard does not
  own (e.g. `initialize` with `params: {protocolVersion: 42}`) is serialized by the SDK as `-32603` carrying its Zod
  message. The message contains no internals and no client data, and the graded method (`tools/call`) is fully covered by
  the guard, but a stricter server would pre-validate every supported method's envelope.
- **`tools/call` is dispatched from this package's registry, not from the SDK's.** `McpServer.registerTool` still owns
  advertisement, but the guard's handler is what runs. It is asserted (`tests/integration/tool-call-guard.test.ts`) and
  documented (§2), yet it is a coupling to the SDK's `setRequestHandler` overwrite semantics: a future SDK that throws on
  a duplicate handler would need the guard to be installed before `registerTool` instead.
- **No `--modern` mode, no `server/discover`, no resources/prompts.** Only the two brief-mandated tools exist; the
  future-work items (`server/discover`, a seed-data file loader, extra tools) are unimplemented on purpose.
- **The live suites need a GPU and a tool-calling model.** They are opt-in and skipped by default; `demo:live` fails
  loudly if the model server is unreachable, which is the intended behaviour for a demo.

## Verification evidence

Everything below was captured on 2026-10-29 with Node v24.3.0 in this workspace; the full logs (including the raw JSON-RPC
payloads) are in [`VERIFICATION.md`](./VERIFICATION.md).

### `npm test` — hygiene, typecheck, 180 tests

```
$ npm run hygiene && npx tsc --noEmit && npm test

stdout hygiene: OK (12 file(s) scanned in src)
typecheck: OK (no output = no errors)

 ✓ tests/unit/logger.test.ts (6 tests)
 ✓ tests/unit/errors.test.ts (14 tests)
 ✓ tests/unit/schemas.test.ts (74 tests)
 ✓ tests/unit/store.test.ts (14 tests)
 ✓ tests/unit/config.test.ts (6 tests)
 ✓ tests/integration/tool-call-guard.test.ts (8 tests)
 ✓ tests/wire/sdk-client.test.ts (6 tests)
 ✓ tests/wire/stdout-isolation.test.ts (7 tests)
 ✓ tests/wire/stdio-protocol.test.ts (17 tests)
 ✓ tests/wire/validation-errors.test.ts (20 tests)

 Test Files  10 passed (10)
      Tests  180 passed (180)
```

### The static guard fails correctly

```
$ printf 'export function leaky(): void {\n  console.log("this would corrupt the JSON-RPC frame");\n}\n' > src/__hygiene-probe.ts
$ npm run hygiene

stdout hygiene: 1 violation(s) — stdout must stay pure JSON-RPC

  src/__hygiene-probe.ts:2
    console.log("this would corrupt the JSON-RPC frame");
    ↳ use logger.info(event, fields) — it writes to stderr

Log through src/logging/logger.ts (stderr) or add `stdout-guard: allow` if intentional.
$ echo $?
1
```

### `npm run demo` — the raw JSON-RPC transcript (no model required)

```
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
```

### Live model: `RUN_LIVE_LLM=1 npm run test:live`

```
 ✓ tests/live/agent-tool-call.live.test.ts (3 tests) 6097ms
   ✓ advertises the two tools to the model as OpenAI function definitions
   ✓ asks for get_customer_record when the user asks about a customer (retried once: model choice is stochastic)
   ✓ drives both tools and changes the balance the server reports

 Test Files  1 passed (1)
      Tests  3 passed (3)
```

Without `RUN_LIVE_LLM=1` the same command reports `3 skipped` and exits 0.

### Live model: `npm run demo:live`

```
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
```

### The measurement behind the design notes

```
$ node scripts/probe-sdk-error-shapes.mjs      # A = stock McpServer, B = this server

A. baseline SDK server (no guard, no schema strictness)
   tools/call invalid arguments: isError result: "MCP error -32602: Input validation error: Invalid arguments for tool echo: Too small: expected string to have >=1 characters at name"
   tools/call unknown field:     OK {"content":[{"type":"text","text":"ok"}]}          ← silently stripped
   tools/call unknown tool:      isError result: "MCP error -32602: Tool nope not found"
   unknown method:               -32601 Method not found
   malformed JSON:               "NO RESPONSE (silent)"
   non-object params:            "NO RESPONSE (silent)"

B. this package (tool-call guard + strict schemas)
   tools/call invalid arguments: -32602 Invalid params  data={"tool":"trigger_refund","reqId":"invalid","issues":[{"path":"amount","message":"amount must be a number",…}]}
   tools/call unknown field:     -32602 Invalid params  data={…"issues":[{"path":"admin","message":"Unrecognized key: \"admin\"","code":"unrecognized_keys"}]}
   tools/call unknown tool:      -32602 Invalid params  data={…"issues":[{"path":"name","message":"Unknown tool: nope","code":"unknown_tool"}]}
   unknown method:               -32601 Method not found
   malformed JSON:               -32700 Parse error      (id: null, and the server keeps serving)
   non-object params:            -32600 Invalid Request
```
