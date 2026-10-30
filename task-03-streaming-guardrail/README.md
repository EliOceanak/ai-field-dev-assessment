# Task 3 — LLM gateway streaming guardrail (PII redaction)

> **Problem statement (from [`ASSESSMENT.md`](../ASSESSMENT.md))**
>
> Implement an LLM Gateway proxy endpoint that routes text generation requests to an LLM provider and
> streams the response back to the client.
>
> **Requirements** — intercept the returning response chunk stream in real time; parse incoming stream
> deltas to detect and redact sensitive patterns (emails, SSNs, credit-card numbers, …), replacing them
> with `[REDACTED]`; keep the stream responsive **without accumulating the full response in memory**,
> minimising TTFT and overall stream latency.
>
> **Scored on** — efficient asynchronous stream chunking and buffer state management · performant
> regex matching over *partial* text · memory efficiency and low-latency proxying design.

**Status:** implemented — PII patterns, streaming redactor, SSE parser, chunk mapper, the `node:http`
gateway, the offline suites and the demo are green, together with the TTFT bench, the opt-in live suite
and `demo:live`.

## What this demonstrates

- **Intercepting the chunk stream in real time** — `src/proxy/upstream.ts` opens one `fetch` to the
  provider and `src/server.ts` pipes the raw body through `TextDecoder({stream:true})` → `src/sse/parser.ts`
  → `src/redact/chunkMapper.ts` → `res.write`, releasing each frame as soon as it is complete. Nothing
  waits for the response to finish; `tests/integration/latency.test.ts` proves the client receives the
  first event while the provider is still paused mid-stream.
- **Detecting and redacting emails, SSNs and card numbers (plus phone, IPv4, secrets) → `[REDACTED]`** —
  `src/redact/patterns.ts` holds the regexes *and* the validators that keep false positives out (Luhn
  for cards, SSA area/group/serial rules for SSNs, octet ≤ 255 for IPv4). `tests/unit/patterns.test.ts`
  shows dates, order ids, versions and Luhn-invalid numbers surviving untouched.
- **No boundary leakage** — the redactor withholds only the shortest suffix of the live buffer that
  could still be completed into a match (`src/redact/streamingRedactor.ts`). The decisive proof is
  `tests/unit/streaming-redactor.test.ts`: for **every** fixture and **every** split index,
  `push(prefix) + push(suffix) + flush()` equals whole-string redaction — and the same holds when the
  fixture arrives one character at a time. `tests/unit/sse-parser.test.ts` splits SSE frames at every
  byte boundary.
- **Memory efficiency** — retained state is O(holdback), never O(response): a synthetic 5 MB stream
  leaves `maxBufferSeen` ≤ 512 bytes (`tests/integration/latency.test.ts`, `/stats`).
- **Low latency** — `scripts/bench-ttft.mjs` measures TTFT direct vs guarded: **+0.5 ms** to the first
  SSE frame and **+1.3 ms** when the first delta is prose. The holdback costs at most one provider
  token to the first *non-empty* content (see the bench table in §9).
- **Reasoning and tool calls too** — `delta.reasoning_content` (the field the reference llama.cpp
  server streams reasoning in — a real leak if ignored) and `tool_calls[].function.arguments` are
  redacted as well, verified end-to-end and against the live model.

## Architecture

```
        POST /v1/chat/completions                      (client)
                  │
                  ▼
        ┌───────────────────────────────────────────────────────────────┐
        │ src/server.ts  (node:http — no framework, no extra buffering) │
        │  • bounded request read (1 MiB → 413)                         │
        │  • stream:true  → streaming path                              │
        │  • stream:false → bounded read (1 MiB) + JSON body redaction   │
        └───────────────┬───────────────────────────────────────────────┘
                        │ fetch (AbortSignal: timeout + client disconnect)
                        ▼
        ┌───────────────────────────────────────────────────────────────┐
        │ provider  ──  text/event-stream  ──  raw bytes                │
        └───────────────┬───────────────────────────────────────────────┘
                        ▼
   TextDecoder('utf-8', { stream: true })      ← multi-byte chars split across TCP reads
                        ▼
   src/sse/parser.ts   frames split at any byte, CRLF/CR/LF, comments, multi-line data
                        ▼
   src/redact/chunkMapper.ts   per choice index: content · reasoning_content · tool arguments
                        ▼
   src/redact/streamingRedactor.ts   push(delta) → "safe to emit" prefix
                        ▼
   src/sse/parser.ts serialize   →   res.write + 'drain' backpressure   → (client)
```

### The redactor's buffer state machine

