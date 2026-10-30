# Task 3 — verification evidence

All output below was captured on this machine (Linux Mint 21.3, Node v24.3.0, npm 11.4.2) by the
commands shown. Nothing here is a paraphrase: copy/paste of the terminal.

| # | Command | Result |
| --- | --- | --- |
| 1 | `npm run hygiene && npm run typecheck` | hygiene OK (9 files), `tsc --noEmit` clean |
| 2 | `npm test` | 154 tests, 9 files, all passed (1.2 s) |
| 3 | `npm run demo` | exit 0 — `PASS`, 0 leaks, 6 redactions |
| 4 | `npm run bench` | exit 0 — TTFT +0.5 ms, no measurable throughput cost |
| 5 | `npm run test:live` (no `RUN_LIVE_LLM`) | 2 skipped, exit 0 |
| 6 | `RUN_LIVE_LLM=1 npm run test:live` | 2 passed against the real llama.cpp server (18.8 s) |
| 7 | `npm run demo:live` | exit 0 — 4 redactions, 0 leaks, `[DONE]` preserved |
| 8 | `npm run verify` (repo root) | hygiene + typecheck + all four workspaces green |

---

## 1–2. Hygiene, typecheck and the offline suite

```
> task-03-streaming-guardrail@1.0.0 test
logging hygiene: OK (9 file(s) scanned in src)
 RUN  v5.0.5 /home/eli/Documents/quilr_test/ai-field-dev-assessment/task-03-streaming-guardrail
 ✓ tests/unit/chunk-mapper.test.ts (14 tests) 8ms
 ✓ tests/unit/patterns.test.ts (35 tests) 8ms
 ✓ tests/unit/sse-parser.test.ts (33 tests) 17ms
 ✓ tests/unit/config.test.ts (7 tests) 7ms
 ✓ tests/integration/non-streaming.test.ts (6 tests) 43ms
 ✓ tests/integration/redaction-stream.test.ts (10 tests) 144ms
 ✓ tests/integration/error-handling.test.ts (10 tests) 560ms
 ✓ tests/integration/latency.test.ts (3 tests) 1019ms
 ✓ tests/unit/streaming-redactor.test.ts (36 tests) 1101ms
 Test Files  9 passed (9)
      Tests  154 passed (154)
   Duration  1.19s (tests 88%, import 10%, transform 1%, worker 1%)
```

The decisive assertions inside that run:

- **`matches whole-string redaction at EVERY split index`** — 22 fixtures × every split index;
- **`matches whole-string redaction when fed one character at a time`** and for every chunk size 1..17;
- **`matches whole-string redaction when values are spliced into random contexts at random splits`** —
  120 randomised rounds, 2-way splits plus random chunk sizes;
- **`produces identical events for <frame>`** (15 SSE frames × every byte boundary) and
  `produces identical events when fed one byte at a time`;
- **`agrees with a naive ascending suffix loop over every possible holdback`** — the fast holdback equals the
  literal k-loop formulation on a sample set;
- **`keeps maxBufferSeen bounded while streaming 5 MB`** — `/stats.maxBufferSeen` ≤ 512 B, 32 redactions;
- **`never lets a raw PII value appear anywhere in the response bytes`** — 12 sentinels scanned across the
  whole client stream.


## 3. Demo (`npm run demo`) — offline, no model server

