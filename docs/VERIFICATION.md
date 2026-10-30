# Verification evidence

Every claim in the task READMEs, the root [`README.md`](../README.md) and
[`GRADER-GUIDE.md`](./GRADER-GUIDE.md) is backed by a command whose **real** output is recorded here or in
the owning task's evidence file. Nothing in this repository is aspirational: if a number appears, a command
produced it.

- **This file** — the aggregate: what to run, the headline result per task, the decisive evidence, and the
  honest limitations.
- **Per-task raw transcripts** (committed, unabridged):
  [`task-01`](../task-01-mcp-server/VERIFICATION.md) ·
  [`task-02`](../task-02-mcp-gateway/VERIFICATION.md) ·
  [`task-03`](../task-03-streaming-guardrail/VERIFICATION.md) ·
  [`task-04`](../task-04-router-fallback/VERIFICATION.md)

## Environment

```
Node    v24.3.0      (npm 11.4.2)
OS      Linux Mint 21.3, 16 cores, 30 GB RAM
GPU     NVIDIA RTX 3090 (24 GB) — used only by the opt-in live suites
LLM     llama.cpp llama-server, build b10868-304665fe, model qwen3.8-turbo (27.3B, Q4_K_M, 165k ctx)
        OpenAI-compatible endpoint at http://127.0.0.1:8080/v1
```

## 0. Repository-wide — what a grader runs

```bash
git clone <repo> && cd ai-field-dev-assessment
npm ci               # 202 packages, 0 vulnerabilities
npm run verify       # hygiene guards + tsc --noEmit + the offline suite + the doc-path guard
```

Expected: **676 offline tests across 47 files in 4 workspaces, green in ~25 s**, with no model server and no
network access. From a fresh run (ANSI stripped, most per-file lines elided):

```
stdout hygiene: OK (12 file(s) scanned in src)        ← task-01 static stdout guard
logging hygiene: OK (9 file(s) scanned in src)        ← task-02
logging hygiene: OK (9 file(s) scanned in src)        ← task-03
logging hygiene: OK (17 file(s) scanned in src)       ← task-04
 ✓ tests/unit/schemas.test.ts (74 tests) 14ms
 ✓ tests/wire/stdout-isolation.test.ts (7 tests) 1615ms
 ✓ tests/wire/validation-errors.test.ts (28 tests) 5887ms
 Test Files  10 passed (10)      Tests  180 passed (180)     ← task-01
 ✓ tests/integration/authorization.test.ts (19 tests) 90ms
 ✓ tests/interop/real-sdk-downstream.test.ts (5 tests) 86ms
 Test Files  11 passed (11)      Tests  183 passed (183)     ← task-02
 ✓ tests/unit/streaming-redactor.test.ts (36 tests) 1101ms
 ✓ tests/integration/latency.test.ts (3 tests) 1019ms
 Test Files   9 passed  (9)      Tests  154 passed (154)     ← task-03
 ✓ tests/concurrency/limiter-atomicity.test.ts (4 tests) 1174ms
 ✓ tests/concurrency/cross-process.test.ts (6 tests) 3055ms
 Test Files  17 passed (17)      Tests  159 passed (159)     ← task-04
doc paths: OK (67 file reference(s) across 4 document(s) resolve in 4 task folder(s))
```

### Clean-clone check

The commits are self-sufficient: exporting the tree and installing from scratch reproduces the same result.

```
$ git archive HEAD | tar -x -C /tmp/quilr-clean && cd /tmp/quilr-clean
$ npm ci --no-audit --no-fund            → added 202 packages in 1s
$ npm run verify                         → 180 / 183 / 154 / 159 passed, hygiene + doc paths OK
```

The check is worth repeating after any change to `.gitignore`: an unanchored `data/` rule once silently
excluded `task-01-mcp-server/src/data/store.ts` from the commit, so a clean clone failed typecheck.

## 1. Task 1 — MCP server (stdio, strict validation)