```
   push(delta)                                    retained tail = holdback
   ┌──────────────────────────────────────────────────────────────────────┐
   │ buffer = tail + delta                                                │
   │ holdback = longest suffix that is a PREFIX of a possible match        │
   │            (per pattern, via an end-anchored partialAnchor)           │
   │ emitEnd  = len(buffer) − holdback                                     │
   │ for every match m: if m.start < emitEnd < m.end → emitEnd = m.start   │  ← never cut a match
   │ out      = redact(buffer[0 .. emitEnd])   (complete matches only)     │
   │ tail     = buffer[emitEnd ..]                                        │
   │ if |tail| > maxHoldbackBytes → release everything + log (safety valve)│
   └──────────────────────────────────────────────────────────────────────┘
```

Two hard cases, both handled by the *same* mechanism:

1. **A PII value split across two deltas** — `…"your card 4012"` + `"8888 8888 1881…"`. The first
   delta's trailing `4012` is a prefix of a card match, so it is withheld (`holdback = 4`); the second
   delta completes it inside the buffer and it is redacted before release.
2. **An SSE frame split across two TCP reads** — the parser keeps the incomplete line, so
   `data: {"choi` + `ces":[…]}\n\n` still parses as one frame. Bytes are decoded with
   `{stream: true}`, so a multi-byte character split across reads cannot corrupt a match either.

### What is redacted (measured on the reference server)

| Field | Action |
| --- | --- |
| `choices[].delta.content` | redact |
| `choices[].delta.reasoning_content` / `.reasoning` | redact — **llama.cpp streams reasoning here**; ignoring it leaks |
| `choices[].delta.tool_calls[].function.arguments` | redact (streamed JSON text) |
| `choices[].message.*` (non-streaming) | redact, same policy |
| `role`, `id`, `model`, `created`, `usage`, `timings`, `finish_reason`, `index` | untouched |
| an unparseable `data:` payload | forwarded byte-identical, counted as `unparsed_events` |

## Grader quickstart

```bash
npm ci                     # repo root
cd task-03-streaming-guardrail
npm test                   # offline: split-point, SSE framing, latency, memory bound, patterns
npm run demo               # scripted mock upstream streams PII → redacted transcript
npm run bench              # TTFT / throughput: direct vs guarded
RUN_LIVE_LLM=1 npm run test:live   # optional: the real local model stream
```

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `GUARDRAIL_PORT` | `8790` | listen port |
| `GUARDRAIL_UPSTREAM_BASE_URL` | `http://127.0.0.1:8080/v1` | OpenAI-compatible provider base URL |
| `GUARDRAIL_UPSTREAM_API_KEY` | _(unset)_ | provider credential (never logged) |
| `GUARDRAIL_UPSTREAM_TIMEOUT_MS` | `120000` | upstream request timeout |
| `GUARDRAIL_REDACTION_REPLACEMENT` | `[REDACTED]` | literal replacement |
| `GUARDRAIL_TYPED_PLACEHOLDERS` | `false` | `[REDACTED:EMAIL]` instead of `[REDACTED]` |
| `GUARDRAIL_CUSTOM_PATTERNS` | _(unset)_ | JSON array of `{name, pattern, flags?}` |
| `GUARDRAIL_MAX_HOLDBACK_BYTES` | `512` | hard cap on the retained tail buffer |
| `GUARDRAIL_LOG_LEVEL` | `info` | stderr logger threshold |

