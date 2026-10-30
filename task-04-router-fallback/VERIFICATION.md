# Task 4 — verification evidence

Everything below is **captured output**, not prose. Reproduce with:

```bash
cd task-04-router-fallback
npm run hygiene && npm run typecheck && npm test && npm run demo && npm run inspect-db
npm run bench                       # atomic vs naive limiter, and admission throughput
RUN_LIVE_LLM=1 npm run test:live    # opt-in, needs the local llama.cpp server
cd .. && npm run verify             # hygiene + doc paths + typecheck + every suite
```

Environment: Node v24.3.0, better-sqlite3 13.0.3 (prebuilt), sqlite3 CLI 3.50.2, Linux Mint 21.3 /
16 cores. Every offline command runs without a network or a model server.

## 0. Provider deadlines and streamed-usage accounting

Both behaviours below were measured with a small scripted-provider probe against the real gateway on the
default configuration, and both are pinned by the tests cited here.

**Provider deadlines.** The provider deadline is **time-to-headers**, and the body has its own two: the
first byte (prompt processing) and the gap between chunks after that. A 40-frame / 100 ms-per-frame stream
therefore completes on the default configuration:

```json
{
  "primaryTimeoutMs": 3000,
  "status": 200,
  "elapsedMs": 4123,
  "contentFrames": 40,
  "expectedFrames": 40,
  "sawDone": true,
  "sawStreamFailed": false
}
```

Pinned by `tests/unit/provider-client.test.ts` (10 tests: all three deadlines, both timeout phases, a late
first byte that must not be read as a stall, a provider that sends headers and then never starts its body,
and the watchdog switched off) and by an integration test that runs a 40-frame/4-second stream through the
real gateway on the **default** configuration, plus the live suite running with no timeout override at all.

**Streamed-usage accounting.** A provider only reports `usage` on a stream when the request asked for it, and
the OpenAI client default is not to ask — measured against llama.cpp, a 447-token answer was billed as 45. The
gateway therefore asks on the client's behalf and hides the frame again unless the client requested it, so the
accounting is exact and the visible contract is unchanged:

```json
{
  "realProviderUsageTotalTokens": 447,
  "admissionEstimateForThisBody": 45,
  "chargedRows": [
    {
      "request": "no stream_options (OpenAI client default)",
      "kind": "actual",
      "tokens": 447,
      "undercounted": false
    },
    {
      "request": "stream_options.include_usage = true",
      "kind": "actual",
      "tokens": 447,
      "undercounted": false
    }
  ],
  "tenantsAutoCreated": 2
}
```

Pinned by `tests/integration/stream-usage.test.ts` (5 tests, including the upstream request body and the
`stream_options` passthrough) and `tests/unit/usage-filter.test.ts` (10 tests). Admission also reserves the
declared output budget: `tests/unit/counter.test.ts` + the HTTP case in
`tests/integration/rate-limit-headers.test.ts`.

Two further behaviours are covered in the same files: `Retry-After` names the instant *this* request fits
rather than the oldest expiry (`tests/unit/token-window.test.ts`,
`tests/integration/rate-limit-headers.test.ts` — including a retry that succeeds), and `ROUTER_TENANT_KEYS`
turns the permissive auto-provisioning into an allow-list (`tests/integration/tenant-keys.test.ts`).

## 1. `npm run hygiene` + `npm run typecheck`

```
$ npm run hygiene && npm run typecheck

> task-04-router-fallback@1.0.0 hygiene
> node scripts/check-logging-hygiene.mjs

logging hygiene: OK (17 file(s) scanned in src)

> task-04-router-fallback@1.0.0 typecheck
> tsc --noEmit
```

`tsc --noEmit` prints nothing when it is clean and exits non-zero otherwise, so the silence above *is*
the pass (both commands exited `0`). A stricter run with `--noUnusedLocals --noUnusedParameters` is also
clean.

## 2. `npm test` — 17 files / 159 tests, offline, **no warning noise**