```bash
cd task-01-mcp-server
npm test                            # hygiene guard + 180 offline tests (10 files)
npm run demo                        # raw JSON-RPC transcript over the real stdio pipe
RUN_LIVE_LLM=1 npm run test:live    # 3 tests: a real tool-calling loop against the local model
npm run demo:live                   # the same loop, printed
```

**Headline:** 180 offline + 3 live tests green. `npm run demo` needs no model server.

**Decisive evidence**

- stdout purity — the demo ends with
  `stdout: 14 lines, 14 valid JSON-RPC ✔ / stderr: 19 log lines, all JSON ✔ / exit: 0 after stdin EOF ✔`,
  and `tests/wire/stdout-isolation.test.ts` parses **every** stdout line of the real child process, including
  after malformed input and with `MCP_LOG_LEVEL=debug`.
- protocol mapping, quoted from the demo transcript:

```
→ tools/call trigger_refund  amount "10"       ← error -32602 Invalid params  (path: amount — amount must be a number)
→ tools/call get_customer_record CUST-0001     ← error -32602 Invalid params  (path: customer_id — must match CUST-XXXXX)
→ tools/call ghost_tool                        ← error -32602 Invalid params  (path: name — Unknown tool: ghost_tool)
→ resources/read (unknown method)              ← error -32601 Method not found
→ {"jsonrpc":"2.0","id":"broken",  (malformed) ← error -32700 Parse error
→ tools/list (after malformed input)           ← 2 tools: get_customer_record, trigger_refund
```

- domain failures stay tool results, not protocol errors:
  `→ tools/call trigger_refund $100.00 > balance ← isError:true insufficient_funds`.
- the static guard really fails: injecting `console.log` / `process.stdout.write` into `src/` exits 1 with
  `file:line` diagnostics (raw output in the task file, §3).

Full transcript: `task-01-mcp-server/VERIFICATION.md` (319 lines).

## 2. Task 2 — MCP security gateway

```bash
cd task-02-mcp-gateway
npm test      # 183 offline tests (11 files), incl. a real SDK server behind the gateway
npm run demo  # the five decisive scenarios
```

**Headline:** 183 offline tests green; the interception assertion is `-32001` **and** `mock.calls.length === 0`.

**Decisive evidence** (demo transcript, verbatim):

```
1. viewer  → tools/list                 ← 200, 4 tools visible (transparent) ✔   downstream calls: 1
2. viewer  → tools/call admin_reset_key ← 200 {"error":{"code":-32001,"message":"Unauthorized tool call"}}   downstream calls: 0 ✔
3. admin   → tools/call admin_reset_key ← 200 {"result":…}   downstream calls: 1 ✔
4. admin   → tools/call trigger_refund  ← 200 {"result":…}   downstream calls: 2 ✔
5. no auth → tools/list                 ← 401 WWW-Authenticate: Bearer realm="mcp-gateway", error="invalid_token" ✔
summary: 5 scenarios, 2 denials, 0 unauthorized upstream calls ✔
```

The same assertion is repeated in test form for `id: 0`, argument-less calls and batch messages (task file
§3), and `tests/interop/real-sdk-downstream.test.ts` drives a real `StreamableHTTPServerTransport` server
through the gateway using the official SDK client — neither side knows the gateway exists.

Full transcript: `task-02-mcp-gateway/VERIFICATION.md` (204 lines).

## 3. Task 3 — streaming guardrail

```bash
cd task-03-streaming-guardrail
npm test      # 154 offline tests (9 files)
npm run demo  # scripted mock upstream → redacted transcript, no model
npm run bench # TTFT / throughput, direct vs guarded
RUN_LIVE_LLM=1 npm run test:live   # 2 tests against the real model stream
```

**Headline:** 154 offline + 2 live tests green; **+1.2 ms TTFT** and a **9-byte** maximum retained buffer.

**Decisive evidence**

