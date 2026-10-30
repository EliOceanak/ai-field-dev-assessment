# Grader guide — 60-second tour

```bash
npm ci && npm run verify          # hygiene + doc paths + typecheck + all offline tests
```

Then, for any task: `cd task-0X-…`, read `README.md` (problem statement → design → test matrix →
trade-offs), run `npm test`, and run `npm run demo` for a human-readable end-to-end transcript.
Recorded command output for every claim below is in [`VERIFICATION.md`](./VERIFICATION.md).

## What each task proves, and where to look

### Task 1 — MCP server with strict validation & transport handling
| Brief says | Proof |
| --- | --- |
| stdio transport, stdout strictly JSON-RPC | `tests/wire/stdout-isolation.test.ts` spawns the real process and parses **every** stdout line as JSON-RPC; `scripts/check-stdout-hygiene.mjs` fails the build on any `console.log`/`process.stdout.write` outside the transport |
| logs only to stderr | `tests/unit/logger.test.ts` + the isolation test asserts stderr carries the logs |
| strict schema validation (Zod) | `tests/unit/schemas.test.ts`: `CUST-XXXXX` format, positive finite amount, `reason` ≥ 10 chars, type-confusion cases |
| standard JSON-RPC error codes | `tests/wire/validation-errors.test.ts`: `-32700`, `-32601`, `-32602` (with `data.issues[].path`), `-32603` |
| real client interop | `tests/wire/sdk-client.test.ts` drives the server with the official SDK client |
| works with a local tool-calling model | `tests/live/agent-tool-call.live.test.ts` (opt-in) runs a real tool-calling loop against the local OpenAI-compatible server |

### Task 2 — MCP security gateway
| Brief says | Proof |
| --- | --- |
| parse JSON-RPC wire format | `tests/unit/jsonrpc-envelope.test.ts`, `tests/integration/batch.test.ts` |
| `tools/list` forwarded transparently | `tests/integration/forwarding.test.ts` (byte-identical body, status and content-type) |
| `admin_*` requires the admin role, otherwise `-32001` without touching the downstream | `tests/integration/authorization.test.ts` asserts the error **and that the mock downstream recorded zero calls** |
| what is authorized is what gets forwarded | `tests/integration/batch.test.ts` (a malformed batch sibling is never forwarded) and `tests/integration/authorization.test.ts` (a body with duplicate JSON keys is refused with `-32600`, because parsers disagree on which duplicate wins) |
| proxy middleware + forwarding | `tests/integration/forwarding.test.ts`, `tests/integration/sse-passthrough.test.ts` |
| clean error handling | `tests/integration/error-handling.test.ts` (401 vs 200+JSON-RPC, malformed body, downstream down) |
| real MCP server behind the gateway | `tests/interop/real-sdk-downstream.test.ts` |

### Task 3 — streaming PII guardrail
| Brief says | Proof |
| --- | --- |
| redact in real time, replace with `[REDACTED]` | `tests/unit/streaming-redactor.test.ts`, `tests/integration/redaction-stream.test.ts` |
| no boundary leakage | the split-point test feeds every fixture at **every** possible split index and requires equality with whole-string redaction; `tests/unit/sse-parser.test.ts` splits SSE frames byte-by-byte |
| nothing missed between adjacent values | `tests/unit/streaming-redactor.test.ts`: overlapping candidates are merged rather than dropped, and a seeded fuzz of adjacent PII and filler asserts that no inserted value survives in either the whole-string or the streamed output |
| do not accumulate the response | `tests/integration/latency.test.ts` asserts the first SSE event reaches the client before upstream has finished, and that the internal buffer never exceeds its bound while streaming a synthetic multi-MB response |
| low latency / TTFT | `scripts/bench-ttft.mjs` prints TTFT and throughput direct-vs-guarded |

### Task 4 — rate limiter + fallback router
| Brief says | Proof |
| --- | --- |
| token-aware sliding window, 50k tokens/min per tenant key | `tests/unit/token-window.test.ts`, `tests/persistence/restart.test.ts`, `tests/unit/eviction.test.ts` |
| concurrency correctness | `tests/concurrency/limiter-atomicity.test.ts` (20 parallel × 6k tokens vs a 50k limit ⇒ exactly 8 admitted) and `tests/concurrency/cross-process.test.ts` (two OS processes, one SQLite file) |
| 429 or 3000 ms timeout ⇒ failover | `tests/integration/failover.test.ts` (scripted mock providers: 429, 500, slow, dead) |
| the 3000 ms deadline is time-to-headers, not a total budget | `tests/unit/provider-client.test.ts` + the 40-frame/4-second stream in `tests/integration/failover.test.ts` (a healthy long stream completes on the default config) |
| the non-streaming case is bounded by the same deadline | a *streamed* response is only bounded by time-to-headers plus the stall watchdog, while a **non-streaming** provider sends headers only once the completion is finished — so the 3000 ms deadline bounds the whole completion there, and a long non-streaming answer fails over by design (`src/providers/providerClient.ts`) |
| streamed completions are charged real usage | `tests/integration/stream-usage.test.ts` (the gateway asks for `stream_options.include_usage` and hides the frame again) and `tests/unit/usage-filter.test.ts` |
| admission reserves the output budget too | `tests/unit/counter.test.ts` + the HTTP case in `tests/integration/rate-limit-headers.test.ts` |
| who gets a window | `tests/integration/tenant-keys.test.ts` (`ROUTER_TENANT_KEYS` allow-list) |
| no raw upstream internals in errors | `tests/integration/error-sanitization.test.ts` (sentinel strings injected upstream must never appear in a response) |
| on-disk SQLite | `src/db/schema.sql` + `scripts/inspect-db.mjs`; restart test proves state survives process death |

## Reviewer checklist

- [ ] `npm ci && npm run verify` is green from a clean clone (no model server required).
- [ ] No test depends on the network, a fixed port, or wall-clock sleeps beyond two marked `slow` tests.
- [ ] Each README states its problem, its design, its trade-offs and its limitations honestly.
- [ ] `docs/VERIFICATION.md` contains real captured output, not prose claims.
- [ ] Secrets, tokens and PII never appear in logs or error bodies.