```
$ npm test
logging hygiene: OK (17 file(s) scanned in src)
 ✓ tests/unit/config.test.ts (7 tests) 12ms
 ✓ tests/unit/counter.test.ts (16 tests) 12ms
 ✓ tests/unit/usage-filter.test.ts (10 tests) 48ms
 ✓ tests/unit/mutex.test.ts (5 tests) 4ms
 ✓ tests/unit/gateway-errors.test.ts (12 tests) 6ms
 ✓ tests/unit/eviction.test.ts (5 tests) 196ms
 ✓ tests/persistence/restart.test.ts (5 tests) 204ms
 ✓ tests/integration/tenant-keys.test.ts (5 tests) 255ms
 ✓ tests/integration/stream-usage.test.ts (5 tests) 228ms
 ✓ tests/integration/error-sanitization.test.ts (8 tests) 318ms
 ✓ tests/unit/database.test.ts (11 tests) 400ms
 ✓ tests/integration/rate-limit-headers.test.ts (11 tests) 407ms
 ✓ tests/unit/token-window.test.ts (19 tests) 481ms
 ✓ tests/concurrency/limiter-atomicity.test.ts (4 tests) 1224ms
   ✓ limiter atomicity — through the real HTTP gateway (1)
     ✓ answers exactly 8 × 200 and 12 × 429 for 20 parallel requests of 6 000 tokens 1066ms
 ✓ tests/unit/provider-client.test.ts (10 tests) 1844ms
   ✓ callProvider deadlines (10)
     ✓ does not kill a healthy stream that outlives the headers deadline 374ms
     ✓ lets a buffered response that outlives the headers deadline finish 358ms
 ✓ tests/concurrency/cross-process.test.ts (6 tests) 2997ms
   ✓ cross-process limiter (better driver) (3)
     ✓ admits exactly one of two concurrent 30 000-token claims 555ms
     ✓ never exceeds the limit across two processes claiming 20 × 6 000 tokens each 524ms
     ✓ sees the other process's reservations when it starts later 456ms
   ✓ cross-process limiter (node driver) (3)
     ✓ admits exactly one of two concurrent 30 000-token claims 518ms
     ✓ never exceeds the limit across two processes claiming 20 × 6 000 tokens each 520ms
     ✓ sees the other process's reservations when it starts later 423ms
 ✓ tests/integration/failover.test.ts (20 tests) 8669ms
   ✓ failover on 429 / 5xx / network / timeout (6)
     ✓ honours the brief's 3000 ms default primary timeout (slow) 3020ms
   ✓ the failover deadline is time-to-headers, not a total request budget (4)
     ✓ serves a healthy stream that runs far longer than the 3000 ms primary timeout 4120ms
     ✓ serves a buffered completion that outlives the deadline but keeps sending bytes 315ms
 Test Files  17 passed (17)
      Tests  159 passed (159)
   Duration  8.90s (tests 93%, import 4%, transform 2%)
```

`grep -c ExperimentalWarning` over this output: **0**. The `node:sqlite` built-in is loaded by the
driver-parity blocks in `tests/unit/database.test.ts`, `tests/unit/token-window.test.ts` and
`tests/concurrency/cross-process.test.ts`, so its experimental warning is filtered at the single point
where the module is deliberately loaded, and the spawned cross-process workers get
`NODE_OPTIONS=--disable-warning=ExperimentalWarning` in their own env. Nothing else is silenced: the test
"loads the node driver quietly but still lets every other warning through" emits a different
`ExperimentalWarning` in a child process and requires it to appear on stderr.

## 3. The decisive concurrency evidence

`20 parallel × 6 000 tokens vs a 50 000-token limit ⇒ exactly 8 admitted`, asserted at the limiter API
and through the real HTTP gateway; then two OS processes over one SQLite file, on both drivers.

```
$ npx vitest run tests/concurrency/
 ✓ tests/concurrency/limiter-atomicity.test.ts (4 tests) 1169ms
   ✓ limiter atomicity — through the real HTTP gateway (1)
     ✓ answers exactly 8 × 200 and 12 × 429 for 20 parallel requests of 6 000 tokens 1038ms
 ✓ tests/concurrency/cross-process.test.ts (6 tests) 3124ms
   ✓ cross-process limiter (better driver) (3)
     ✓ admits exactly one of two concurrent 30 000-token claims 647ms
     ✓ never exceeds the limit across two processes claiming 20 × 6 000 tokens each 522ms
     ✓ sees the other process's reservations when it starts later 465ms
   ✓ cross-process limiter (node driver) (3)
     ✓ admits exactly one of two concurrent 30 000-token claims 519ms
     ✓ never exceeds the limit across two processes claiming 20 × 6 000 tokens each 540ms
     ✓ sees the other process's reservations when it starts later 429ms
 Test Files  2 passed (2)
      Tests  10 passed (10)
   Duration  3.20s (tests 98%, import 1%)
```

The file on its own, three times in a row — both driver suites green, no `ExperimentalWarning`:

```
$ npx vitest run tests/concurrency/cross-process.test.ts
 ✓ tests/concurrency/cross-process.test.ts (6 tests)
   ✓ cross-process limiter (better driver) (3)
     ✓ admits exactly one of two concurrent 30 000-token claims
     ✓ never exceeds the limit across two processes claiming 20 × 6 000 tokens each
     ✓ sees the other process's reservations when it starts later
   ✓ cross-process limiter (node driver) (3)
     ✓ admits exactly one of two concurrent 30 000-token claims
     ✓ never exceeds the limit across two processes claiming 20 × 6 000 tokens each
     ✓ sees the other process's reservations when it starts later
      Tests  6 passed (6)          ← × 3 consecutive runs
```

## 4. `npm run bench` — why the transaction is the mechanism

The same 32-request burst against the shipped limiter and against a naive check-then-insert variant
implemented side by side in the script (the naive one reads in one transaction, yields, then inserts in
another):

```
$ npm run bench
Task 4 — limiter bench (on-disk SQLite, no network, no model)
database /tmp/task04-bench-moIuS6   limit 50000 tokens / 60 s   request size 6000 tokens

1. admission throughput (sequential, one connection)
----------------------------------------------------
      200 admissions in      8.4 ms →   23905 admits/s (42 µs each, one transaction per admission)
     2000 admissions in    262.8 ms →    7611 admits/s (131 µs each, one transaction per admission)

2. burst: 32 concurrent requests × 6000 tokens (only 8 may be admitted)
-----------------------------------------------------------------------
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

3. cost of the per-tenant mutex (2 000 sequential admissions)
-------------------------------------------------------------
   without mutex       269.5 ms  (135 µs per admission)
   with mutex          276.6 ms  (138 µs per admission)

PASS — the atomic limiter admitted exactly 8 per burst; the naive one did not.
```

## 5. `npm run demo` — offline transcript (scripted providers)

