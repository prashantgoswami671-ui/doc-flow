# Brave Benchmark Harness — Browser AI Prototype (BENCHMARK ONLY)

This page is **prototype benchmark infrastructure, not production**.
It drives the prototype stack (`services/ai-prototype/*`) plus read-only
AI-02 context building (`services/ai/pipeline.ts`). It never imports or
modifies production runtime code (`services/ai/browser/*`,
`services/ai/orchestration.ts`, `SummarizePdfCard`, AI-02 constants).

## Launch

```bash
npm run dev
```

Open in **Brave** (documented target; other browsers are not blocked):

```text
http://localhost:3000/test/browser-ai
```

## What to configure per run

- **Mode**: Single-pass | Map→Reduce
- **Source**: Synthetic fixture (1/5/10/20/40/41/50 pages, deterministic)
  or **Uploaded PDF** (works in BOTH modes — file input under the source
  selector; the PDF never leaves the browser).
- **Single-pass**: context budget 4K/5K/6K/7K/8K (+8.5K/9K/10K) × output
  cap 64/128/256. Budgets are prototype-only; the production 8192 cap is
  untouched. Whole chunks only — omitted chunks/pages are listed, never
  silent.
- **Map→Reduce**: batch 2/3/4/6 (chunks per Map call, sequential — not
  parallel) × Map cap 64/128/256 × Reduce cap (64/128/256/512, default
  256). Failed Map batches are recorded and the run continues, yielding a
  **PARTIAL** result; a bare failure yields **FAILED** with coverage.
- **Model**: default Qwen2.5-0.5B-Instruct q4 on **WASM** (benchmark
  target). WebGPU is labeled EXPERIMENTAL and is not production.
  Device/model lock while initialized — Reset first to change them.

## Cold vs warm

- **COLD**: the run initialized a new Worker/model (init ms recorded in
  the run). Use “Initialize model now” for a standalone cold start, or
  just run — the first run after Reset is cold.
- **WARM**: reuses the initialized Worker/session (init shown as —; see
  the earlier cold run for init cost). Run again any time for warm
  repeats. “Reset model” terminates the Worker; the next run is COLD.

## Cancellation, visibility, quality, coverage, export

- **Cancel** stops single-pass generation, an in-flight Map/Reduce call,
  or between Map batches. The record shows cancel time, observed stop
  latency, and whether the runtime stayed reusable without reload.
- The header shows live `document.visibilityState` (foreground vs
  background); each run records visibility at start/end plus transition
  count. There is **no keep-awake/throttling workaround by design**.
- Click a run for per-generation diagnostics, full outputs (Map
  intermediates with batch indexes + final summary), and a manual
  10-criterion qualitative checklist (not a score).
- **Copy all runs JSON** / **Copy this run JSON** produce the structured
  record for paste-into-ChatGPT reporting. `window.getBenchmarkRuns()`
  exposes the same records to Playwright; `runBenchmarkSinglePass` /
  `runBenchmarkMapReduce` are parameterized hooks (synthetic fixtures;
  use the UI for uploaded PDFs).

## Known limitations

- Long runs (tens of minutes for 40+ pages) — keep the tab foreground and
  the machine awake manually; background runs are valid data, not errors.
- `std::bad_alloc`-family failures are recorded verbatim with a
  MEMORY-FAILURE-SIGNATURE tag; the harness does not classify the cause.
- No automatic quality scores — review outputs manually against the
  checklist. Benchmark numbers are not production guarantees.
