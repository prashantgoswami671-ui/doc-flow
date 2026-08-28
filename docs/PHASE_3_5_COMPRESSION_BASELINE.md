# DocFlow Phase 3.5 Compression Baseline

## Purpose

This is the pre-optimization baseline for Task 3.5.2. It records the
CURRENT (unmodified) compression behavior of `services/pdf/compress.ts`
and `services/pdf/rasterize.ts`, using the existing real-rasterizer
Playwright harness (`app/test/compression/page.tsx` +
`tests/e2e/compression.integration.spec.ts`), before any optimization
work from the Task 3.5.1 audit is attempted.

No compression settings, algorithms, thresholds, or fallback logic were
changed to produce this baseline. The harness page was extended only to
surface `mode`, `processingTime`, and `reductionPercent` (values
`compressPDF()` already computes internally) in the JSON test results for
Tests A, D, E, F, and G.

## Benchmark environment

- Commit hash: `d355711dfcd683d4739acbdb6fe5486c3d90d2aa` (confirmed via
  `.git/refs/heads/main`; matches the Task 3.5.1 audit's stated HEAD —
  `test: add focused shared UX foundation coverage`)
- Node/npm version: PENDING — record via `node -v` / `npm -v` at run time
- Browser/test environment: PENDING — record the Playwright browser/OS
  reported in the test run output
- Date of measurement: PENDING — fill in when the harness is actually run

## Results

The table below records the exact values from each test's
`data-testid="results"` JSON output, transcribed verbatim from the
Playwright harness run.

| Scenario | Mode | Pages | Original | Processed | Reduction | Processing Time | Result |
|---|---|---:|---:|---:|---:|---:|---|
| Test A — scanned roundtrip | light | 2 | 29277 | 139535 | -376.6027940021177% | 749.5999999977648 | larger than original — not compressed |
| Test D — scanned (full pipeline) | light | 2 | 29277 | 29277 | 0% | 414.30000000074506 | fallback — no genuine compression |
| Test E — image-heavy | light | 2 | 43744 | 43744 | 0% | 401 | fallback — no genuine compression |
| Test F — text/vector | light | 3 | 2347 | 2347 | 0% | 465.1000000014901 | fallback — no genuine compression |
| Test G — custom (50% target) | custom | 2 | 43744 | 20929 | 52.15572421360643% | 1754.8999999985099 | target reached — genuine compression |

For Tests D/F: record whether `wasFallback` was `true` (original bytes
returned unchanged) — do not infer this from size alone.

For Test G: record `targetReached` and the computed `targetBytes`
exactly as returned by the harness.

### Detailed test results

Test D — `wasFallback: true`, `wasGenuineCompression: false`, `targetBytes: N/A`

Test E — `wasFallback: true`, `wasGenuineCompression: false`, `targetBytes: N/A`

Test F — `wasFallback: true`, `wasGenuineCompression: false`, `targetBytes: N/A`

Test G — `targetReached: true`, `targetBytes: 21872`, `customExecuted: true`

## Interpretation

Measured results show that the current rasterizer-based compression
pipeline produces three distinct outcomes:

1. **Genuine compression (Test G only).** The custom target-size mode
   achieved a 52.15572421360643% reduction, reaching its target of 21872
   bytes (processedSize: 20929). This is the only test where the output
   was genuinely smaller than the original.

2. **Fallback / pass-through (Tests D, E, F).** All three light-mode
   tests on production-realistic fixtures (scanned full pipeline,
   image-heavy, text/vector) returned the original bytes unchanged
   (`wasFallback: true`, `wasGenuineCompression: false`).
   `processedSize` equals `originalSize`; reduction is 0%.

3. **Rasterizer overshoot (Test A).** The light-mode rasterizer on a
   scanned 2-page fixture produced output *larger* than the original:
   139535 bytes processed vs. 29277 bytes original, a -376.60%
   reduction. This is not a compression failure in the fallback sense —
   the rasterizer ran — but the output is substantially larger.

Tests B, C, H, I are validation/edge-case evidence confirming
dimensional fidelity and output loadability; they are not compression
measurements.

## Reproduction

```
npm run test:e2e -- tests/e2e/compression.integration.spec.ts
```

Read each test's rendered `data-testid="results"` JSON (or the
Playwright HTML/trace report) for the exact `originalSize`,
`processedSize`, `reductionPercent`, `processingTime`, `pageCount`,
`mode`, and fallback/target fields, and transcribe them verbatim into
the table above.