```
$ npm run demo

> task-04-router-fallback@1.0.0 demo
> node scripts/demo.mjs

Task 4 — rate-limiting & model fallback router: offline demo (scripted providers, no model server)
gateway   http://127.0.0.1:44609   sqlite /home/eli/Documents/quilr/task-04-router-fallback/data/router.db (WAL, limit 20000 tokens / 60 s per tenant key)
primary   http://127.0.0.1:33543/v1   secondary http://127.0.0.1:38491/v1
note      provider errors carry sentinel strings; the demo checks they never reach a client

1. healthy primary
------------------
   → 200  X-Gateway-Provider: primary  X-Gateway-Fallback: false  attempts: 1
   X-RateLimit-Limit-Tokens: 20000  Remaining: 19967  Reset: 1793309437
   body: {"id":"chatcmpl-demo","object":"chat.completion","created":1700000000,"model":"demo-model","choices":[{"index":0,"messag…

2. primary returns 429 → fail over
----------------------------------
   primary calls: 1   secondary calls: 1
   → 200  X-Gateway-Provider: secondary  X-Gateway-Fallback: true  attempts: 2

3. primary hangs (no response) → timeout → fail over
----------------------------------------------------
   → 200 after 3006 ms (configured primary timeout: 3000 ms)
   X-Gateway-Provider: secondary  X-Gateway-Fallback: true

4. both providers fail → sanitized 503
--------------------------------------
   → 503  {"error":{"message":"Upstream provider unavailable","type":"upstream_unavailable","code":"gateway_upstream_error","request_id":"req_32fbb35e-65b0-40e5-8af9-7a8fb22e3df0"}}
   same case with two closed ports (the `network` branch):
   → 503  {"error":{"message":"Upstream provider unavailable","type":"upstream_unavailable","code":"gateway_upstream_error","request_id":"req_4c1e9516-947f-4384-a634-c37571c30783"}}

5. burst: 12 × 6000 estimated tokens against a 20000-token limit
----------------------------------------------------------------
   → 3 × 200, 9 × 429
   429: Retry-After=60s  X-RateLimit-Remaining-Tokens=2000  {"error":{"message":"Rate limit exceeded for this tenant key","type":"rate_limit_exceeded","code":"gateway_rate_limited","request_id":"req_6…
   429: Retry-After=60s  X-RateLimit-Remaining-Tokens=2000  {"error":{"message":"Rate limit exceeded for this tenant key","type":"rate_limit_exceeded","code":"gateway_rate_limited","request_id":"req_c…
   429: Retry-After=60s  X-RateLimit-Remaining-Tokens=2000  {"error":{"message":"Rate limit exceeded for this tenant key","type":"rate_limit_exceeded","code":"gateway_rate_limited","request_id":"req_3…
   tenant id for key "demo-burst": t_ac231d0d3ae7dac8

6. counters (GET /stats)
------------------------
   requests=16 admitted=7 rate_limited=9
   provider_primary=4 provider_secondary=2 failovers=2
   upstream_errors=4 upstream_timeouts=1 reservations_released=1
   tokens_reserved=18048 tokens_actual=198
   window: 20000 tokens / 60000 ms, driver=better, failoverOn=[429,500,502,503,504,timeout,network]
   GET /metrics (Prometheus): gateway_requests_total 16  gateway_admitted_total 7  gateway_rate_limited_total 9  gateway_failovers_total 2

7. on-disk SQLite state
-----------------------
journal_mode=wal (persistent) · busy_timeout=5000ms (this read-only connection; the gateway sets the same value)

tenants (6)
  tenant_id           limit_tokens  window_ms  created_at   
  ------------------  ------------  ---------  -------------
  t_3169cfd6151e06c2  20000         60000      1793309376304
  t_32a7f61bdda74d2f  50000         60000      1793309379317
  t_34a57504f96ae587  20000         60000      1793309376286
  t_713c03103ea9b838  20000         60000      1793309376299
  t_ac231d0d3ae7dac8  20000         60000      1793309379324
  t_d2db1ccb59c7cb8d  20000         60000      1793309379310

token_events (6) — reservations are estimates, actual rows came from provider usage
  tenant_id           kind    tokens  provider   window_ts      request_id                              
  ------------------  ------  ------  ---------  -------------  ----------------------------------------
  t_34a57504f96ae587  actual  33      primary    1793309376286  req_1e0c5b2b-18ee-41f3-90eb-d3d72831ca15
  t_713c03103ea9b838  actual  33      secondary  1793309376299  req_d9f13f3b-9020-4558-b902-3e348b8154c6
  t_3169cfd6151e06c2  actual  33      secondary  1793309376304  req_ae1fc96e-7689-4b3a-812d-79af6a5fa37a
  t_ac231d0d3ae7dac8  actual  33      primary    1793309379324  req_043a2d1e-199e-432b-97f9-c2f19b54487f
  t_ac231d0d3ae7dac8  actual  33      primary    1793309379325  req_5c7bf827-92d5-4469-af6e-9626c62f4434
  t_ac231d0d3ae7dac8  actual  33      primary    1793309379328  req_0e0ec354-fd0f-43ed-90e4-f00523a53322

live window (window_ts > now - 60 s)
  tenant_id           kind    events  tokens
  ------------------  ------  ------  ------
  t_3169cfd6151e06c2  actual  1       33    
  t_34a57504f96ae587  actual  1       33    
  t_713c03103ea9b838  actual  1       33    
  t_ac231d0d3ae7dac8  actual  3       99    

token totals per tenant
  tenant_id           reserved  actual
  ------------------  --------  ------
  t_3169cfd6151e06c2  0         33    
  t_34a57504f96ae587  0         33    
  t_713c03103ea9b838  0         33    
  t_ac231d0d3ae7dac8  0         99    

request_log (last 10 of 17)
  request_id                                tenant_id           provider  outcome       failover  total_tokens  latency_ms
  ----------------------------------------  ------------------  --------  ------------  --------  ------------  ----------
  req_0e0ec354-fd0f-43ed-90e4-f00523a53322  t_ac231d0d3ae7dac8  primary   ok            0         33            254       
  req_5c7bf827-92d5-4469-af6e-9626c62f4434  t_ac231d0d3ae7dac8  primary   ok            0         33            256       
  req_043a2d1e-199e-432b-97f9-c2f19b54487f  t_ac231d0d3ae7dac8  primary   ok            0         33            255       
  req_50e949c3-dc19-4280-a80b-03e22c67bbaf  t_ac231d0d3ae7dac8  -         rate_limited  0         -             0         
  req_329a2988-803b-4b3f-952f-e36180583a6b  t_ac231d0d3ae7dac8  -         rate_limited  0         -             0         
  req_e1bb3198-8726-47b7-8bf7-84f18b561080  t_ac231d0d3ae7dac8  -         rate_limited  0         -             0         
  req_af512db4-230f-49f2-8b6d-2a6ad6a526e8  t_ac231d0d3ae7dac8  -         rate_limited  0         -             0         
  req_704cb943-4537-4f53-b574-ae744699f7f8  t_ac231d0d3ae7dac8  -         rate_limited  0         -             0         
  req_63bae3a7-9fe5-4133-9e74-d11b4a6d893a  t_ac231d0d3ae7dac8  -         rate_limited  0         -             1         
  req_33c2ebd5-86ed-466f-8edf-1dcad270e23f  t_ac231d0d3ae7dac8  -         rate_limited  0         -             1         

$ sqlite3 /home/eli/Documents/quilr/task-04-router-fallback/data/router.db 'SELECT tenant_id, kind, tokens FROM token_events ORDER BY id;'
t_34a57504f96ae587|actual|33
t_713c03103ea9b838|actual|33
t_3169cfd6151e06c2|actual|33
t_ac231d0d3ae7dac8|actual|33
t_ac231d0d3ae7dac8|actual|33
t_ac231d0d3ae7dac8|actual|33

PASS — all scenarios behaved as specified
```

