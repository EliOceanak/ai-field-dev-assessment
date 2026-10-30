# Task 4 — Rate-limiting & model fallback router for LLM gateways

> **Problem statement (from [`ASSESSMENT.md`](../ASSESSMENT.md))**
>
> Write a resilient model-routing module for an LLM Gateway that accepts incoming completion requests.
>
> **Requirements** — implement a token-aware sliding-window rate limiter (e.g. max 50,000 tokens/minute
> per tenant API key); if the primary model endpoint returns `429 Too Many Requests` or times out after
> **3000 ms**, automatically fail over to a secondary backup provider; return a **standardized gateway
> error payload without leaking raw upstream stack traces or internal implementation details**; use
> **on-disk SQLite** for the database.
>
> **Scored on** — async concurrency handling and timeout race conditions · accurate rate-limiter state
> eviction and token tracking · graceful fallback mechanics and standardized error sanitization.

**Status:** complete — limiter, SQLite layer, failover router, HTTP surface, offline suites, demo and
live suite are all implemented; `npm test` is 159/159 green offline and `npm run demo` exits 0.

## What this demonstrates

- **Concurrency is handled by SQLite, not by a mutex.** Eviction, the window `SUM` and the reservation
  `INSERT` happen inside one `BEGIN IMMEDIATE` transaction, so the decision is exact even across OS
  processes. The two tests a reviewer should read first:
  - [`tests/concurrency/limiter-atomicity.test.ts`](tests/concurrency/limiter-atomicity.test.ts) —
    **20 parallel requests × 6 000 estimated tokens against a 50 000-token limit ⇒ exactly 8 admitted,
    12 rejected** (8 × 6 000 = 48 000 fits; 9 × 6 000 = 54 000 does not). Asserted at the limiter API
    *and* through the real HTTP gateway, repeated 5× and 3× so a lucky interleaving cannot pass.
  - [`tests/concurrency/cross-process.test.ts`](tests/concurrency/cross-process.test.ts) — **two OS
    processes, one SQLite file**: two concurrent 30 000-token claims ⇒ exactly 1 admitted, and 2 × 20
    claims of 6 000 ⇒ exactly 8 admitted. This is the test an in-process mutex cannot pass.
- **Accurate state eviction and token tracking** — [`src/ratelimit/tokenWindow.ts`](src/ratelimit/tokenWindow.ts)
  evicts an event exactly `windowMs` after its own timestamp (indexed range scan on
  `(tenant_id, window_ts)`), and admission *reserves an estimate* that is later reconciled against the
  provider's real `usage` (`tests/unit/eviction.test.ts`, `tests/unit/token-window.test.ts`,
  `tests/persistence/restart.test.ts`).
- **Graceful fallback with a timeout race** — [`src/providers/providerClient.ts`](src/providers/providerClient.ts)
  wraps every attempt in an `AbortController` + timer that is always cleared and whose body is always
  drained; [`src/router/routeRequest.ts`](src/router/routeRequest.ts) fails over on `429`/`5xx`/network
  and on the **3000 ms** primary deadline, but **never after the first byte has reached the client**
  (`tests/integration/failover.test.ts`, including one real-3-second `slow` test).
- **Standardized error sanitization** — [`src/errors/gatewayErrors.ts`](src/errors/gatewayErrors.ts) is a
  *closed catalogue*: callers pass a kind, never a message, so an upstream body, hostname, stack trace,
  SQL string or tenant key cannot reach a client even by accident
  (`tests/integration/error-sanitization.test.ts` injects `SECRET_PROVIDER_BODY_SENTINEL` and
  `INTERNAL_STACK_TRACE_SENTINEL` and asserts they never appear).
- **On-disk SQLite, swappable driver** — `src/db/schema.sql` + `src/db/migrations.ts` (WAL,
  `busy_timeout`, `synchronous=NORMAL`), behind an adapter that runs on either `better-sqlite3` or
  `node:sqlite`; the whole test suite runs against **both** drivers
  (`tests/unit/database.test.ts`, `tests/unit/token-window.test.ts`), and
  `scripts/inspect-db.mjs` prints the file a reviewer can also open with the `sqlite3` CLI.

## Architecture

```
client ──POST /v1/chat/completions──▶ node:http (src/server.ts)
                                       │  bounded body read (1 MiB → 413)
                                       │  zod validation        → 400 + issues[path,code]
                                       │  Authorization: Bearer / x-tenant-key / x-api-key → 401
                                       ▼
                              estimateTokens(body)              src/ratelimit/counter.ts
                                       ▼
                    ┌──────────── ADMIT (one BEGIN IMMEDIATE) ────────────┐   src/ratelimit/tokenWindow.ts
                    │  DELETE expired   (index range scan)                │
                    │  SELECT SUM(tokens) in window                       │
                    │  used + estimate > limit ?  → 429 + Retry-After     │
                    │  else INSERT reservation (kind='reservation')       │
                    └─────────────────────────────────────────────────────┘
                                       ▼
                       attempts = resolveAttemptOrder(config)   src/providers/registry.ts
                                       ▼
              ┌──────────── attempt N (src/providers/providerClient.ts) ────────────┐
              │  fetch(url, { signal }) + setTimeout(provider.timeoutMs) → abort      │
              │   ok       → commit to the client                                     │
              │   http 4xx/5xx | network | timeout → eligible for failover?           │
              └──────────────────────────────────────────────────────────────────────┘
                    ok ▲                                    all attempts failed ▼
                       │                                                        │
      reconcile(reservationId, usage.total_tokens)            release(reservationId)
                       │                                        503 / 504 / 429 envelope
                       ▼
   buffered: forward the provider payload verbatim      streaming: pipe bytes through,
   + X-Gateway-Provider/-Fallback/-Attempts             scan the tail for `usage`, reconcile
   + X-RateLimit-Limit-Tokens/-Remaining/-Reset         at end of stream
```

