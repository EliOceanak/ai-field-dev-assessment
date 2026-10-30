# AI Field Developer / Solutions Engineer — Assessment Submission

Four self-contained, runnable deliverables covering **MCP servers**, **MCP security gateways**,
**LLM gateway stream guardrails**, and **model routing resilience**. The task briefs are in
[`ASSESSMENT.md`](./ASSESSMENT.md); each task folder contains its own README, source, tests and
recorded verification evidence.

This submission was coded with AI assistance from Claude and DeepSeek.

```
task-01-mcp-server/          MCP server (stdio) with strict Zod validation + pure-JSON-RPC stdout
task-02-mcp-gateway/         HTTP/JSON-RPC MCP gateway: bearer auth + admin_* tool authorization
task-03-streaming-guardrail/ Streaming LLM proxy that redacts PII without buffering the response
task-04-router-fallback/     Token-aware sliding-window limiter + 429/timeout failover on SQLite
```

## Quick start (grader's path)

```bash
git clone <this-repo> && cd ai-field-dev-assessment
npm ci                 # installs all four workspaces from the lockfile
npm run verify         # hygiene + doc-path guard + typecheck + the full offline test suite
```

That single `npm run verify` is the whole story: **every test is hermetic** — mock upstreams run
in-process on ephemeral ports, so nothing here needs a model server, network access or a warm GPU.
Expected result: 676 tests across four workspaces, green in about twenty-five seconds.

Per-task deep dives and demos:

```bash
npm test --workspace task-01-mcp-server      # or: cd task-01-mcp-server && npm test
make demo-1                                  # runnable end-to-end demo + transcript
```

## Evaluation-criteria map

| Task | Criterion | Where it is proven |
| --- | --- | --- |
| 1 | STDIO isolation | `tests/wire/stdout-isolation.test.ts` (every stdout line must parse as JSON-RPC) + `scripts/check-stdout-hygiene.mjs` (static guard, wired into `npm test`) |
| 1 | Protocol compliance | `tests/wire/*.test.ts` — raw JSON-RPC over the real stdio pipe: `initialize`, `tools/list`, `tools/call`, `-32700/-32601/-32602/-32603` mapping |
| 1 | Validation | `tests/unit/schemas.test.ts` — 30+ malformed-input cases, each asserting the exact JSON-RPC error and `data.issues[]` path |
| 2 | JSON-RPC wire parsing | `tests/unit/jsonrpc-envelope.test.ts`, `tests/integration/batch.test.ts` |
| 2 | Proxy middleware & forwarding | `tests/integration/forwarding.test.ts` (byte-identical passthrough, SSE, notifications, headers) |
| 2 | Method-level authorization | `tests/integration/authorization.test.ts` — viewer + `admin_*` → `-32001` **and downstream call count is 0** |
| 3 | Async chunking / buffer state | `tests/unit/streaming-redactor.test.ts` — every two-way split point of every fixture must equal whole-string redaction |
| 3 | Pattern matching over partial streams | `tests/unit/patterns.test.ts` + `tests/unit/sse-parser.test.ts` (1-byte chunking, split SSE frames) |
| 3 | Memory efficiency & low latency | `tests/integration/latency.test.ts` (first SSE event leaves the gateway before upstream finishes; bounded buffer assertion) + `scripts/bench-ttft.mjs` |
| 4 | Async concurrency & timeout races | `tests/concurrency/limiter-atomicity.test.ts` (20 parallel × 6k tokens, limit 50k ⇒ exactly 8 admitted) + `tests/integration/failover.test.ts` (3000 ms timeout race) |
| 4 | Rate-limiter eviction & token tracking | `tests/unit/token-window.test.ts`, `tests/persistence/restart.test.ts`, `tests/unit/eviction.test.ts` (injected clock) |
| 4 | Graceful fallback & error sanitization | `tests/integration/failover.test.ts`, `tests/integration/error-sanitization.test.ts` (upstream sentinel strings must never appear in a client response) |

Cross-cutting narrative: [`docs/GRADER-GUIDE.md`](./docs/GRADER-GUIDE.md) ·
[`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) · [`docs/VERIFICATION.md`](./docs/VERIFICATION.md)
(the aggregate evidence: commands, headline results, decisive output, honest limitations).

Raw per-task transcripts, unabridged:
[`task-01`](./task-01-mcp-server/VERIFICATION.md) ·
[`task-02`](./task-02-mcp-gateway/VERIFICATION.md) ·
[`task-03`](./task-03-streaming-guardrail/VERIFICATION.md) ·
[`task-04`](./task-04-router-fallback/VERIFICATION.md).

## The local model server

Tasks 3 and 4 proxy to an **OpenAI-compatible** endpoint. The reference environment is
**llama.cpp** (`llama-server`) on `http://127.0.0.1:8080/v1` serving `qwen3.8-turbo`, a local retune of
Qwen3 27B (27.3B params, `Q4_K_M`, 165k context) kept on hand for this assessment. It is the environment
the recorded numbers came from, not a requirement: any OpenAI-compatible, tool-calling model works
(Ollama, vLLM, LM Studio, or the in-process mocks the offline suites use). The verified characteristics
that shaped the design (tool calls, the separate `delta.reasoning_content` stream field, and
`stream_options.include_usage`) are documented in [`docs/LOCAL-LLM.md`](./docs/LOCAL-LLM.md).

## Repository conventions

- **One stack**: TypeScript (ESM, `NodeNext`), Node ≥ 24, npm workspaces. No cross-task runtime
  coupling — each task installs and tests standalone.
- **Layout per task**: `src/` (implementation), `tests/{unit,integration,...}`, `tests/live/*.live.test.ts`
  (opt-in, `RUN_LIVE_LLM=1`), `scripts/` (demos/benchmarks), `README.md`, `VERIFICATION.md`.
- **Logging**: structured JSON lines to **stderr** only. stdout is reserved for protocol bytes —
  enforced in Task 1 by a static guard and a wire-level test.
- **Errors**: JSON-RPC 2.0 error objects for MCP surfaces; an OpenAI-compatible
  `{ error: { message, type, code, request_id } }` envelope for LLM surfaces. Upstream internals
  and stack traces never reach a client; `request_id` correlates to a stderr log line.
- **Config**: environment-first, validated with Zod at boot, documented in
  [`.env.example`](./.env.example) (copy to `.env`; every task loads it without a dependency).

## Repository layout

```
ASSESSMENT.md            The four task briefs
.env.example             Every environment variable, grouped per task
Makefile                 install / verify / test / live / demo-N / clean
docs/                    Cross-cutting docs: architecture, grader guide, local LLM, SDK notes, evidence
task-01-mcp-server/      See its README for the design, test matrix and evidence
task-02-mcp-gateway/
task-03-streaming-guardrail/
task-04-router-fallback/
.github/workflows/ci.yml Node 24: npm ci && npm run verify
```