- demo summary (verbatim):
  `redactions: 6 (1 credit_card, 3 email, 1 ssn, 1 ipv4) · leaks: 0 · benign values kept: 3/3 (ORD-10234, 2026-10-29, 5.9.3) · max buffer seen: 13 bytes (cap 512) · framing: [DONE] preserved`
  followed by `PASS — no raw PII reached the client`.
- bench (verbatim):
  `TTFT cost of guarding : +1.2 ms to the first SSE frame; +20.8 ms to the first non-empty content (≤ one 20 ms token); +1.2 ms when the first delta is prose`
  and `Throughput cost: -1.1 ms over a 200-token stream (-0.01 ms/token of added latency)`.
- `tests/unit/streaming-redactor.test.ts` iterates every fixture at **every** split index, every fixed chunk
  size 1..17, 120 randomized splice/split rounds and a 400-round seeded PII fuzz (random fragments × random
  chunking); `tests/unit/sse-parser.test.ts` splits frames at every byte boundary.

Full transcript: `task-03-streaming-guardrail/VERIFICATION.md` (211 lines).

## 4. Task 4 — limiter + fallback router

```bash
cd task-04-router-fallback
npm test          # 159 offline tests (17 files)
npm run demo      # 429 → secondary; limiter rejection with Retry-After; on-disk state
npm run bench     # admission throughput
npm run inspect-db
RUN_LIVE_LLM=1 npm run test:live   # 5 tests against the real provider
```

**Headline:** 159 offline + 6 live tests green; 20 parallel requests of 6 000 tokens against a 50 000 limit
admit **exactly 8**.

**Decisive evidence** (verbatim test names from the suite):

```
 ✓ answers exactly 8 × 200 and 12 × 429 for 20 parallel requests of 6 000 tokens 1066ms
 ✓ admits exactly one of two concurrent 30 000-token claims
 ✓ never exceeds the limit across two processes claiming 20 × 6 000 tokens each
 ✓ sees the other process's reservations when it starts later
 ✓ honours the brief's 3000 ms default primary timeout (slow) 3015ms
```

The cross-process suite runs those three assertions against **both** drivers (`better` and `node`), and the
demo prints the on-disk `token_events` / `request_log` state alongside raw `sqlite3` dumps.

Full transcript: `task-04-router-fallback/VERIFICATION.md` (621 lines).

## 5. Opt-in live suites (all four workspaces)

These are the only tests that touch a real provider. They are excluded from `npm run verify` (which stays
hermetic) and gated with `describe.skipIf(process.env.RUN_LIVE_LLM !== '1')`, so an unset variable is a
clean skip rather than a failure.

```bash
RUN_LIVE_LLM=1 npm run test:live    # from the repo root; needs the local OpenAI-compatible server
```

Summary of a run against `qwen3.8-turbo` (some per-test lines elided) — task-02 has no live suite, so its
workspace exits 0 with no test files:

```
 ✓ tests/live/agent-tool-call.live.test.ts (3 tests) 4708ms
   ✓ asks for get_customer_record when the user asks about a customer (retried once: model choice is stochastic) 2195ms
   ✓ drives both tools and changes the balance the server reports 2501ms
 Test Files  1 passed (1)      Tests  3 passed (3)          ← task-01
No test files found, exiting with code 0                    ← task-02 (nothing to run)
 ✓ tests/live/redaction.live.test.ts (2 tests) 17443ms
   ✓ never emits raw PII and keeps the SSE framing intact 1392ms
   ✓ scrubs reasoning_content, which this server streams as a separate field 16051ms
 Test Files  1 passed (1)      Tests  2 passed (2)          ← task-03
 ✓ tests/live/router.live.test.ts (6 tests) 8775ms
   ✓ serves a completion and reconciles the provider usage 694ms
   ✓ streams from the real provider and reconciles the usage frame 353ms
   ✓ streams a real completion that outlives the 3000 ms failover deadline 7264ms
   ✓ fails over from a dead primary to the live model 447ms
 Test Files  1 passed (1)      Tests  6 passed (6)          ← task-04
```