```
Task 3 — streaming PII guardrail: offline demo (scripted provider, no model server)
upstream http://127.0.0.1:40371/v1  →  gateway http://127.0.0.1:38213

1. What the provider sent (raw SSE frames)
  data: {...,"delta":{"role":"assistant","content":"Hi, your card 4012"},"finish_reason":null}
  data: {...,"delta":{"content":"8888 8888"},"finish_reason":null}
  data: {...,"delta":{"content":" 1881 was charged 12.50. "},"finish_reason":null}
  data: {...,"delta":{"content":"Receipt to alice@"},"finish_reason":null}
  data: {...,"delta":{"content":"example.com, SSN 078-"},"finish_reason":null}
  data: {...,"delta":{"content":"05-1120, order ORD-10234 dated 2026-10-29 (v5.9.3). "},"finish_reason":null}
  data: {...,"delta":{"reasoning_content":"Checking alice@exam"},"finish_reason":null}
  data: {...,"delta":{"reasoning_content":"ple.com against host 10.0.0.42. "},"finish_reason":null}
  data: {...,"delta":{"tool_calls":[{"index":0,...,"arguments":"{\"email\":\"bob@ex"}}]},"finish_reason":null}
  data: {...,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"ample.com\"}"}}]},"finish_reason":null}
  data: {...,"delta":{},"finish_reason":"stop"}
  data: [DONE]

2. What the client received (guarded SSE frames)
  data: {...,"delta":{"role":"assistant","content":"Hi, your card "},"finish_reason":null}
  data: {...,"delta":{"content":""},"finish_reason":null}        ← value withheld, nothing safe to emit yet
  data: {...,"delta":{"content":"[REDACTED] was charged 12."},"finish_reason":null}
  data: {...,"delta":{"content":"50. Receipt to "},"finish_reason":null}
  data: {...,"delta":{"content":"[REDACTED], SSN"},"finish_reason":null}
  data: {...,"delta":{"content":" [REDACTED], order ORD-10234 dated 2026-10-29 (v5.9."},"finish_reason":null}
  data: {...,"delta":{"reasoning_content":"Checking "},"finish_reason":null}
  data: {...,"delta":{"reasoning_content":"[REDACTED] against host "},"finish_reason":null}
  data: {...,"delta":{"tool_calls":[{"index":0,...,"arguments":"{\"email\":\""}}]},"finish_reason":null}
  data: {...,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"[REDACTED]\"}"}}]},"finish_reason":null}
  data: {...,"delta":{"content":"3). ","reasoning_content":"[REDACTED]. "},"finish_reason":"stop"}
  data: [DONE]

3. Reassembled client view
  content            : Hi, your card [REDACTED] was charged 12.50. Receipt to [REDACTED], SSN [REDACTED], order ORD-10234 dated 2026-10-29 (v5.9.3).
  reasoning_content  : Checking [REDACTED] against host [REDACTED].
  tool arguments     : {"email":"[REDACTED]"}

4. Summary
  redactions         : 6 (1 credit_card, 3 email, 1 ssn, 1 ipv4)
  leaks              : 0
  benign values kept : 3/3 (ORD-10234, 2026-10-29, 5.9.3)
  max buffer seen    : 13 bytes (cap 512)
  bytes              : 2379 in → 2387 out, 12 frames in / 11 out
  framing            : [DONE] preserved
  note               : an empty "content" delta means the redactor withheld the tail of a
                       value that could still be completed by the next frame.

PASS — no raw PII reached the client
```

## 4. Bench (`npm run bench`) — TTFT and throughput, direct vs guarded

```
Task 3 — TTFT bench: 20 runs, 200 tokens at 20 ms/token (scripted provider, no model)

TTFT — time to the first client-visible SSE chunk, and to the first non-empty content
scenario                         path     TTFT mean  TTFT p95  first content  total mean
-------------------------------  -------  ---------  --------  -------------  ----------
first delta "Hello" (bare word)  direct   21.6 ms    22.6 ms   21.7 ms        —
first delta "Hello" (bare word)  guarded  22.1 ms    23.2 ms   41.7 ms        —
first delta "Hello" (bare word)  delta    +0.5 ms    —         +20.1 ms       —
first delta "Hello, here is…"    direct   21.2 ms    21.5 ms   21.2 ms        —
first delta "Hello, here is…"    guarded  22.4 ms    23.5 ms   22.5 ms        —
first delta "Hello, here is…"    delta    +1.3 ms    —         +1.2 ms        —

Total stream duration (3 full runs of 200 tokens)
scenario     path     TTFT mean  TTFT p95  first content  total mean
-----------  -------  ---------  --------  -------------  ----------
full stream  direct   20.9 ms    21.1 ms   20.9 ms        4061.2 ms
full stream  guarded  22.2 ms    22.3 ms   41.9 ms        4060.3 ms
full stream  delta    +1.2 ms    —         +20.9 ms       -1.0 ms

Guardrail state after the bench
  streams             : 23
  redactions          : 0
  max retained buffer : 9 bytes (cap 512)
  holdback cap hits   : 0
  bytes proxied       : 120017 in / 119873 out

TTFT cost of guarding : +0.5 ms to the first SSE frame; +20.1 ms to the first non-empty content (≤ one 20 ms token); +1.3 ms when the first delta is prose
Throughput cost       : -1.0 ms over a 200-token stream (-0.00 ms/token of added latency)
```