### 5b. The gateway's stderr log lines for the same run

One JSON object per line on stderr; `reqId` is joinable to the error envelopes in section 11. No tenant
key, prompt or upstream body is ever logged (only the hash-derived tenant id and a key fingerprint).

```
{"ts":"2026-10-29T21:29:36.271Z","level":"warn","event":"tenant_autoprovision_enabled","service":"router-fallback","detail":"any bearer string becomes its own tenant window; set ROUTER_TENANT_KEYS to restrict this"}
{"ts":"2026-10-29T21:29:36.300Z","level":"warn","event":"provider_attempt_failed","service":"router-fallback","reqId":"req_d9f13f3b-9020-4558-b902-3e348b8154c6","tenant":"t_713c03103ea9b838","provider":"primary","kind":"rate_limited","status":429,"elapsedMs":1}
{"ts":"2026-10-29T21:29:39.306Z","level":"warn","event":"provider_attempt_failed","service":"router-fallback","reqId":"req_ae1fc96e-7689-4b3a-812d-79af6a5fa37a","tenant":"t_3169cfd6151e06c2","provider":"primary","kind":"timeout","elapsedMs":3002}
{"ts":"2026-10-29T21:29:39.312Z","level":"warn","event":"provider_attempt_failed","service":"router-fallback","reqId":"req_32fbb35e-65b0-40e5-8af9-7a8fb22e3df0","tenant":"t_d2db1ccb59c7cb8d","provider":"primary","kind":"http","status":500,"elapsedMs":1}
{"ts":"2026-10-29T21:29:39.313Z","level":"warn","event":"provider_attempt_failed","service":"router-fallback","reqId":"req_32fbb35e-65b0-40e5-8af9-7a8fb22e3df0","tenant":"t_d2db1ccb59c7cb8d","provider":"secondary","kind":"http","status":500,"elapsedMs":1}
{"ts":"2026-10-29T21:29:39.313Z","level":"warn","event":"all_attempts_failed","service":"router-fallback","reqId":"req_32fbb35e-65b0-40e5-8af9-7a8fb22e3df0","tenant":"t_d2db1ccb59c7cb8d","attempts":2,"failures":["http","http"],"httpStatuses":[500,500],"errorKind":"upstream_unavailable","status":503}
{"ts":"2026-10-29T21:29:39.313Z","level":"warn","event":"request_rejected","service":"router-fallback","reqId":"req_32fbb35e-65b0-40e5-8af9-7a8fb22e3df0","tenant":"t_d2db1ccb59c7cb8d","keyFingerprint":"d2db1ccb","code":"gateway_upstream_error","status":503}
{"ts":"2026-10-29T21:29:39.316Z","level":"warn","event":"tenant_autoprovision_enabled","service":"router-fallback","detail":"any bearer string becomes its own tenant window; set ROUTER_TENANT_KEYS to restrict this"}
… (30 lines total)
```

## 6. `npm run inspect-db` — the on-disk state after the demo

