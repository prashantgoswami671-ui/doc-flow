# T2-03 — Fact Card PoC (ISOLATED, BENCHMARK ONLY)

PoC-only structured-extraction experiment. **Not production code.** All PoC
files live under `tests/ollama-t2-03/`; this doc is the protocol. No file
under `services/`, `components/`, `app/`, or `tests/ollama-benchmark/` was
modified for this PoC and no dependency was added.

## Question

Does per-chunk structured extraction (Fact Cards) + deterministic validation
preserve numbers, comparisons, definitions, and conclusions better than
`PDF → final summary` for Qwen3 4B (local Ollama, `qwen3:4b`)?

## Pipeline

```
benchmark-docs/Economic_Growth_vs_Development_WB_Jharkhand.pdf (git-ignored)
  -> buildAiTextContext()            (AI-02, unchanged, ~6 chunks)
  -> 1 Fact Card per chunk           (PoC-local format:"json" client, temp 0)
  -> validateFactCard()              (deterministic, PoC-local)
  -> accepted cards + excerpts only  (never raw chunks)
  -> final Qwen3 4B summary          (production OllamaRuntime, unmodified)
```

## JSON strategy

- Dedicated loopback POST to `http://127.0.0.1:11434/api/generate` with
  `format: "json"`, reusing only `OLLAMA_BASE_URL` / `OLLAMA_MODEL` by
  read-only import. `OllamaRuntime` / `OllamaClient` / production types are
  untouched.
- Tolerates `<think>` preamble and markdown fences by extracting the first
  balanced `{...}` object; at most **one** repair retry per chunk with the
  validator's reasons; after failed repair the chunk is recorded as
  rejected/failed — **never fabricated**.
- Final summary is free text via `OllamaRuntime.generateText()` (temp 0.2,
  1024 tokens) whose prompt contains accepted cards + excerpts only, with
  explicit prohibitions (outside knowledge, unsupported causality, changing
  numbers, reversing comparisons, inventing facts).

## Validator rules (all offline-tested)

1. Card is an object; `cardId === "chunk-"+chunkIndex` with matching
   `chunkIndex`.
2. `sourcePages` non-empty, ascending, within `1..sourcePageCount`, and
   includes the chunk's page (1:1 PoC mapping).
3. `excerpts` 1..8 entries, each ≥ 24 chars and a verbatim substring of the
   chunk text (whitespace-normalized).
4. Every definition excerpt verbatim in chunk text.
5. Every `numbers[].excerpt` verbatim in chunk text AND `value` a substring
   of its own excerpt.
6. Every `claims[].excerpt` verbatim in chunk text; `pages ⊆ sourcePages`.
7. `kind === "comparison"` requires `excerpt2` as a second verbatim
   substring (one excerpt per side).
8. `causal` is an evidence classification: `causal:true` requires
   `causalExcerpt ⊆ excerpt` containing a closed-list connective
   (`because / caused / led to / due to / resulted in / driven by / as a
   result`). This is NOT proof of causality — **human review is the
   authority** for causal correctness; unsupported causal language is
   flagged for review.

## Pre-registered evaluation set (frozen before any run)

Definitions: `economic growth`, `economic development`.
Numbers: `84.78%`, `72.13%`, `82.26%`, `61.11%`, `41.13`, `22.24`,
`11.89%`, `28.81%`.
Critical comparisons: WB urban > WB rural; Jharkhand urban > Jharkhand
rural; Jharkhand gap > WB gap; Jharkhand rural IMR > urban IMR.
Core conclusion: growth is *necessary but not sufficient* for development.
(See `EXPECTED_*` in `tests/ollama-t2-03/factCardPoc.test.ts` — do not edit
after seeing results.)

## How to run

```bash
# always-run offline validator tests:
npx.cmd vitest run tests/ollama-t2-03/factCardValidator.test.ts
# live PoC (requires Ollama + real PDF, ~15 min for 6 cards + summary):
RUN_OLLAMA_T203=1 npx.cmd vitest run tests/ollama-t2-03/factCardPoc.test.ts
```

Without `RUN_OLLAMA_T203=1` the live file skips. Results append to
`benchmark-docs/results/t2-03-poc-<ts>.json` (git-ignored). The live test
records quality evidence and fails only on harness errors — never on model
quality misses.

## Measurements recorded per run

chunks attempted · cards accepted/rejected · JSON valid first-try / after
repair · rejection reasons · failures/OOM (verbatim) · provenance coverage
(cardId/chunkIndex/sourcePages per accepted card) · expected numbers found
(x/8) · exact numeric accuracy · definitions found (x/2) · conclusion
present · comparisons listed for human review · unsupported causal claims
(flagged) · final summary text · input/output tokens · final-summary ms.

## Known limits

8 GB RAM / 4 GB VRAM startup OOM (seen in T2-02); qwen3 `<think>` blocks;
single-excerpt comparisons when chunking splits entity pairs across chunks;
validator checks evidence presence, not semantic direction — direction stays
human-judged. No 20/50-page, MapReduce, routing, UI, or production wiring.

## Non-goals

Production promotion of Fact Cards, `services/` changes, Browser AI
changes, AI-02 limit changes, cloud/remote endpoints, new dependencies,
citation UI, extending the T2-02 benchmark.