Reading of the table: the first **SSE frame** reaches the client within measurement noise of the
unguarded path. When the provider's *first delta is a bare word* (the worst case — that word could still
be the start of an email), the redactor withholds it, so the first frame carries an empty `content` and
the first *non-empty* content arrives one token later. When the first delta is prose the content is
released immediately (+1.2 ms). Total stream duration is unchanged within noise, i.e. redaction is not on
the critical path.

## 5–7. Live runs against the real model server

```
$ npm run test:live                     # RUN_LIVE_LLM unset
 ↓ tests/live/redaction.live.test.ts (2 tests | 2 skipped)
 Test Files  1 skipped (1)   Tests  2 skipped (2)      exit 0

$ RUN_LIVE_LLM=1 npm run test:live      # llama.cpp on 127.0.0.1:8080
 ✓ tests/live/redaction.live.test.ts (2 tests) 18793ms
     ✓ never emits raw PII and keeps the SSE framing intact 1585ms
     ✓ scrubs reasoning_content, which this server streams as a separate field 17206ms
 Test Files  1 passed (1)   Tests  2 passed (2)

$ npm run demo:live
Task 3 — live demo against http://127.0.0.1:8080/v1 (model qwen3.8-turbo)

client-visible content : customer [REDACTED] card [REDACTED] ssn [REDACTED] host [REDACTED]

summary
  first SSE frame      : 358 ms after the request
  frames               : 394
  redactions           : 4 ({"email":1,"credit_card":1,"ssn":1,"ipv4":1})
  leaks                : 0
  max retained buffer  : 21 bytes (cap 512)
  [DONE] preserved     : true
  unparsed events      : 0
```

The live prompt asks the model to echo `bob.smith@example.com`, `4111-1111-1111-1111`, `123-45-6789` and
`10.0.0.42`. All four were redacted, none appeared in the client stream, and 394 frames were forwarded with
the `[DONE]` sentinel intact. The second live test omits `reasoning_effort: none`, so the server streams
`delta.reasoning_content`; the assertion is that neither fixture value survives in that field.

## 8. Whole-repo verification

```
$ cd .. && npm run verify

> ai-field-dev-assessment@1.0.0 verify
> npm run hygiene && npm run check:docs && npm run typecheck && npm test

stdout hygiene: OK (12 file(s) scanned in src)          [task-01]
logging hygiene: OK (9 file(s) scanned in src)          [task-02]
logging hygiene: OK (9 file(s) scanned in src)          [task-03]
logging hygiene: OK (17 file(s) scanned in src)         [task-04]
doc paths: OK (67 file reference(s) across 4 document(s) resolve in 4 task folder(s))
…
 Test Files  10 passed (10)   Tests  180 passed (180)   [task-01]
 Test Files  11 passed (11)   Tests  183 passed (183)   [task-02]
 Test Files   9 passed  (9)   Tests  154 passed (154)   [task-03]
 Test Files  17 passed (17)   Tests  159 passed (159)   [task-04]
```

676 offline tests in total; the per-task detail is aggregated in `docs/VERIFICATION.md`.

## Notes on the environment

- `npm run demo` and `npm run bench` need **no** model server: both start a scripted in-process provider
  (HTTP + SSE) and drive the real `node:http` gateway over a loopback socket.
- Every offline test binds port `0` and never touches the network or a fixed port.
- The only real sleeps in the suite are the 300 ms / 250 ms provider pauses in
  `tests/integration/latency.test.ts` and `tests/integration/error-handling.test.ts`, which exist to prove
  that the gateway does *not* wait for the upstream to finish.
- No secrets, tokens or real PII appear in the fixtures, logs or these transcripts (RFC 2606 example
  domains, a published test card number, and an SSA range that is never issued).