```
$ npm run inspect-db
Task 4 — SQLite inspection: /home/eli/Documents/quilr/task-04-router-fallback/data/router.db
========================================================================
journal_mode=wal (persistent) · busy_timeout=5000ms (this read-only connection; the gateway sets the same value)

tenants (6)
  tenant_id           limit_tokens  window_ms  created_at   
  ------------------  ------------  ---------  -------------
  t_3169cfd6151e06c2  20000         60000      1793309376304
  t_32a7f61bdda74d2f  50000         60000      1793309379317
  t_34a57504f96ae587  20000         60000      1793309376286
  t_713c03103ea9b838  20000         60000      1793309376299
  t_ac231d0d3ae7dac8  20000         60000      1793309379324
  t_d2db1ccb59c7cb8d  20000         60000      1793309379310

token_events (6) — reservations are estimates, actual rows came from provider usage
  tenant_id           kind    tokens  provider   window_ts      request_id                              
  ------------------  ------  ------  ---------  -------------  ----------------------------------------
  t_34a57504f96ae587  actual  33      primary    1793309376286  req_1e0c5b2b-18ee-41f3-90eb-d3d72831ca15
  t_713c03103ea9b838  actual  33      secondary  1793309376299  req_d9f13f3b-9020-4558-b902-3e348b8154c6
  t_3169cfd6151e06c2  actual  33      secondary  1793309376304  req_ae1fc96e-7689-4b3a-812d-79af6a5fa37a
  t_ac231d0d3ae7dac8  actual  33      primary    1793309379324  req_043a2d1e-199e-432b-97f9-c2f19b54487f
  t_ac231d0d3ae7dac8  actual  33      primary    1793309379325  req_5c7bf827-92d5-4469-af6e-9626c62f4434
  t_ac231d0d3ae7dac8  actual  33      primary    1793309379328  req_0e0ec354-fd0f-43ed-90e4-f00523a53322

live window (window_ts > now - 60 s)
  tenant_id           kind    events  tokens
  ------------------  ------  ------  ------
  t_3169cfd6151e06c2  actual  1       33    
  t_34a57504f96ae587  actual  1       33    
  t_713c03103ea9b838  actual  1       33    
  t_ac231d0d3ae7dac8  actual  3       99    

token totals per tenant
  tenant_id           reserved  actual
  ------------------  --------  ------
  t_3169cfd6151e06c2  0         33    
  t_34a57504f96ae587  0         33    
  t_713c03103ea9b838  0         33    
  t_ac231d0d3ae7dac8  0         99    

request_log (last 10 of 17)
  request_id                                tenant_id           provider  outcome       failover  total_tokens  latency_ms
  ----------------------------------------  ------------------  --------  ------------  --------  ------------  ----------
  req_0e0ec354-fd0f-43ed-90e4-f00523a53322  t_ac231d0d3ae7dac8  primary   ok            0         33            254       
  req_5c7bf827-92d5-4469-af6e-9626c62f4434  t_ac231d0d3ae7dac8  primary   ok            0         33            256       
  req_043a2d1e-199e-432b-97f9-c2f19b54487f  t_ac231d0d3ae7dac8  primary   ok            0         33            255       
  req_50e949c3-dc19-4280-a80b-03e22c67bbaf  t_ac231d0d3ae7dac8  -         rate_limited  0         -             0         
  req_329a2988-803b-4b3f-952f-e36180583a6b  t_ac231d0d3ae7dac8  -         rate_limited  0         -             0         
  req_e1bb3198-8726-47b7-8bf7-84f18b561080  t_ac231d0d3ae7dac8  -         rate_limited  0         -             0         
  req_af512db4-230f-49f2-8b6d-2a6ad6a526e8  t_ac231d0d3ae7dac8  -         rate_limited  0         -             0         
  req_704cb943-4537-4f53-b574-ae744699f7f8  t_ac231d0d3ae7dac8  -         rate_limited  0         -             0         
  req_63bae3a7-9fe5-4133-9e74-d11b4a6d893a  t_ac231d0d3ae7dac8  -         rate_limited  0         -             1         
  req_33c2ebd5-86ed-466f-8edf-1dcad270e23f  t_ac231d0d3ae7dac8  -         rate_limited  0         -             1         

$ sqlite3 /home/eli/Documents/quilr/task-04-router-fallback/data/router.db 'SELECT tenant_id, kind, tokens FROM token_events ORDER BY id;'
t_34a57504f96ae587|actual|33
t_713c03103ea9b838|actual|33
t_3169cfd6151e06c2|actual|33
t_ac231d0d3ae7dac8|actual|33
t_ac231d0d3ae7dac8|actual|33
t_ac231d0d3ae7dac8|actual|33
```

## 7. Raw `sqlite3` dumps (reproducible with the `sqlite3` CLI)

```
$ sqlite3 data/router.db '.schema token_events'
CREATE TABLE token_events (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id      TEXT NOT NULL,
  window_ts      INTEGER NOT NULL,          -- epoch ms; the sliding-window key
  tokens         INTEGER NOT NULL,          -- estimate while reserved, actual after reconcile
  kind           TEXT NOT NULL,             -- 'reservation' | 'actual'
  reservation_id TEXT,                      -- links a reconciled 'actual' row to its reservation
  request_id     TEXT NOT NULL,
  provider       TEXT,
  created_at     INTEGER NOT NULL
);
CREATE INDEX idx_token_events_tenant_ts ON token_events (tenant_id, window_ts);
CREATE INDEX idx_token_events_reservation ON token_events (reservation_id);
```