**Request state machine (one request, one tenant):**

```
        ┌──────────┐  no key   ┌────────────┐
        │ RECEIVED │──────────▶│ 401 UNAUTH │
        └────┬─────┘           └────────────┘
             │ key
             ▼
        ┌──────────┐  bad body ┌───────────┐
        │ VALIDATE │──────────▶│ 400 BAD   │
        └────┬─────┘           └───────────┘
             │ ok
             ▼
   ┌──────────────────┐  used+est > limit   ┌──────────────┐
   │ ADMIT (reserve)  │────────────────────▶│ 429 + Retry- │
   └────────┬─────────┘                     │     After    │
            │ reservationId                 └──────────────┘
            ▼
   ┌──────────────────┐  429/5xx/network/timeout, and nothing written yet
   │ ATTEMPT primary  │────────────────────────────┐
   └────────┬─────────┘                            ▼
            │ 2xx                       ┌────────────────────┐
            │                           │ ATTEMPT secondary  │
            │                           └─────────┬──────────┘
            │                                     │ 2xx
            │        ┌────────────────────────────┘
            ▼        ▼
   ┌────────────────────────┐   stream dies mid-flight   ┌─────────────────────────┐
   │ COMMITTED (bytes out)  │───────────────────────────▶│ SSE error event +[DONE] │
   └────────┬───────────────┘   (no failover possible)   │  outcome stream_failed  │
            │                                           └─────────────────────────┘
            ▼
   ┌────────────────────────────┐        all attempts failed
   │ RECONCILE(usage) → actual  │   ──────────────────────────▶  RELEASE → 503/504/429
   └────────────────────────────┘
```

**Where the state lives** (`src/db/schema.sql`, applied idempotently by `src/db/migrations.ts`):

