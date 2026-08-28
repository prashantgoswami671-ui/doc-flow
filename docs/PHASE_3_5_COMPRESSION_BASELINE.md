# DocFlow Phase 3.5 Compression Baseline

## Purpose

This is the finalized baseline for Task 3.5. It records the verified
compression behavior of `services/pdf/compress.ts` and
`services/pdf/rasterize.ts`, using the existing real-rasterizer
Playwright harness (`app/test/compression/page.tsx` +
`tests/e2e/compression.integration.spec.ts`) and a manually verified
real-browser PDF run.

The final Light Compression configuration is `scale: 2.2` and
`quality: 0.92`. The `1.5 / 0.92` Light-scale experiment was evaluated
and rejected; it is not part of the final implementation. The harness
page surfaces `mode`, `processingTime`, and `reductionPercent` (values
`compressPDF()` already computes internally) in the JSON test results.

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
| Test A — scanned roundtrip | light | 2 | 29,277 bytes | 139,535 bytes | -376.6% | N/A | raw rasterizer output — intentionally bypasses production fallback |
| Test B — page dimensions | N/A | N/A | N/A | N/A | N/A | N/A | passed — dimensions preserved |
| Test C — rotation metadata and visual dimensions | N/A | N/A | N/A | N/A | N/A | N/A | passed — rotation metadata and visual dimensions preserved |
| Test D — scanned (full pipeline) | light | 2 | N/A | N/A | N/A | N/A | fallback preserved original scanned PDF |
| Test E — image-heavy | light | 2 | N/A | N/A | N/A | N/A | fallback preserved original image-heavy PDF |
| Test F — text/vector | light | 3 | N/A | N/A | N/A | N/A | fallback preserved original text/vector PDF |
| Test G — custom (50% target) | custom | 2 | 43,743 bytes | 20,930 bytes | 52.1523% | N/A | target reached — genuine compression |
| Test H — extreme page-size handling | N/A | N/A | N/A | N/A | N/A | N/A | passed |
| Test I — non-finite render-scale handling | N/A | N/A | N/A | N/A | N/A | N/A | passed |

For Tests D/E/F: `wasFallback` was `true` (original bytes returned
unchanged) and `wasGenuineCompression` was `false`.

For Test G, `targetReached` was `true` and `customExecuted` was `true`.

### Detailed test results

Test A — raw rasterizer output only; this deliberately does not exercise
the production fallback.

Test B — page dimensions preserved.

Test C — rotation metadata and visual dimensions preserved.

Test D — `wasFallback: true`, `wasGenuineCompression: false`, `targetBytes: N/A`

Test E — `wasFallback: true`, `wasGenuineCompression: false`, `targetBytes: N/A`

Test F — `wasFallback: true`, `wasGenuineCompression: false`, `targetBytes: N/A`

Test G — `targetReached: true`, `customExecuted: true`

Test H — extreme page-size handling passed.

Test I — non-finite render-scale handling passed.

### Real-browser Light Compression result

| Fixture | Mode | Pages | Original | Compressed | Reduction | Processing Time | Light settings |
|---|---|---:|---:|---:|---:|---:|---|
| `Dilnasheen Perween Roll no 3-organized.pdf` | Light Compression | 46 | 25.75 MB | 17.24 MB | 33.0% | 7.79 sec | scale 2.2, JPEG quality 0.92 |

This result was manually verified in the browser after restoring Light
from the experimental `1.5` scale to `2.2`.

## Interpretation

The finalized results show the following key outcomes for the
rasterizer-based compression pipeline:

1. **Final Light Compression behavior.** Light `2.2 / 0.92` remains the
   final production setting. The real 46-page, 25.75 MB fixture produced
   a 17.24 MB output in 7.79 sec, validating intended Light-compression
   behavior at 33.0% reduction.

2. **Genuine custom compression (Test G).** The custom target-size mode
   produced 20,930 bytes from 43,743 bytes, a 52.1523% reduction, and
   reached its target.

3. **Fallback / pass-through (Tests D, E, F).** Small synthetic PDFs can
   cause rasterization to produce a larger candidate, but the existing
   production fallback correctly returns the original instead. The
   scanned, image-heavy, and text/vector full-pipeline fixtures all
   confirmed that behavior.

4. **Raw rasterizer overshoot (Test A).** The light-mode rasterizer on a
   scanned 2-page fixture produced 139,535 bytes from 29,277 bytes, a
   -376.6% reduction. This result must not be interpreted as a production
   compression failure: Test A deliberately calls the rasterizer directly
   to inspect rasterizer behavior and does not exercise the production
   fallback.

5. **Rejected experiment.** The `1.5 / 0.92` Light-scale experiment
   produced approximately the same 25.75 MB output as the original real
   PDF, meaning the compression pipeline fell back to the original rather
   than providing the intended Light compression. It is recorded as an
   evaluated/rejected experiment, not as a final change. The final Light
   configuration remains `scale: 2.2`, `quality: 0.92`.

Tests B, C, H, I are validation/edge-case evidence confirming
dimensional fidelity, rotation handling, extreme page-size handling, and
non-finite render-scale handling; they are not compression measurements.
Adaptive intrinsic-resolution detection is outside the scope of this
Phase 3.5 checkpoint.

## Other verification

- `npm run test:e2e -- tests/e2e/compression.integration.spec.ts` — 9/9
  Playwright tests passed
- `npx tsc --noEmit` — passed
- `npm run lint` — 0 errors, 5 warnings
- `npm run build` — passed

The five ESLint warnings are existing warnings in `ImageToPdfCard.tsx`
and `PdfToImageCard.tsx`; they were not introduced by Phase 3.5.

## Reproduction

```
npm run test:e2e -- tests/e2e/compression.integration.spec.ts
```

Read each test's rendered `data-testid="results"` JSON (or the
Playwright HTML/trace report) for the exact `originalSize`,
`processedSize`, `reductionPercent`, `processingTime`, `pageCount`,
`mode`, and fallback/target fields, and transcribe them verbatim into
the table above.