```
$ sqlite3 data/router.db 'PRAGMA journal_mode; PRAGMA synchronous; PRAGMA busy_timeout;'
wal
2
0
```

Note on the last two values: `synchronous` and `busy_timeout` are **per-connection** settings, so the CLI
reports its own defaults (`2` = `FULL`, `0` = no timeout) rather than the gateway's. The connection the
gateway opens sets `synchronous = NORMAL` (1) and `busy_timeout = 5000`; `journal_mode = wal` *is*
persistent and shows up here. `tests/unit/database.test.ts` asserts the gateway's values on **both**
drivers.

```
$ sqlite3 data/router.db 'SELECT tenant_id, kind, tokens, provider FROM token_events ORDER BY id;'
t_34a57504f96ae587|actual|33|primary
t_713c03103ea9b838|actual|33|secondary
t_3169cfd6151e06c2|actual|33|secondary
t_ac231d0d3ae7dac8|actual|33|primary
t_ac231d0d3ae7dac8|actual|33|primary
t_ac231d0d3ae7dac8|actual|33|primary
```

```
$ sqlite3 data/router.db 'SELECT tenant_id, limit_tokens, window_ms FROM tenants ORDER BY tenant_id;'
t_3169cfd6151e06c2|20000|60000
t_32a7f61bdda74d2f|50000|60000
t_34a57504f96ae587|20000|60000
t_713c03103ea9b838|20000|60000
t_ac231d0d3ae7dac8|20000|60000
t_d2db1ccb59c7cb8d|20000|60000
```

```
$ sqlite3 data/router.db 'SELECT outcome, count(*) FROM request_log GROUP BY outcome;'
failover|2
ok|4
rate_limited|9
upstream_error|2
```

Every admitted request ended as an `actual` row carrying the provider's `usage`, and the `request_log`
records the rejections, successes, failovers and upstream errors the demo's `GET /stats` section prints.

## 8. Root workspace verification

```
$ npm run verify                                     # from the repository root
logging hygiene: OK (17 file(s) scanned in src)      ← task-04
doc paths: OK (67 file reference(s) across 4 document(s) resolve in 4 task folder(s))
 Test Files  17 passed (17)
      Tests  159 passed (159)                        ← task-04
exit status 0
```

The root command runs all four workspaces (676 offline tests in total) and exited `0`.

## 9. Live suite against the real model (opt-in), with default timeouts

```
$ RUN_LIVE_LLM=1 npm run test:live

> task-04-router-fallback@1.0.0 test:live
> vitest run --config vitest.live.config.ts


 RUN  v5.0.5 /home/eli/Documents/quilr/task-04-router-fallback

 ✓ tests/live/router.live.test.ts (6 tests) 10268ms
   ✓ live: router against the local model server (6)
     ✓ serves a completion and reconciles the provider usage 768ms
     ✓ streams from the real provider and reconciles the usage frame 386ms
     ✓ streams a real completion that outlives the 3000 ms failover deadline 8549ms
     ✓ fails over from a dead primary to the live model 516ms

 Test Files  1 passed (1)
      Tests  6 passed (6)
   Start at  15:29:59
   Duration  10.39s (tests 99%)
```

## 10. `npm run demo:live` — the router against llama.cpp

