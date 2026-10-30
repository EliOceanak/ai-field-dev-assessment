# Architecture

The four tasks are deliberately independent deliverables that share one vocabulary, so they read as
one product story rather than four unrelated exercises.

## The story

```
                 ┌──────────────────────────── Task 1 ───────────────────────────┐
 agent host ──stdio(JSON-RPC)──▶  MCP server: get_customer_record / trigger_refund │
                 └───────────────────────────────────────────────────────────────┘

 agent host ──HTTP(JSON-RPC)+Bearer──▶ ┌────────── Task 2 ──────────┐ ──HTTP──▶ downstream MCP server
                                       │ MCP gateway: auth + policy │
                                       └───────────────────────────┘

 app ──HTTP(OpenAI chat/completions)──▶ ┌────────── Task 3 ──────────┐ ──HTTP/SSE──▶ LLM provider
                                        │ stream guardrail: redact   │
                                        └────────────────────────────┘

 app ──HTTP(OpenAI chat/completions)──▶ ┌────────── Task 4 ──────────┐ ──HTTP──▶ primary provider
                                        │ limiter + failover router  │ ──HTTP──▶ secondary provider
                                        └────────────────────────────┘
```

A realistic deployment composes all four: Task 2 guards the tool plane, Tasks 3 and 4 guard the model
plane, and Task 1 is the tool server behind the gateway. Task 3's redaction pipeline is exactly what
Task 4's router would wrap around a provider call, and Task 2's policy engine is the same shape of
"inspect a JSON-RPC message, decide, then forward or intercept" logic.

## Shared conventions (why the repo is readable)

| Concern | Convention | Enforced by |
| --- | --- | --- |
| Language | TypeScript, ESM, `module: NodeNext`, strict + `noUncheckedIndexedAccess` | `tsconfig.base.json`, `npm run typecheck` |
| Runtime | Node ≥ 24, npm workspaces, no cross-task runtime dependency | root `package.json` |
| Config | env-first, Zod-validated at boot, documented in `.env.example` | each task's `src/config.ts` |
| Logging | one JSON object per line on **stderr**: `{ts, level, event, reqId, ...}` | each task's `src/logging/logger.ts`; Task 1 adds a static stdout guard |
| MCP errors | JSON-RPC 2.0 `{jsonrpc, id, error:{code, message, data}}`, codes from the spec | wire-level tests |
| LLM errors | `{error:{message, type, code, request_id}}` + a correct HTTP status | sanitization tests with sentinel strings |
| Ports | tests bind ephemeral port `0`; demo defaults are 8787/8788/8790/8791 | test helpers |
| Time | injectable `now()` and injectable `fetch` where behaviour depends on them | unit tests use a fake clock, no `sleep` flake |

## Data flow rules that all four tasks obey

1. **stdout is a protocol channel, never a log channel.** Task 1 is the strict case; Tasks 2–4 keep
   HTTP bodies free of anything but the proxied payload and gateway errors.
2. **Never leak upstream internals.** No upstream response bodies, URLs, stack traces or provider
   identifiers in client-visible errors — only a stable `code`, a safe message and a `request_id`
   that maps to a stderr log line. Tests assert this with injected sentinel strings.
3. **Failover only before commitment.** Task 4 may retry on a second provider only while nothing has
   been written to the client. Once bytes are committed, the stream is terminated with a sanitized
   error instead of being silently restarted.
4. **Bound the buffers.** Task 3's redactor retains only the shortest suffix that could still
   complete a match; Task 4's limiter state is a bounded sliding window with eviction. Neither grows
   with response size or request count.
5. **Estimate, then reconcile.** Task 4 admits a request on an estimated token cost and reconciles
   it against the provider's reported `usage`, so accounting is exact for completed requests and
   conservative for unknown ones.

## Task independence and where duplication is intentional

Each task has its own `package.json`, tests and helpers. Small utilities (`logger.ts`, `config.ts`,
mock upstream servers) are duplicated per task rather than extracted into a shared package: a
reviewer can read, run and grade any single task without loading the others, and a change in one task
cannot break another. The duplication is limited to ~100 lines of glue per task; the graded logic
(delta buffering, JSON-RPC policy, SQLite window arithmetic) exists exactly once per task.
