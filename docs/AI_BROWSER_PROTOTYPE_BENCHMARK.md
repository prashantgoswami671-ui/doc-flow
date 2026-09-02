# Browser AI Prototype — Map→Reduce Benchmark (Checkpoint 2A)

This document records a controlled benchmark of the Browser AI (WASM) Map→Reduce prototype used to process a document larger than a single AI-02 context window would otherwise allow. This is prototype evidence only — see [Explicit non-conclusions](#explicit-non-conclusions) before drawing production implications from these numbers.

## Controlled 41-page / batch=6 run

- **Model:** Qwen2.5-0.5B-Instruct q4 WASM
- **Fixture:** synthetic 41-page PDF
- **AI-02 context:**
  - 41 chunks
  - 8,068 characters
  - `truncated=false`
  - `pagesWithoutText=0`
- **Map batch size:** 6 chunks
- **Map batches:** 7
- **Reduce generations:** 1
- **Total generations:** 8
- **Total elapsed:** 1,772,114 ms ≈ 29.5 minutes

### Generation measurements

| Generation | Stage  | Input tokens | Generated tokens |  Inference |
| ---------- | ------ | -----------: | ---------------: | ---------: |
| 1          | Map 1  |          415 |              201 | 311,098 ms |
| 2          | Map 2  |          421 |               52 |  98,838 ms |
| 3          | Map 3  |          427 |               42 |  84,214 ms |
| 4          | Map 4  |          427 |               41 |  81,633 ms |
| 5          | Map 5  |          427 |              247 | 366,992 ms |
| 6          | Map 6  |          427 |              247 | 368,197 ms |
| 7          | Map 7  |          380 |              206 | 308,931 ms |
| 8          | Reduce |        1,219 |               42 | 151,485 ms |

## Batch=3 comparison

- Same 41-page synthetic fixture
- 14 Map generations + 1 Reduce = 15 generations
- Approximately 42.4 minutes total

Batch=6 vs. batch=3, in this controlled comparison:

- Generations: 15 → 8
- Elapsed time: ~42.4 min → ~29.5 min
- Approximately 30% lower total elapsed time

## Important outlier

A previous 41-page/batch=6 run produced a markedly different result:

- 8 generations
- Approximately 145.5 minutes total
- Map #6 alone took approximately 106.7 minutes

A controlled rerun while keeping the browser/system awake produced the 29.5-minute result above, with Map #6 taking ~6.1 minutes for essentially the same workload.

We do not claim that a blank/idle browser state is proven to be the cause of the 106.7-minute Map #6. The extreme 106.7-minute result is treated as an outlier, and the controlled rerun demonstrates substantial runtime variability in the WASM inference environment. The root cause of that variability has not been isolated.

## Architectural conclusion

> Map→Reduce is technically viable as a prototype architecture for avoiding a single large inference context: a 41-page document was processed as 7 bounded Map generations followed by a small Reduce generation, without AI-02 truncation.

> Current Browser/WASM inference performance is not suitable for interactive production use. The prototype demonstrates context/memory scaling feasibility, not production-quality latency.

> AI-02 itself was not the bottleneck in this benchmark. The 41-page context was extracted successfully with `truncated=false`; the dominant cost and variability occurred during downstream WASM inference.

Generated output length materially affects inference time: generations producing ~41–52 tokens took roughly 82,000–99,000 ms, while generations producing ~206–247 tokens took roughly 309,000–369,000 ms — inference cost scaled with generated-token count, not just input size.

## Explicit non-conclusions

This benchmark does **not** establish:

- That batch=6 is the final production batch size
- That WASM is the final production runtime
- That 29.5 minutes is a stable guaranteed latency
- That Map→Reduce should be promoted into production
- That production AI-02 constants should be changed