11 live tests in total, exit 0. The task-04 case that matters most for the deadline design is the third
one: a real completion that takes **7.3 s** — longer than the 3000 ms failover deadline — is served by the
primary, because the deadline is time-to-headers and the body's own deadlines are the first byte (120 s)
and the inter-chunk gap (30 s).

The same 11 also pass against Ollama 0.11.4 serving `qwen3:8b`, with nothing set but `LIVE_OPENAI_BASE_URL` and
`LIVE_OPENAI_MODEL` (from the shell or from `.env`).

They assert on structure, headers, redaction invariants and token accounting — never on model prose — so a
different model changes nothing but the runtime. The one stochastic assertion (which tool a small model
picks for a loosely worded prompt) retries once and says so in its name.

## 6. Doc/evidence consistency guard

[`scripts/check-doc-test-paths.mjs`](../scripts/check-doc-test-paths.mjs) extracts every file path cited in
backticks from the root `README.md`, `docs/GRADER-GUIDE.md`, `docs/ARCHITECTURE.md` and this file, and
asserts each one exists — either as a repo-root path (`task-0X-…/tests/…`) or inside at least one task
folder. It runs as part of `npm run verify`, so renaming a test without updating the docs fails the build
instead of quietly leaving a false claim in the evidence map.

```
doc paths: OK (67 file reference(s) across 4 document(s) resolve in 4 task folder(s))
```

Negative-tested: appending a fabricated reference to a test file that does not exist makes the guard exit 1
and name the offending document and path, so the check is not vacuous. (That is also why this document never
backticks a hypothetical path: the guard reads backticked paths as claims.)

## 7. Known limitations (aggregated honestly)

A condensed digest — each task README carries the full list with its reasoning and the intended fix.

| Task | Most important limitations |
| --- | --- |
| 1 | In-memory, per-process store (no persistence; `MCP_SEED_DATA_PATH` is parsed but the loader is future work); no authentication on stdio; refund ids are unique only per process; the `idempotency_key` map is unbounded; `-32603` from *envelope* validation of methods the guard does not own is still the SDK's; the guard depends on `setRequestHandler` overwrite semantics; no `server/discover`, resources or prompts. |
| 2 | No OAuth 2.1 resource-server flow (`WWW-Authenticate` only, self-issued HMAC tokens); no rate limiting (that is Task 4); a single downstream; `GET /mcp` and `DELETE` are not proxied (stateless by design) while `Mcp-Session-Id` is forwarded for POST traffic; policy is method/name based, not argument based; the hardened `tools/list` filter does not rewrite batches; audit lines go to stderr only; a token cannot be revoked before `exp`. |
| 3 | Regex plus validators, not a classifier (names, addresses, obfuscated values are out of scope); only the documented card/SSN/phone layouts; a run longer than `maxPatternLength` can be released by the bounded-memory safety valve (logged as `holdback_cap_exceeded`); custom patterns without a literal prefix fall back to a conservative window (logged); non-JSON non-streaming bodies pass through unredacted; no request-body (prompt) redaction; one pattern set per process. |
| 4 | The admission estimate is not a tokenizer (`chars/4` + overhead, reconciled afterwards); one window can overshoot if a provider returns far more output than the prompt implied; the in-process mutex is per process — SQLite is the correctness mechanism, and a multi-replica deployment needs a shared backend behind the same narrow interface; SQLite is a single writer (~6 700 admissions/s on this machine) so bursts across many distinct tenants queue rather than scale; streaming `usage` frames larger than 64 KiB fall back to the estimate; `node:sqlite` is experimental and is only the fallback driver. |

**Not verified anywhere in this repository:** multi-tenant production load, real OAuth flows, a hosted
provider (the live suites have run against llama.cpp and Ollama), and anything requiring a second machine.
Where a claim would need those, the task README says so rather than implying coverage.