| Table | Why |
| --- | --- |
| `tenants` | per-key limit geometry; the row is created on first use from the configured default (50 000 / 60 000 ms) |
| `token_events` | one row per admission (`kind='reservation'`, the estimate) and per reconciled request (`kind='actual'`, the provider's `usage`), both keyed by `window_ts` |
| `request_log` | one row per request at the end of the request: outcome, provider that served it, `failover`, reconciled tokens, latency |
| `schema_version` | exactly one row, so migrations can be additive |

Eviction is cheap because of `idx_token_events_tenant_ts (tenant_id, window_ts)`: the sliding-window
`DELETE` and `SUM` are both range scans over one tenant's slice of the index, so cost tracks *expired
rows*, not table size. `idx_token_events_reservation (reservation_id)` makes the reconcile lookup a
point read. Everything is written in WAL mode (`synchronous=NORMAL`, `busy_timeout=5000`) so readers
never block the single writer and a burst of writers queues instead of failing.

## Grader quickstart

```bash
npm ci                     # repo root
cd task-04-router-fallback
npm test                   # offline: window math, atomicity, cross-process, restart, failover, sanitization
npm run demo               # primary 429 → served by secondary; limiter rejection with Retry-After
npm run inspect-db         # dump the on-disk SQLite state after the demo
```

## Configuration

Every variable is env-first and Zod-validated at boot (`src/config.ts`, `loadConfig(env)` stays pure so
tests can exercise every default). All of them are also in the root `.env.example`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `ROUTER_PORT` | `8791` | listen port (`npm start`) |
| `ROUTER_DB_PATH` | `./data/router.db` | **on-disk** SQLite database; the parent directory is created on boot |
| `ROUTER_SQLITE_DRIVER` | `better` | `better` (better-sqlite3) or `node` (`node:sqlite`) |
| `ROUTER_WINDOW_MS` | `60000` | sliding window length |
| `ROUTER_LIMIT_TOKENS` | `50000` | tokens allowed per window per tenant key |
| `ROUTER_PRIMARY_NAME` / `ROUTER_SECONDARY_NAME` | `primary` / `secondary` | provider names for logs and the `request_log.provider` column |
| `ROUTER_PRIMARY_BASE_URL` / `ROUTER_SECONDARY_BASE_URL` | `http://127.0.0.1:8080/v1` | OpenAI-compatible base URLs |
| `ROUTER_PRIMARY_MODEL` / `ROUTER_SECONDARY_MODEL` | `qwen3.8-turbo` | the model the router pins for that provider |
| `ROUTER_PRIMARY_API_KEY` / `ROUTER_SECONDARY_API_KEY` | *(unset)* | provider credential; never logged, never echoed |
| `ROUTER_PRIMARY_TIMEOUT_MS` | `3000` | **the brief's failover deadline** for the primary attempt |
| `ROUTER_SECONDARY_TIMEOUT_MS` | `10000` | per-attempt deadline for the secondary |
| `ROUTER_MAX_ATTEMPTS` | `2` | total attempts (1 = primary only) |
| `ROUTER_FAILOVER_ON` | `429,500,502,503,504,timeout,network` | triggers that cause failover (`any` is also accepted) |
| `ROUTER_CHARS_PER_TOKEN` | `4` | admission-time estimate coefficient |
| `ROUTER_MESSAGE_OVERHEAD_TOKENS` | `4` | per-message overhead in the estimate |
| `ROUTER_TOOL_OVERHEAD_TOKENS` | `100` | per-tool-definition overhead in the estimate |
| `ROUTER_OUTPUT_RESERVE_TOKENS` | `1024` | output budget reserved at admission when the client declares no `max_tokens`; `0` reserves input only |
| `ROUTER_MAX_OUTPUT_RESERVE_TOKENS` | `16384` | cap on what a client may claim with `max_tokens`, so one request cannot reserve the whole window |
| `ROUTER_STREAM_IDLE_TIMEOUT_MS` | `30000` | **stall detector**: how long a response body may stay silent before the attempt is killed (`0` disables) |
| `ROUTER_STREAM_FIRST_BYTE_TIMEOUT_MS` | `120000` | deadline for the response body to *begin* after the headers arrived — prompt processing is not a stall (`0` disables) |
| `ROUTER_INJECT_STREAM_USAGE` | `true` | ask the provider for `stream_options.include_usage` on streams, then hide the frame if the client did not ask |
| `ROUTER_TENANT_KEYS` | *(unset)* | allow-list of tenant keys; unset = any bearer string is auto-provisioned (and logged as a warning at boot) |
| `ROUTER_LOG_LEVEL` | `info` | stderr logger threshold (`debug`…`silent`) |

The live suite and `npm run demo:live` configure both providers from the shared `LIVE_OPENAI_BASE_URL` /
`LIVE_OPENAI_MODEL`, like every task's live parts; `ROUTER_LIVE_BASE_URL` / `ROUTER_LIVE_MODEL` override them for
this task alone. See [`docs/LOCAL-LLM.md`](../docs/LOCAL-LLM.md).

## HTTP contract

| Situation | Status | Headers | Body |
| --- | --- | --- | --- |
| served by primary | provider status | `X-Gateway-Provider: primary`, `X-Gateway-Fallback: false`, `X-Gateway-Attempts: 1`, `X-Gateway-Request-Id`, rate-limit headers | provider payload, verbatim |
| served by secondary after failover | provider status | `X-Gateway-Provider: secondary`, `X-Gateway-Fallback: true`, `X-Gateway-Attempts: 2`, rate-limit headers | provider payload, verbatim |
| streamed (either provider) | `200` | `Content-Type: text/event-stream`, `Cache-Control: no-cache, no-transform`, `X-Accel-Buffering: no` | SSE frames, `[DONE]` preserved |
| upstream stream died or stalled after its headers (including before the first token) | `200` (already committed) | as above | in-band `data: {"error":{…,"code":"gateway_stream_failed"}}` then `data: [DONE]` (a stall is logged as `upstream_stream_stalled` and counted in `upstream_stalls`) |
| window exhausted | `429` | `Retry-After`, `X-RateLimit-Limit-Tokens`, `X-RateLimit-Remaining-Tokens`, `X-RateLimit-Reset` | `{error:{message,type:"rate_limit_exceeded",code:"gateway_rate_limited",request_id}}` |
| no provider sent headers within its deadline | `504` | `X-Gateway-Request-Id` | sanitized envelope, `type:"upstream_timeout"`, `code:"gateway_upstream_timeout"` |
| every provider failed (5xx / network) | `503` | `X-Gateway-Request-Id` | sanitized envelope, `type:"upstream_unavailable"`, `code:"gateway_upstream_error"` |
| every provider rate-limited | `429` | `X-Gateway-Request-Id` | sanitized envelope, `type:"rate_limit_exceeded"`, `code:"gateway_upstream_rate_limited"` |
| malformed request | `400` | `X-Gateway-Request-Id` | sanitized envelope, `type:"invalid_request"`, `code:"gateway_invalid_request"`, `issues:[{path,code}]` |
| missing / empty tenant key | `401` | `X-Gateway-Request-Id` | sanitized envelope, `type:"invalid_request"`, `code:"gateway_unauthorized"` |
| key not in `ROUTER_TENANT_KEYS` | `401` | `X-Gateway-Request-Id` | same envelope; **no tenant row is created** and no provider is contacted |
| body larger than 1 MiB | `413` | `X-Gateway-Request-Id` | sanitized envelope, `code:"gateway_payload_too_large"` |
| unknown route | `404` | `X-Gateway-Request-Id` | sanitized envelope, `code:"gateway_not_found"` (the path is logged, never echoed) |

Non-error endpoints: `GET /healthz` (liveness, driver, journal mode, provider *hosts* only),
`GET /stats` (counters, window geometry, last 5 `request_log` rows), `GET /metrics` (Prometheus text).
Every row above is asserted — see the test matrix.

## Test matrix

`npm test` runs the hygiene guard plus 17 files / 159 tests, all offline (no network, no model, no
fixed port, no wall-clock sleeps except the `slow`-marked tests).

| Criterion | Test file | What it proves |
| --- | --- | --- |
| window math at the boundary, per-tenant isolation | `tests/unit/token-window.test.ts` | `used + estimate === limit` is admitted and `+1` is denied; a single request may consume the whole window; tenants cannot see each other's usage; a `>limit` request is flagged `oversized`; negative/NaN/∞ estimates throw instead of corrupting state |
| estimate then reconcile with provider usage | `tests/unit/token-window.test.ts` | the reservation is replaced by an `actual` row **in the same `window_ts`**; reconciling twice is a no-op (no double-spend); `release()` restores capacity; an unreconciled reservation stays counted until the window rolls |
| the admission is one transaction | `tests/unit/token-window.test.ts` | a statement-level spy proves the executed order `DELETE expired → SUM → INSERT`, all inside one `BEGIN IMMEDIATE` |
| eviction / rollover with an injected clock | `tests/unit/eviction.test.ts` | an event ages out at exactly `windowMs` and not a millisecond earlier; capacity returns progressively; only the expired rows are deleted (another tenant's rows survive); `sweep()` is idempotent; the window stays bounded over 50 rollovers |
| **20 parallel × 6k tokens vs 50k ⇒ exactly 8 admitted** | `tests/concurrency/limiter-atomicity.test.ts` | 5 consecutive runs at the limiter API (with and without the mutex) and 3 runs through the real HTTP gateway: 8 × 200, 12 × 429 with `Retry-After`, and `SUM(tokens) === 48 000 ≤ 50 000` in SQLite |
| **two OS processes sharing one SQLite file** | `tests/concurrency/cross-process.test.ts` | 2 × 1 concurrent 30 000-token claims ⇒ exactly **1** admitted; 2 × 20 concurrent 6 000-token claims ⇒ exactly **8** admitted; run on **both** drivers |
| state survives a restart | `tests/persistence/restart.test.ts` | window state, reconciled usage and `request_log` survive closing and reopening the database with a brand-new module instance; a restart does not extend the window; the second connection may use the other driver |
| failover on 429 / 500 / network / timeout | `tests/integration/failover.test.ts` | 429, 500 and connection-refused fail over to the secondary with `X-Gateway-Provider: secondary` + `X-Gateway-Fallback: true`; `maxAttempts: 1` and a non-matching `ROUTER_FAILOVER_ON` both stop the retry; the **3000 ms default** is asserted with the real configuration default (the one `slow` test) |
| failover only before the first client byte | `tests/integration/failover.test.ts` | a provider that dies mid-stream yields a sanitized `gateway_stream_failed` SSE event plus `[DONE]`, and the secondary records **zero** calls |
| streaming usage reconciliation | `tests/integration/failover.test.ts` | a healthy stream is forwarded frame-by-frame, reconciled from the `usage` frame, and the scanner stays bounded on a 400-frame stream; a stream without `usage` falls back to the reservation |
| no upstream internals in any error body | `tests/integration/error-sanitization.test.ts` | injected `SECRET_PROVIDER_BODY_SENTINEL` / `INTERNAL_STACK_TRACE_SENTINEL` / prompt sentinels never appear in any response (503, 429, 401, 400, 404, SSE error); no stack-trace shapes, no provider host, no `Bearer`; the `request_id` matches a stderr log line |
| rate-limit headers and rollover | `tests/integration/rate-limit-headers.test.ts` | `429` + `Retry-After` + all three `X-RateLimit-*` headers; `Retry-After` never below 1 s; the next request after the window rolls over succeeds; the limit is per key; `x-tenant-key`/`x-api-key`/`Bearer` resolve to the same tenant; `/healthz`, `/stats`, `/metrics` |
| SQLite schema/migration + WAL pragmas | `tests/unit/database.test.ts` | the `node` driver loads quietly while every other warning still reaches stderr (asserted in a child process); migrations are idempotent and record one `schema_version`; WAL + `busy_timeout` + `foreign_keys` are applied and the `-wal` sidecar exists; the eviction index and the exact `token_events` column list exist; a non-database path fails with a readable error naming the path and driver; transactions roll back and nest as savepoints; both drivers produce the same schema |
| the estimator | `tests/unit/counter.test.ts` | scales with message count/length, charges the per-tool overhead, handles content parts / prompts / system / `response_format`, honours the configured coefficients, is deterministic, never shrinks when content is added, ignores malformed messages |
| the error catalogue | `tests/unit/gateway-errors.test.ts` | every kind maps to its documented status/type/code; the envelope has exactly the four OpenAI-shaped fields; the failure classifier maps all-timeouts → 504, all-429s → upstream 429, a lone un-retried 4xx → 400, mixed → 503; the sanitization guard is not vacuous |
| the three provider deadlines | `tests/unit/provider-client.test.ts` | a stream that outlives the headers deadline completes; a buffered body that outlives it but keeps sending bytes completes; a late first byte (prompt processing) is not a stall; a provider that never sends headers is a `headers`-phase timeout; a provider that sends headers but never starts its body, and a body that goes silent, both end the attempt with `stalled()` true (a `body`-phase timeout when buffered; an aborted body when streamed, because the response is already committed); the watchdog can be disabled |
| the frame-aware usage filter | `tests/unit/usage-filter.test.ts` | the usage frame is removed (and recorded) when the client did not ask for it, forwarded byte-identically when it did, identical output under byte-by-byte chunking, CRLF and comments untouched, `[DONE]` preserved, a trailing partial frame flushed, and the retained tail stays bounded (an oversized frame is flushed, never buffered) |
| streamed usage accounting | `tests/integration/stream-usage.test.ts` | the gateway asks upstream for `stream_options.include_usage`; the frame is hidden from a client that did not ask and forwarded to one that did; other `stream_options` fields survive; non-streaming requests are untouched; switching the feature off falls back to the reservation |
| the output-budget reservation | `tests/unit/counter.test.ts`, `tests/integration/rate-limit-headers.test.ts` | the reservation is input + declared `max_tokens` (capped), a huge `max_tokens` cannot reserve the whole window, `-1`/absent means "use the default", `0` restores input-only reservations, and over HTTP a window one token short of input+`max_tokens` is rejected before any provider is contacted |
| who gets a window | `tests/integration/tenant-keys.test.ts` | with `ROUTER_TENANT_KEYS` set, an unlisted key is 401, creates no tenant row and contacts no provider; a listed key works; the permissive default still auto-provisions and warns at boot; `/healthz` reports the mode |
| `Retry-After` is honest | `tests/unit/token-window.test.ts`, `tests/integration/rate-limit-headers.test.ts` | the header names the instant *this* request fits (walking the window), not the oldest expiry; the instant the old answer named is genuinely too early; the advertised instant succeeds |
| the per-tenant mutex | `tests/unit/mutex.test.ts` | mutual exclusion per key, no cross-key serialisation, values returned, lock released on throw, `pending()` accounting |
| real provider happy path | `tests/live/router.live.test.ts` | *(opt-in)* a real completion and a real SSE stream are served and reconciled from the model's own `usage`; failover from a dead port to the live model |

Helpers: `tests/helpers/mockProvider.ts` (scripted OpenAI-shaped server with `ok`, `ok-stream`, `429`,
`500`, `hang`, `slow-then-ok`, `stream-then-break` and a call recorder), `tests/helpers/testDb.ts`
(**fresh temp-file SQLite per test**, plus the statement-level `spyOnDb`), `tests/helpers/clock.ts`
(injectable `now`), `tests/helpers/gateway.ts` (real `node:http` gateway on port 0),
`tests/helpers/admit-worker.ts` (the second OS process for the cross-process suite).

## Design notes & trade-offs

**Why check + evict + insert happen in ONE `BEGIN IMMEDIATE` transaction.** The classic limiter bug is
two transactions: request A reads `used = 42 000`, request B reads `used = 42 000`, both decide
`42 000 + 6 000 ≤ 50 000` and both reserve — 54 000 tokens admitted against a 50 000 limit. `BEGIN
IMMEDIATE` takes SQLite's write lock *before* the read, so the read-modify-write is serialised. The
bench makes the difference concrete rather than theoretical: with the same 32-request burst,
`npm run bench` shows the shipped limiter admitting exactly 8 while a naive check-then-insert variant
admits **32 (4.00× the limit)**. Rejected alternative: an in-process `Map` + mutex, which is faster but
only correct inside one process — a second process (or a second replica behind a load balancer) would
double the effective limit.

**Why an in-process mutex still exists.** `src/ratelimit/mutex.ts` queues same-tenant admissions before
they reach SQLite. Node runs one thread and `better-sqlite3` is synchronous, so it cannot change the
outcome — it is defence in depth, it keeps a thundering herd from all entering the write path in the
same tick, and it is the seam a distributed backend (Redis) would slot into without touching the router.
The bench quantifies the cost: ~145 µs per admission with the mutex vs ~131 µs without.

**Why admission uses an estimate and reconciles afterwards.** The limiter must decide *before* the
provider answers, so it cannot know the real token count. Reserving an estimate is the only way to
limit rather than merely account; `reconcile()` then replaces the reservation with the provider's
`usage` **in the same `window_ts`**, so the eviction timeline never shifts. The reservation is the input
estimate **plus the client's declared output budget** (`max_tokens`, capped by
`ROUTER_MAX_OUTPUT_RESERVE_TOKENS`), because a reservation that ignored the completion would let one request
spend the whole window on a prompt and then stream unbounded output. Getting a real number out of a *stream* needs the provider's cooperation: a
stream only reports `usage` when the request asked for `stream_options.include_usage`, and the OpenAI client
default is not to ask (measured against llama.cpp: a 447-token answer billed as 45). So the gateway asks on
the client's behalf and then removes the usage frame again unless the client requested it, which keeps the
visible contract byte-identical to what the client asked for. Unknown outcomes keep the reservation
(conservative — the tenant is charged for what we cannot verify) and a total failure *releases* it, because
no completion tokens were produced. `sweep()` deletes expired rows for every
tenant and runs opportunistically on admission, so orphans cannot accumulate. Trade-off: the
reservation covers the *input* estimate only, so a single window can overshoot if a provider returns
much more output than the prompt implied — that is exactly the overshoot `usage` reconciliation
corrects on the next admission.

**What "failover only before the first byte" means, and why a mid-stream restart is worse.** Once a 2xx
upstream response exists, the gateway has committed: the status line and possibly several frames are on
the client's socket. Restarting the request on the secondary would re-run the completion and hand the
client a *duplicate* token stream with a second `[DONE]`, corrupting whatever state it is assembling —
strictly worse than a truncated stream that says so. So the router returns a `stream` plan and stops
considering providers; if the pipe then fails it emits `data: {"error":{…"code":"gateway_stream_failed"}}`
followed by `data: [DONE]`, logs `stream_failed`, and reconciles with whatever it knows. The test asserts
the secondary recorded **zero** calls. The boundary is tested from both sides: a *timeout before headers*
is still eligible for failover (nothing was written), while a *death after the first frame* is not.

**The timeout race is three deadlines, because it answers three questions.** `timeoutMs` is **time to first
response headers** — the failover deadline, which is what "the primary timed out after 3000 ms, fail over"
means. `ROUTER_STREAM_FIRST_BYTE_TIMEOUT_MS` (default 120 s) is the window between the headers and the first
body byte: a provider accepts the request immediately and then prompt-processes for seconds before its first
token, so that gap must not be charged to the stall watchdog. `ROUTER_STREAM_IDLE_TIMEOUT_MS` (default 30 s)
covers the body from the first chunk onwards: every chunk resets it, so a completion that legitimately takes a
minute is fine, while one that goes silent is killed. Getting any of the three wrong has a concrete failure: a
healthy 4-second stream truncated at 3 s and closed with a fabricated error frame; a slow buffered completion
abandoned on the primary and regenerated on the secondary; a 6 000-token prompt killed while it was still
being processed. All three are regression tests (`tests/unit/provider-client.test.ts`, plus a 40-frame/4-second
stream through the real gateway on the default configuration). The mechanics are shared by all three: one
`AbortController` per attempt, every timer cleared in `release()`, the error body drained on non-2xx, and the
client's abort signal forwarded so an abandoned request stops costing provider time. A *buffered* body that
stalls is still failover-eligible, because nothing has been written to the client. A *streamed* response is
committed as soon as the upstream headers arrive (the client's `200` and SSE headers are flushed then), so a
stream that stalls, even before its first token, ends with an in-band error instead — see the streaming rule
below.

**Why the error envelope is a closed catalogue.** The obvious API shape is
`gatewayError({type, code, message, status, requestId})`, i.e. a caller-supplied message. This
implementation deliberately refuses that: `gatewayError(kind, {requestId, …})` takes a *kind* and the message comes
from `GATEWAY_ERRORS`. Sanitization stops being a code-review property ("did every call site remember
to sanitize?") and becomes a type-level one — there is no argument through which an upstream body,
hostname, stack trace, SQL string or tenant key could be passed. Validation detail is limited to
`{path, code}` (never the received value). Every error carries `request_id`, which is also on the
stderr log line for the same request, so a client complaint maps to one log record.

**The `better-sqlite3` / `node:sqlite` adapter.** `src/db/database.ts` exposes
`exec`/`prepare`/`transaction`/`pragmas` and binds **only positional parameters**, so the two drivers
cannot diverge on named-parameter semantics. **The `node` driver is Node's own experimental built-in**
(`node:sqlite`, Node 24, `ROUTER_SQLITE_DRIVER=node`) — that is why `better` is the default. It is
loaded through `createRequire`, so driver `better` never imports the experimental module at all, and the
load site filters **exactly one** message — Node's `ExperimentalWarning: SQLite is an experimental
feature…` — for the duration of that single synchronous `require`. Nothing else is silenced (the test
"loads the node driver quietly but still lets every other warning through" emits a different
`ExperimentalWarning` and requires it to appear), the fallback stays fully exercised, and no assertion
depends on the warning being visible. The driver is switchable because the prebuilt `better-sqlite3`
binary is a deployment dependency a reviewer may not have, while `node:sqlite` is free — and because a
portability claim that is never exercised is not a claim. Both drivers run the full parity blocks in
`tests/unit/database.test.ts`, `tests/unit/token-window.test.ts` and
`tests/concurrency/cross-process.test.ts` (which spawns its workers with
`NODE_OPTIONS=--disable-warning=ExperimentalWarning`, scoped to those children).

**Why `X-RateLimit-*` on a streaming response reflects the reservation.** The final token count of a
stream is unknown when the headers are written (the same trade-off Task 3 documents for its redaction
counter), so streaming responses report the reservation and `/stats` carries the reconciled truth.
Non-streaming responses reconcile *before* the headers are written, so they report the real remaining
budget.

**`Retry-After` answers "when will this request fit?", `X-RateLimit-Reset` answers "when does the window
start freeing?".** They are different questions and the difference matters: an answer derived from the
oldest event alone is often too early (freeing 100 tokens does not make room for a 4 000-token request), and
a client that honours it comes back and is rejected again. On denial the limiter therefore walks the live
window in expiry order and stops at the event that frees *enough* capacity; the header reports that instant.
`X-RateLimit-Reset` keeps the oldest expiry, and the README says which is which.

**Tenant keys: permissive by default, an allow-list when you want one.** Any bearer string becomes its own
50 000-token window, which is what makes the demo a one-liner — and it means rotating a key mints a fresh
window. `ROUTER_TENANT_KEYS` turns that into an allow-list (unlisted keys get 401 and create no row, compared
by SHA-256 digest with `timingSafeEqual`), and the permissive default logs
`tenant_autoprovision_enabled` at boot rather than being silent.

**Rejected: rejecting instead of queueing.** The brief says failover and a standardized error, so a
request over budget gets a `429` with `Retry-After`, not a queue slot. Queueing would hide the limiter
behind latency and make the deadline logic meaningless; it is listed as future work.

## Limitations & future work

- **The admission estimate is not a tokenizer.** `chars/4` plus a per-message and per-tool overhead is
deterministic and cheap, but a code-heavy prompt can be off by 2×. The reconciliation keeps the
*accounting* honest; the *reservation* is approximate. Future work: a `TokenCounter` interface with a real
tokenizer, injected exactly where `estimateTokens` is called today.
- **A single window can still overshoot, but only by the slack between the reservation and reality.** The
  reservation now covers the input estimate *plus* the declared output budget (capped), and a successful
  request is reconciled against real usage — so the overshoot is bounded by `max_tokens` when the client
  declares one, and by the configured reserve when it does not. A client that declares a huge `max_tokens`
  can reserve a large slice of the window and be rejected as `oversized`; that is the deliberate trade-off
  for not letting one request spend the whole budget on a prompt.
- **The in-process mutex is per process.** It is not the correctness mechanism; SQLite is. In a
multi-replica deployment every replica would share the file only if they share a filesystem — beyond
that, the same `TokenWindow` interface needs a Redis (or equivalent) backend. The interface was kept
narrow (`admit`/`reconcile`/`release`/`sweep`/`usage`) precisely so that swap stays local.
- **SQLite is a single writer.** Throughput is ~6 700 admissions/s sequentially on this machine
  (see `npm run bench`); a burst of thousands of *distinct* tenants is bounded by the write lock. WAL
  plus `busy_timeout` plus the retry loop make it degrade into queueing rather than errors, but it is
  not a horizontally scalable rate limiter.
- **Per-tenant window geometry exists in the schema but is not configurable per key yet.** `tenants`
  stores `limit_tokens` and `window_ms` per row and the limiter reads them, but nothing exposes an
  endpoint or CLI to change them; today a row is created from the configured default.
- **Streamed completions from a provider that refuses to report usage are charged the reservation.** The
  gateway asks for `stream_options.include_usage` on every stream, but a provider may ignore the field or
  report usage in a frame larger than the filter's cap; in that case the reservation (input + declared
  output budget) is kept, which is conservative rather than exact. `reconciledFrom` in the request log and
  the `tokens_actual` counter tell you which happened.
- **Any bearer string is a tenant unless you configure otherwise.** With `ROUTER_TENANT_KEYS` unset, a
  rotated key simply gets a fresh window; set the allow-list to close that, and note that the allow-list is
  a static environment variable rather than a key registry with rotation and revocation.
- **`request_log` grows without bound.** It is the audit trail the demo prints, so it is never pruned;
  a retention job (or a partial index) is the obvious next step. `token_events` is bounded by the
  window, and `sweep()` is exposed for a cron to call.
- **Streaming responses are not re-scanned for a second `usage` frame.** The scanner keeps the *last*
  one it sees and gives up (falling back to the estimate) if a single frame exceeds 64 KiB, so an
  exotic provider that reports usage in an unusually large frame is accounted approximately.
- **`node:sqlite` is experimental in Node 24** and is the fallback driver, not the default. Its
  `ExperimentalWarning` is filtered at the one place the module is deliberately loaded (see the design
  note above) — the driver itself, its parity coverage and this limitation all stay exactly as they are;
  the default stays `better` because the built-in API can still change under us.
- **A non-streaming request is bounded by the failover deadline in full.** Providers send the headers of a
  `stream: false` completion only once the completion is *finished*, so `ROUTER_PRIMARY_TIMEOUT_MS`
  (3000 ms) bounds the whole completion there and a long non-streaming answer fails over to the secondary by
  design. Time-to-headers — and with it the first-byte/stall split — is what the streaming mode gets.
- **No PII redaction here.** Task 3 owns that; this router forwards payloads verbatim. Running the two
  together (guardrail in front of the router, or as a shared pipeline stage) is the natural composition
  and is noted in `docs/ARCHITECTURE.md`.

## Verification evidence

Real captured output; the same evidence is in [`VERIFICATION.md`](VERIFICATION.md) with the raw
`sqlite3` dumps.

### `npm test` (offline, includes the hygiene guard)

```
$ cd task-04-router-fallback && npm test
> node scripts/check-logging-hygiene.mjs && vitest run

logging hygiene: OK (17 file(s) scanned in src)

 Test Files  17 passed (17)
      Tests  159 passed (159)
   Duration  8.90s
```

### The two decisive tests

```
$ npx vitest run tests/concurrency/
 ✓ tests/concurrency/limiter-atomicity.test.ts (4 tests) 1359ms
   ✓ limiter atomicity — through the real HTTP gateway (1)
     ✓ answers exactly 8 × 200 and 12 × 429 for 20 parallel requests of 6 000 tokens 1047ms
 ✓ tests/concurrency/cross-process.test.ts (6 tests) 3148ms
   ✓ cross-process limiter (better driver) (3)
     ✓ admits exactly one of two concurrent 30 000-token claims 706ms
     ✓ never exceeds the limit across two processes claiming 20 × 6 000 tokens each 523ms
   ✓ cross-process limiter (node driver) (3)
     ✓ admits exactly one of two concurrent 30 000-token claims 519ms
     ✓ never exceeds the limit across two processes claiming 20 × 6 000 tokens each 519ms

 Test Files  2 passed (2)
      Tests  10 passed (10)
```

### `npm run bench` — the transaction is what makes it exact

```
$ npm run bench

2. burst: 32 concurrent requests × 6000 tokens (only 8 may be admitted)
   run  atomic (mutex)  atomic (no mutex) naive check-then-insert
   1    8/32            8/32              32/32
   2    8/32            8/32              32/32
   3    8/32            8/32              32/32
   4    8/32            8/32              32/32
   5    8/32            8/32              32/32

   expected per run            : exactly 8
   atomic (mutex)   admitted   : 40 / 40  OK
   atomic (no mutex) admitted  : 40 / 40  OK
   naive admitted              : 160 / 40  (4.00× the limit — the bug the transaction prevents)

PASS — the atomic limiter admitted exactly 8 per burst; the naive one did not.
```

### `npm run demo` (excerpt — full transcript in `VERIFICATION.md`)

```
1. healthy primary
   → 200  X-Gateway-Provider: primary  X-Gateway-Fallback: false  attempts: 1
2. primary returns 429 → fail over
   primary calls: 1   secondary calls: 1
   → 200  X-Gateway-Provider: secondary  X-Gateway-Fallback: true  attempts: 2
3. primary hangs (no response) → timeout → fail over
   → 200 after 3007 ms (configured primary timeout: 3000 ms)
4. both providers fail → sanitized 503
   → 503  {"error":{"message":"Upstream provider unavailable","type":"upstream_unavailable",
            "code":"gateway_upstream_error","request_id":"req_4a7c67ab-…"}}
5. burst: 12 × 6000 estimated tokens against a 20000-token limit
   → 3 × 200, 9 × 429
   429: Retry-After=60s  X-RateLimit-Remaining-Tokens=2000

PASS — all scenarios behaved as specified
```

### `sqlite3` — the state really is on disk

```
$ sqlite3 data/router.db 'SELECT tenant_id, kind, tokens FROM token_events ORDER BY id;'
t_34a57504f96ae587|actual|33
t_713c03103ea9b838|actual|33
t_3169cfd6151e06c2|actual|33
t_ac231d0d3ae7dac8|actual|33
t_ac231d0d3ae7dac8|actual|33
t_ac231d0d3ae7dac8|actual|33
```

### Root workspace verification

```
$ cd .. && npm run verify        # hygiene + doc paths + typecheck + every offline suite
logging hygiene: OK (17 file(s) scanned in src)   ← task-04
doc paths: OK (67 file reference(s) across 4 document(s) resolve in 4 task folder(s))
 Test Files  17 passed (17)
      Tests  159 passed (159)                     ← task-04
```

The root command runs all four workspaces and exited `0`.

### Live suite (opt-in, real llama.cpp)

```
$ RUN_LIVE_LLM=1 npm run test:live
 ✓ tests/live/router.live.test.ts (6 tests) 8535ms
     ✓ serves a completion and reconciles the provider usage 768ms
     ✓ streams from the real provider and reconciles the usage frame 335ms
     ✓ streams a real completion that outlives the 3000 ms failover deadline 6947ms
     ✓ fails over from a dead primary to the live model 443ms
 Test Files  1 passed (1)
      Tests  6 passed (6)
```