The live suite and `npm run demo:live` read the shared `LIVE_OPENAI_BASE_URL` / `LIVE_OPENAI_MODEL`, like every
task's live parts, rather than `GUARDRAIL_UPSTREAM_BASE_URL`; `GUARDRAIL_LIVE_BASE_URL` / `GUARDRAIL_LIVE_MODEL`
override them for this task alone. See [`docs/LOCAL-LLM.md`](../docs/LOCAL-LLM.md).

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/v1/chat/completions` | guarded proxy (streaming and non-streaming) |
| `GET` | `/healthz` | liveness |
| `GET` | `/stats` | JSON counters (streams, chunks, redactions by type, max buffer seen) |

## Test matrix

| Criterion | Test file | What it proves |
| --- | --- | --- |
| pattern correctness (email, SSN, Luhn-checked card, phone, IPv4, secrets, custom) | `tests/unit/patterns.test.ts` | each built-in accepts/rejects a table of inputs; `4111-1111-1111-1112` fails Luhn; `000-…`, `666-…`, `9xx…`, `…-00-…`, `…-0000` fail the SSA rules; `999.1.1.1` is not an address; custom patterns append; typed placeholders work |
| a long delimiter-free run stays linear | `tests/unit/streaming-redactor.test.ts` | a 40 KB base64-ish blob is scanned in < 250 ms and still redacts a PII value inside it |
| a dotted version is not an address | `tests/unit/streaming-redactor.test.ts` | `the version is 3.14.2.` survives end of stream, while `the host is 10.0.0.42` is redacted |
| no boundary leakage: every fixture at EVERY split index | `tests/unit/streaming-redactor.test.ts` | `push(a) + push(b) + flush()` equals `redactText(a+b)` for every split index of 22 fixtures, for 120 randomised contexts at random splits, and for 400 seeded strings of PII fragments, partial values and filler, each streamed 5 times in random chunk sizes |
| adjacent values are all redacted, not just consistently | `tests/unit/streaming-redactor.test.ts` | a phone that overlaps a preceding address or card is merged into its redaction, a grouped card followed by a year, a date or a fifth group is still redacted (each at every split point), and 1,500 seeded strings of adjacent PII and filler leave **no** inserted value in either the whole-string or the streamed output |
| 1-byte chunking, empty deltas, flush on finish | `tests/unit/streaming-redactor.test.ts` | one-character-at-a-time equals whole-string redaction; empty deltas are no-ops; `flush()` releases the tail; the safety valve fires instead of growing |
| SSE framing split at every byte, CRLF, comments, multi-line data, `[DONE]` | `tests/unit/sse-parser.test.ts` | 15 frames × every byte boundary, plus one-byte-at-a-time, produce identical events; serializer round-trip; multi-byte UTF-8 never corrupted |
| chunk field policy (content + reasoning + tool args, others untouched) | `tests/unit/chunk-mapper.test.ts` | all three string fields redacted; `role`/`id`/`model`/`created`/`usage`/`timings`/`finish_reason` untouched; per-choice state independent; unparseable payload passthrough |
| end-to-end redaction through the proxy | `tests/integration/redaction-stream.test.ts` | scripted provider → gateway → client: reassembled content/reasoning/arguments redacted, **no** raw PII anywhere in the response bytes, `[DONE]` and framing preserved |
| reasoning_content + tool_call arguments redacted | `tests/integration/redaction-stream.test.ts`, `tests/unit/chunk-mapper.test.ts` | the measured llama.cpp leak path is covered offline |
| first event reaches the client before upstream finishes (no accumulation) | `tests/integration/latency.test.ts` | provider emits token 1, sleeps 300 ms, then finishes: the first client event arrives < 250 ms and < total/2 |
| bounded internal buffer while streaming a multi-MB response | `tests/integration/latency.test.ts` | a 5 MB scripted stream keeps `/stats.maxBufferSeen` ≤ 512 bytes with 32 redactions and no cap hits |
| non-streaming JSON request redacted | `tests/integration/non-streaming.test.ts` | body fields redacted, status/content-type preserved, `X-Guardrail-Redactions` header |
| idempotency + over-redaction regressions (dates, order ids, Luhn failures) | `tests/unit/patterns.test.ts` | `ORD-10234`, `2026-10-29`, `5.9.3`, `20260101` and Luhn-invalid numbers survive; `[REDACTED]` is never re-matched |
| error sanitization (no upstream internals) | `tests/integration/error-handling.test.ts` | a 500 body containing a sentinel key and the prompt is never echoed; 429/502/504/413/400/404 mapping |
| TTFT / throughput, direct vs guarded | `scripts/bench-ttft.mjs` | bench table in §9 |
| real model stream (incl. `reasoning_content`) | `tests/live/redaction.live.test.ts` | `RUN_LIVE_LLM=1`: the local llama.cpp model echoes a PII fixture; zero raw values in the stream, framing intact |

## Design notes & trade-offs

**The holdback is "safe to emit", not a fixed window.** The redactor releases a prefix only when no
future delta can extend a match into it. It computes that from the *earliest possible start of a partial
match* rather than a fixed window, so a delta can be emitted as soon as its trailing partial value is
complete. Retained state is therefore O(holdback) — bounded by `maxPatternLength` (254 B for an email
local part) and capped by `GUARDRAIL_MAX_HOLDBACK_BYTES` (512 B), never O(response).

**Every repetition is bounded, and that is a performance property.** An unbounded greedy run followed by a
required delimiter is quadratic when the delimiter never arrives: `[local]+@…` retried from every start
position costs seconds on a 40 KB base64 blob, and it blocks the event loop for *every* concurrent stream.
The email pattern therefore bounds each repetition by the protocol limits (64-octet local part, 255-octet
domain, 63-octet label), which is both correct per RFC 5321/1035 and linear. The holdback is computed on a
window of at most `maxPatternLength` characters for the same reason — no prefix longer than a pattern's
maximum match can be part of a match, so the window cannot change the answer, only the cost.

**Two guards, not one.** The holdback stops a *future* delta from extending a match into already-emitted
text. It does not stop the emit boundary from *cutting* a match already visible in the buffer (a shorter
pattern can anchor a suffix such as `"789 "` inside `"123-45-6789 "`), so `push()` additionally moves the
boundary back to the start of any known match. Both cases are covered by the split-index test.

**Matching runs over the emittable prefix only** — amortised O(chunk) per delta, plus one regex pass per
pattern to locate the holdback. The `partialAnchor` formulation is equivalent to an ascending
suffix loop (proved in `tests/unit/streaming-redactor.test.ts`) but avoids up to 254 string slices per
delta.

**A truncated value at end of stream is committed, not leaked.** `flush()` redacts complete matches and
also a *committed* partial tail — one that already carries an unambiguous marker (`@`, two SSN dashes,
≥12 card digits, a key prefix). Ordinary prose ending in a bare word (`"…the word is fox"`) is left
alone, and a value a validator already rejected (a Luhn-invalid card) is not resurrected.

**Overlapping candidates are merged, not ranked.** When two candidates overlap, both are PII, so the
redaction covers their union; keeping only the one that starts first would leak the rest of the other.
The case is not exotic: the phone pattern's optional `1` country code lets `10.0.0.1 415-555-0132` match a
phone that starts on the address's last digit. The merged span is reported once, under the type of the
candidate that starts first. For the same reason the grouped card form stops at four groups: a fifth makes
20 digits, which never passes Luhn, so `4111 1111 1111 1111 2025` would otherwise reject the whole run and
leak the card in it.

**Cost: at most one token of TTFT.** Because a bare trailing word *could* still become an email, the
first delta of a stream is withheld until the next one arrives (measured: +20.1 ms at a 20 ms/token
cadence). With realistic prose first deltas the penalty is +1.3 ms, and the total stream duration is
unchanged within noise. We chose the correct-and-bounded version over a fast-but-leaky one; the obvious
alternative (a fixed `maxPatternLength - 1` holdback) would withhold 253 bytes on every delta and is
strictly worse.

**Why `[REDACTED]`, with typed placeholders opt-in.** The brief specifies `[REDACTED]`, so that is the
default; `GUARDRAIL_TYPED_PLACEHOLDERS=true` yields `[REDACTED:EMAIL]` for operators who need to know what
was removed. `[REDACTED]` contains no digits, `@` or key prefixes, so it can never re-match.

**Why reasoning and tool arguments are redacted.** Measured on the reference server: reasoning arrives as
`delta.reasoning_content` (a separate field) and tool calls as `delta.tool_calls[].function.arguments` (a
streamed JSON string). A guardrail that rewrites only `delta.content` leaks in both places.

**Why the streaming path reports counts via `/stats`.** `X-Guardrail-Redactions` needs the final count,
which is unknown when the SSE headers are written. The header is therefore set only on the non-streaming
path; the streaming path exposes `redactions`, `redactionsByType`, `maxBufferSeen` and `unparsedEvents` on
`GET /stats` instead.

**Error mapping.** Upstream 429 → 429 (`upstream_rate_limited`); any other upstream 4xx/5xx → 502
(`upstream_error`); connect failure → 502 (`upstream_unavailable`); no headers within
`GUARDRAIL_UPSTREAM_TIMEOUT_MS`, or a stalled stream → 504 (`upstream_timeout`; mid-stream the SSE body
gets an in-band error event plus `[DONE]` instead of a second status line). Provider bodies are never
echoed — they can contain the prompt, and therefore the PII.

**One deliberate deviation from the SSE spec.** A trailing frame that never received its blank line is
still dispatched (and an incomplete trailing line is treated as a line). Dropping a provider's last event
would be worse for a proxy than a lenient parse; it is documented in `src/sse/parser.ts`.

**Env booleans are parsed explicitly.** `z.coerce.boolean()` would turn the string `"false"` into `true`
(`Boolean("false")`), so the `.env.example` value `GUARDRAIL_TYPED_PLACEHOLDERS=false` would enable typed
placeholders. `src/config.ts` uses an explicit env-boolean transform instead, pinned by
`tests/unit/config.test.ts`.

## Limitations & future work

- **Regex + validators, not a classifier.** Names, addresses, free-form identifiers and obfuscated values
  ("four one one one…") are out of scope; a pluggable detector interface (future work) is the next step.
- **Formats.** Cards must be 13-19 contiguous digits, 16 digits in 4-digit groups, or the 4-6-5 Amex shape; SSNs must be
  hyphenated; phones are NANP-shaped. Other layouts need a `GUARDRAIL_CUSTOM_PATTERNS` entry.
- **A stream truncated inside an IPv4 address can emit up to three octets.** The end-of-stream rule commits
  a *complete-looking* address (four groups, last non-empty) and nothing shorter, because committing a
  three-group prefix redacted ordinary dotted versions — `the version is 3.14.2.` became
  `the version is [REDACTED]`. Mid-stream the prefix is still withheld by the partial anchor, so only a
  stream that *ends* inside an address can leak three octets. The alternative (redacting version numbers)
  is worse; this is the trade-off, stated rather than hidden.
- **A run longer than `maxPatternLength`** (e.g. a 200-digit hyphenated blob) can be released by the safety
  valve with a partially redacted value. The valve logs `holdback_cap_exceeded`; that is the documented
  price of bounded memory.
- **Custom patterns without a literal prefix** (`\d{4}-\d{4}`) fall back to a conservative fixed window
  derived from their quantifiers; the gateway logs `custom_pattern_partial_anchor_fallback` for them.
- **Non-JSON non-streaming bodies pass through unredacted** (counted as `unparsed_events`) — there are no
  structured fields to rewrite.
- **No request-body redaction** (prompts are forwarded as received) and no multimodal/binary parts.
- **Not a policy engine:** one pattern set per process; per-tenant sets and audit trails are future work.

## Verification evidence

Captured on this machine (Node v24.3.0). Full transcript, including the demo and the live run, is in
[`VERIFICATION.md`](./VERIFICATION.md).

### Offline suite — `npm test` (154 tests, 9 files)

```
$ npm run hygiene && npm run typecheck && npm test
logging hygiene: OK (9 file(s) scanned in src)
> tsc --noEmit            # no output = clean

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
   Duration  1.19s
