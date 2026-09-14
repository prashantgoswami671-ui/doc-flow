# T2-02 — Real-Document Ollama Benchmark (BENCHMARK ONLY)

Evidence-gathering benchmark foundation for Tier 2 (local Ollama, qwen3:4b).
**This is not production code and must not be promoted into the production
long-document architecture.** It exists to answer five questions with
measured evidence:

- **A.** Can Qwen3 4B (local Ollama) summarize the real 6-page PDF accurately?
- **B.** How does it scale to 20 pages?
- **C.** How does it scale to 50 pages?
- **D.** What are cold vs warm timings?
- **E.** Does GPU-backed Ollama perform acceptably on this machine
  (Ryzen 7 6800H, 8 GB RAM, RTX 3050 Laptop 4 GB VRAM)?

Explicitly **out of scope** (per T2-02): fact cards, production long-document
coordination, MapReduce pipelines, automatic Tier-1/Tier-2 routing, new
production UI, cloud AI, remote Ollama endpoints, new dependencies, changes
to AI-02 constants, and any replacement of Tier 1.

## What the benchmark exercises

The real production path, with no duplicated logic:

```
PDF File
  -> buildAiTextContext()            services/ai/pipeline.ts (AI-02)
  -> buildAiInstructionPrompt()      services/ai/instructions.ts (action: summarize)
  -> OllamaRuntime.generateText()    services/ai/ollama/runtime.ts (T2-01)
  -> POST http://127.0.0.1:11434/api/generate, model qwen3:4b
  -> summary
```

The runtime is constructed with a recording client that delegates to the real
client's `generateDetailed()` (`services/ai/ollama/client.ts`). The wire
request is identical to `client.generate()`; the runtime keeps full
responsibility for validation, availability gating, 32,768-character context
bounding, settings clamping, and result shaping. Ollama's metrics come from
the **same single generation** the summary text comes from.

## Preconditions

1. Ollama 0.34.0 running locally; `ollama pull qwen3:4b` done (verify with
   `curl http://127.0.0.1:11434/api/tags`).
2. The real 6-page PDF placed at
   `benchmark-docs/Economic_Growth_vs_Development_WB_Jharkhand.pdf`.
   This path is **git-ignored** — the file is a local benchmark input and
   must never be committed.
3. Laptop plugged in; Ollama idle. Keep the machine awake for the duration
   (no keep-awake workaround exists in the harness by design).

## How to run

```bash
# from the repo root (Git Bash)
RUN_OLLAMA_BENCHMARK=1 npx vitest run tests/ollama-benchmark/ollamaBenchmark.test.ts
```

Without `RUN_OLLAMA_BENCHMARK=1` the whole file is skipped — the normal
`npm test` suite never touches Ollama or the filesystem benchmark paths.

Scenarios run by the file:

| # | Scenario | Document | Runs |
|---|---|---|---|
| 1 | real 6-page, intended COLD | the real PDF (skipped if absent) | 1 |
| 1b | real 6-page, WARM | the real PDF | 3 |
| 2 | synthetic dense 20-page WARM | generated in-file (~1.5k chars/page) | 3 |
| 3 | synthetic dense 50-page WARM | generated in-file (~1.5k chars/page) | 3 |
| 4 | sparse 50-page control WARM | existing Phase 3.1 fixture | 1 |

Fixed generation settings for comparability: `temperature 0.2`,
`maxOutputTokens 1024` (within the runtime's 8,192-token `num_predict`
ceiling).

Why dense vs sparse synthetics: at ~1.5k chars/page the dense 20-page
document (~30k chars) fits inside the runtime's 32,768-character context,
while the dense 50-page document (~75k chars) exceeds it — the 50-page run
records `contextTruncated: true` as the truncation-boundary data point. The
sparse 50-page control (~10k chars) separates page-count effects from
token-count effects. The sparse fixture's content is highly repetitive and
**not suitable for quality evaluation** — quality review applies to the real
PDF runs (and optionally the dense 20-page runs).

## Cold/warm protocol (evidence-based)

- **Cold:** run `ollama stop qwen3:4b` in a terminal immediately before
  scenario 1, then run the benchmark. Scenario 1 must be the first
  generation after the stop.
- **Warm:** every later run in the same session is expected warm
  (Ollama's default `keep_alive` is ~5 minutes; back-to-back scenarios stay
  resident).

**Never trust intent — trust `load_duration`.** A run is classified:

- `cold` — `loadDurationMs > 1000` (model actually loaded from memory/disk)
- `warm` — `loadDurationMs <= 1000` (model already resident)
- `unknown` — Ollama did not report the field

The raw `loadDurationMs` is recorded for every run. If scenario 1 logs
`intended-cold run classified as WARM`, the cold data point is invalid:
stop the model and rerun scenario 1. The per-run JSON files are timestamped,
so reruns never overwrite earlier evidence.

## Metrics captured (per run)

Written to `benchmark-docs/results/` as one JSON file per run plus an
append-only `t2-02-runs.jsonl`, and echoed to the console as a summary line.