```
$ npm run demo:live
Task 4 — live demo against the local OpenAI-compatible server
model http://127.0.0.1:8080/v1 → gateway http://127.0.0.1:37711   sqlite /tmp/task04-live-tp8c8k/live.db
note: every request sends an explicit max_tokens (llama.cpp defaults to -1 = unbounded)

1. buffered completion (max_tokens 512)
---------------------------------------
   → 200 after 196 ms  X-Gateway-Provider: primary
   X-RateLimit-Remaining-Tokens: 49825
   body: {"choices":[{"finish_reason":"stop","index":0,"message":{"role":"assistant","content":"pong"}}],"created":1793309410,"model":"qwen3.8-turbo","system_fingerprint":"b10868-304665fe7","object":"chat.completion","usage":{"co…

2. streamed completion (stream_options.include_usage)
-----------------------------------------------------
   → 200  content-type: text/event-stream  frames: 13
   terminator: [DONE] present

3. failover: dead primary, real model as secondary
--------------------------------------------------
   → 200  X-Gateway-Provider: secondary  X-Gateway-Fallback: true  attempts: 2
   body: {"choices":[{"finish_reason":"stop","index":0,"message":{"role":"assistant","content":"pong"}}],"created":1793309411,"model":"qwen3.8-turbo","system_fingerprint":"b10868-304665fe7","object":"chat.completion","usage":{"co…

4. token accounting from SQLite
-------------------------------
journal_mode=wal (persistent) · busy_timeout=5000ms (this read-only connection; the gateway sets the same value)

tenants (2)
  tenant_id           limit_tokens  window_ms  created_at   
  ------------------  ------------  ---------  -------------
  t_7803a18249da51a1  50000         60000      1793309410575
  t_c34ae50cdd674fa6  50000         60000      1793309410766

token_events (2) — reservations are estimates, actual rows came from provider usage
  tenant_id           kind    tokens  provider  window_ts      request_id                              
  ------------------  ------  ------  --------  -------------  ----------------------------------------
  t_7803a18249da51a1  actual  175     primary   1793309410575  req_f78aaaf8-444a-402a-97b2-ad9487b10d96
  t_c34ae50cdd674fa6  actual  189     primary   1793309410766  req_dae702fa-623d-44de-b1cc-2d4e1a5dd5dd

live window (window_ts > now - 60 s)
  tenant_id           kind    events  tokens
  ------------------  ------  ------  ------
  t_7803a18249da51a1  actual  1       175   
  t_c34ae50cdd674fa6  actual  1       189   

token totals per tenant
  tenant_id           reserved  actual
  ------------------  --------  ------
  t_7803a18249da51a1  0         175   
  t_c34ae50cdd674fa6  0         189   

request_log (last 2 of 2)
  request_id                                tenant_id           provider  outcome  failover  total_tokens  latency_ms
  ----------------------------------------  ------------------  --------  -------  --------  ------------  ----------
  req_dae702fa-623d-44de-b1cc-2d4e1a5dd5dd  t_c34ae50cdd674fa6  primary   ok       0         189           419       
  req_f78aaaf8-444a-402a-97b2-ad9487b10d96  t_7803a18249da51a1  primary   ok       0         175           187       

PASS — the router served, streamed and failed over against the real model
```

## 11. Error-envelope shapes (captured verbatim from the demo)

| Scenario | Status | Body |
| --- | --- | --- |
| gateway window exhausted | `429` | `{"error":{"message":"Rate limit exceeded for this tenant key","type":"rate_limit_exceeded","code":"gateway_rate_limited","request_id":"req_…"}}` |
| key not in `ROUTER_TENANT_KEYS` | `401` | `{"error":{"message":"Missing or invalid tenant API key","type":"invalid_request","code":"gateway_unauthorized","request_id":"req_…"}}` (no tenant row created) |
| both providers 5xx | `503` | `{"error":{"message":"Upstream provider unavailable","type":"upstream_unavailable","code":"gateway_upstream_error","request_id":"req_…"}}` |
| both providers rate-limit | `429` | `{"error":{"message":"Upstream provider rate limit exceeded","type":"rate_limit_exceeded","code":"gateway_upstream_rate_limited","request_id":"req_…"}}` |
| both providers hang | `504` | `{"error":{"message":"Upstream provider timed out","type":"upstream_timeout","code":"gateway_upstream_timeout","request_id":"req_…"}}` |
| missing key | `401` | `{"error":{"message":"Missing or invalid tenant API key","type":"invalid_request","code":"gateway_unauthorized","request_id":"req_…"}}` |
| mid-stream provider death or stall | `200` + SSE | `data: {"error":{"message":"Upstream stream failed","type":"upstream_unavailable","code":"gateway_stream_failed","request_id":"req_…"}}` then `data: [DONE]` |

None of these contains an upstream body, hostname, stack frame, SQL string or the tenant key;
`tests/integration/error-sanitization.test.ts` asserts exactly that with injected sentinel strings.

Also captured: `npm start` boots and answers

```
$ curl -s http://127.0.0.1:8791/healthz
{"status":"ok","driver":"better","journalMode":"wal","windowMs":60000,"limitTokens":50000,
 "tenantMode":"auto-provision","streamIdleTimeoutMs":30000,
 "providers":{"primary":"127.0.0.1:8080","secondary":"127.0.0.1:8080"}}

$ curl -s -X POST http://127.0.0.1:8791/v1/chat/completions -d '{"messages":[{"role":"user","content":"hi"}]}'
{"error":{"message":"Missing or invalid tenant API key","type":"invalid_request",
 "code":"gateway_unauthorized","request_id":"req_1bf94a66-13a1-4fb3-a685-52ba45720bd6"}} [401]

$ ROUTER_PORT=0 npx tsx src/server.ts
{"level":"error","event":"gateway_boot_failed","message":"Invalid router configuration:\n  - port: Too small: expected number to be >=1"}
```

A misconfigured port fails fast with a readable message instead of binding something surprising.