```

### Demo — `npm run demo` (offline, scripted provider)

```
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

PASS — no raw PII reached the client
```

### Bench — `npm run bench` (20 runs, 200 tokens at 20 ms/token)

```
scenario                         path     TTFT mean  TTFT p95  first content  total mean
-------------------------------  -------  ---------  --------  -------------  ----------
first delta "Hello" (bare word)  direct   21.6 ms    22.6 ms   21.7 ms        —
first delta "Hello" (bare word)  guarded  22.1 ms    23.2 ms   41.7 ms        —
first delta "Hello" (bare word)  delta    +0.5 ms    —         +20.1 ms       —
first delta "Hello, here is…"    direct   21.2 ms    21.5 ms   21.2 ms        —
first delta "Hello, here is…"    guarded  22.4 ms    23.5 ms   22.5 ms        —
first delta "Hello, here is…"    delta    +1.3 ms    —         +1.2 ms        —

full stream  direct   20.9 ms    21.1 ms   20.9 ms        4061.2 ms
full stream  guarded  22.2 ms    22.3 ms   41.9 ms        4060.3 ms
full stream  delta    +1.2 ms    —         +20.9 ms       -1.0 ms

TTFT cost of guarding : +0.5 ms to the first SSE frame; +20.1 ms to the first non-empty content
                        (≤ one 20 ms token); +1.3 ms when the first delta is prose
Throughput cost       : -1.0 ms over a 200-token stream (noise: no measurable added latency)
```

### Live — `RUN_LIVE_LLM=1 npm run test:live` and `npm run demo:live` (real llama.cpp)

```
 ✓ tests/live/redaction.live.test.ts (2 tests) 18793ms
     ✓ never emits raw PII and keeps the SSE framing intact 1585ms
     ✓ scrubs reasoning_content, which this server streams as a separate field 17206ms

$ npm run demo:live
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

### Whole repo — `npm run verify` from the root

```
> ai-field-dev-assessment@1.0.0 verify
> npm run hygiene && npm run check:docs && npm run typecheck && npm test
task-03-streaming-guardrail: logging hygiene: OK (9 file(s) scanned in src)
doc paths: OK (67 file reference(s) across 4 document(s) resolve in 4 task folder(s))
task-03-streaming-guardrail: Test Files 9 passed (9) · Tests 154 passed (154)
(workspace totals across all four tasks: hygiene OK, doc paths OK, typecheck clean, 676 tests passed)
```