| Field | Meaning |
|---|---|
| `model` | `qwen3:4b` (from the production constant) |
| `scenario` / `label` / `document` | scenario slug, cold/warm attempt, document name |
| `sourcePageCount` | PDF page count reported by AI-02 extraction |
| `pagesWithoutExtractableText` | scanned/image-only or failed pages (never fabricated) |
| `extractionMs` | AI-02 extraction time (from `buildAiTextContext`) |
| `chunkCount` | number of `AiContextChunk`s sent toward the runtime |
| `totalExtractedCharacters` | extracted characters actually chunked |
| `ai02Truncated` | AI-02's own truncation signal (chunk-count / 200k budgets) |
| `contextTruncated` | OllamaRuntime's 32,768-character bound dropped trailing chunks |
| `inputTokens` | Ollama `prompt_eval_count` (null when unreported) |
| `outputTokens` | Ollama `eval_count` (null when unreported) |
| `loadDurationMs` | Ollama `load_duration`, ns → ms (cold/warm evidence) |
| `promptEvalDurationMs` | Ollama `prompt_eval_duration`, ns → ms |
| `evalDurationMs` | Ollama `eval_duration`, ns → ms |
| `totalOllamaDurationMs` | Ollama `total_duration`, ns → ms |
| `generationMs` | wall-clock around `runtime.generateText()` (harness-measured) |
| `derivedEvalTokensPerSecond` | `outputTokens / (evalDurationMs / 1000)` — question E |
| `totalBenchmarkRuntimeMs` | whole scenario wall time incl. extraction |
| `coldWarm` | classification per the rules above |
| `failure` | verbatim error (name + message), null on success |
| `rawOutput` | full generated summary (for the quality review) |
| `qualityNotes` | filled manually during review |

## Results (fill in after runs)

Paste the console summary lines and/or per-run JSON here. Minimum table per
scenario: cold/warm · input tokens · output tokens · load ms · eval ms ·
tokens/sec · `contextTruncated`.

| Scenario | State | In tok | Out tok | Load ms | Eval ms | tok/s | ctxTrunc |
|---|---|---|---|---|---|---|---|
| real 6-page cold-1 | | | | | | | |
| real 6-page warm-1..3 | | | | | | | |
| dense 20p warm-1..3 | | | | | | | |
| dense 50p warm-1..3 | | | | | | | |
| sparse 50p control | | | | | | | |

Record anomalies verbatim (see the Checkpoint 2A precedent in
`docs/AI_BROWSER_PROTOTYPE_BENCHMARK.md` for the outlier-recording format).

## Quality review (manual checklist — not a score)

Review each summary against the **source document** (open the PDF; for the
real PDF, spot-check every number you cite). Mark each item
`yes / partial / no` with a one-line note. Do not aggregate into a numeric
score — the pattern follows the prototype harness's 10-criterion checklist
(`services/ai-prototype/benchmarkConfig.ts`), extended with the T2-02
concerns.

| # | Criterion | yes/partial/no | Note |
|---|---|---|---|
| 1 | Important-topic coverage (major sections represented) | | |
| 2 | Key facts preserved | | |
| 3 | Exact numerical accuracy (figures match the source verbatim) | | |
| 4 | Definitions correct | | |
| 5 | Comparisons correct (X vs Y stated as the source states it) | | |
| 6 | Conclusions preserved faithfully | | |
| 7 | Important caveats/qualifications preserved | | |
| 8 | Hallucinations (any claim not present in the source) | | |
| 9 | Contradictions (output contradicts source, or itself) | | |
| 10 | Unsupported causal claims (causality the source doesn't assert) | | |
| 11 | Omissions (important content missing) | | |
| 12 | Duplication (excessive repetition) | | |

Known quality context: the Tier-1 Qwen2.5-0.5B model produced fluent but
factually incorrect summaries (see `docs/DOCFLOW_STATUS.md`, Tier-1
envelope). Numerical accuracy (item 3) and hallucinations (item 8) are
therefore the primary quality questions for qwen3:4b.

## Known limitations / explicit non-conclusions

- **4 GB VRAM:** qwen3:4b Q4_K_M is ~2.5 GB; with KV cache the RTX 3050 may
  partially offload to CPU. `derivedEvalTokensPerSecond` measures the real
  combined behavior — modest numbers are evidence, not failure.
- **Thinking tokens:** qwen3 advertises a `thinking` capability; raw
  completions may include `<think>` blocks that inflate `evalCount` and
  latency. `rawOutput` is recorded verbatim so this is visible; note it in
  `qualityNotes` if present. No suppression is attempted by the harness.
- **Warm window:** Ollama unloads models after ~5 minutes idle. Long gaps
  between scenarios can produce an unintended cold run — the
  `loadDurationMs` classification catches this; reclassify by evidence.
- **Single machine, single session:** timings are machine-local and not
  comparable across machines or Ollama versions.
- **Synthetic documents are not real documents:** scaling conclusions from
  scenarios 2-4 describe token/context mechanics, not real-world quality.
- These results are benchmark evidence only. They do not change the
  production AI-02 implementation, its constants, or any task status in
  `docs/DOCFLOW_STATUS.md`.
