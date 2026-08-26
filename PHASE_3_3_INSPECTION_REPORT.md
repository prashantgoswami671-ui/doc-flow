# DocFlow Phase 3.3 — Compression Engine Inspection Report

---

## 1. Current Compression Pipeline

### Overview

The compression engine lives in two files:

- `services/pdf/compress.ts` — orchestrates compression, handles modes, fallbacks, and result formatting
- `services/pdf/rasterize.ts` — performs the actual PDF-to-JPEG-to-PDF rasterization

### Entry Point: `compressPDF(file, mode, customTargetSizeMb?)`

1. **Timer starts** (`performance.now()`)
2. **Source PDF is loaded once** via `loadCompressibleSourceOrThrow(file)`:
   - Reads the `File` into an `ArrayBuffer`
   - Loads with `pdf-lib`'s `PDFDocument.load()` to validate structure
   - Detects encryption by regex-matching the error message (`/encrypt/i`)
   - Returns `{ originalPdfBytes: ArrayBuffer, pageCount: number }`
3. **Mode branching**:
   - If `mode === "light" || mode === "heavy"`:
     - Calls `rasterizePDF(file, mode)`
     - Applies mode-specific fallback thresholds
   - If `mode === "custom"`:
     - Validates `customTargetSizeMb` is a positive finite number
     - If `originalSize <= targetBytes`, returns original bytes (short-circuit)
     - Otherwise calls `compressToCustomTarget(file, originalBytes, originalSize, targetBytes)`
4. **Post-processing**:
   - `processedSize = savedPdfBytes.length`
   - `reductionPercent = ((originalSize - processedSize) / originalSize) * 100` (or `0` if `originalSize === 0`)
   - `processingTime = performance.now() - startTime`
5. **Returns** `CompressionResult` object

### Rasterization Path: `rasterizePDF(file, mode)` → `rasterizePDFWithSettings(file, settings, releaseResources?)`

1. **PDF.js setup**:
   - Dynamic import of `pdfjs-dist/legacy/build/pdf.mjs`
   - Worker configured via `GlobalWorkerOptions.workerSrc` with `new URL(...)` for Turbopack
2. **Document loading**:
   - Reads file into `Uint8Array`
   - Calls `pdfjsLib.getDocument({ data: inputBytes })`
   - Awaits `loadingTask.promise`
3. **Per-page loop** (1-based, `for pageNumber = 1 to pdf.numPages`):
   - Gets page via `pdf.getPage(pageNumber)`
   - Creates **two viewports**:
     - `pageViewport = page.getViewport({ scale: 1 })` — physical page dimensions
     - `renderViewport = page.getViewport({ scale: settings.scale })` — rasterization resolution
   - Creates `<canvas>` sized to `renderViewport` dimensions (ceiled, min 1×1)
   - Renders page to canvas via `page.render({ canvas, canvasContext, viewport: renderViewport })`
   - **JPEG encoding** (two paths):
     - If `releaseResources === true`: `canvas.toBlob("image/jpeg", quality)` → `Blob`
     - If `releaseResources === false`: `canvas.toDataURL("image/jpeg", quality)` → `fetch()` the data URL
   - Embeds JPEG into output PDF via `outputPdf.embedJpg(jpegBytes)`
   - **Adds output page** at `pageViewport.width × pageViewport.height` (physical dimensions)
   - **Draws image** at `(0, 0)` with `pageViewport.width × pageViewport.height`
   - **Cleanup** (only if `releaseResources === true`):
     - `page.cleanup()`
     - `canvas.width = 0; canvas.height = 0`
   - **Yield**: `requestAnimationFrame` between pages
4. **Final save**: `outputPdf.save()`
5. **Document cleanup** (only if `releaseResources === true`):
   - `pdf.cleanup()`
   - `loadingTask.destroy()`

### Key Design Decisions

- **Two-viewport design**: `pageViewport` (scale=1) for physical dimensions, `renderViewport` (scale=settings.scale) for rasterization resolution. This is the critical mechanism that preserves page geometry independently of quality settings.
- **Light/Heavy both use `releaseResources = true`**: Both paths go through the `canvas.toBlob()` + cleanup code path.
- **Custom uses `rasterizePDFWithSettings` directly**: Same underlying function, just with different settings.

---

## 2. Light / Heavy / Custom Behavior

### Light Mode

- **Settings**: `scale: 2.2`, `quality: 0.92`
- **Path**: `rasterizePDF(file, "light")` → `rasterizePDFWithSettings(file, {scale: 2.2, quality: 0.92}, true)`
- **Fallback thresholds**:
  - If output `>= originalSize`: falls back to original bytes
  - If output `< originalSize * 0.6`: falls back to original bytes (suspiciously small)
- **Intent**: Prioritize readability/detail over aggressive reduction
- **Validated**: Produced 31.3% reduction on a ~27 MB real test PDF

### Heavy Mode

- **Settings**: `scale: 1.0`, `quality: 0.55`
- **Path**: `rasterizePDF(file, "heavy")` → `rasterizePDFWithSettings(file, {scale: 1.0, quality: 0.55}, true)`
- **Fallback thresholds**:
  - If output `>= originalSize`: falls back to original bytes
  - **No lower-bound sanity check** (unlike Light)
- **Intent**: Aggressive compression, accepts substantially stronger reduction

### Custom Mode

- **Range**: `scale ∈ [0.75, 2.0]`, `quality ∈ [0.45, 0.92]`
- **Search space**: Linear interpolation via `level ∈ [0, 1]`
  - `scale = 0.75 + (2.0 - 0.75) * level`
  - `quality = 0.45 + (0.92 - 0.45) * level`
- **Algorithm** (`compressToCustomTarget`):
  1. Measures highest-quality candidate (`level = 1`, i.e., `scale: 2.0`, `quality: 0.92`)
     - If `<= targetBytes`: returns it immediately
  2. Measures lowest-quality candidate (`level = 0`, i.e., `scale: 0.75`, `quality: 0.45`)
     - If `<= targetBytes`: performs binary search over `level ∈ [0, 1]` for `CUSTOM_BINARY_SEARCH_ATTEMPTS = 5` iterations
     - Binary search tracks `bestWithinTarget` (largest file still under target) vs `smallestPractical` (smallest file overall when target is unreachable)
  3. Returns `bestWithinTarget ?? smallestPractical ?? originalBytes`
- **Short-circuit**: If `originalSize <= targetBytes`, returns original immediately without rasterizing
- **Candidate filtering**: Only candidates `size < originalSize` are considered. If no candidate beats the original, original is returned.
- **Binary search details**:
  - Initial range: `[lowerLevel=0, upperLevel=1]`
  - Midpoint: `(lowerLevel + upperLevel) / 2`
  - If `size <= targetBytes`: `lowerLevel = level` (move toward higher quality)
  - Else: `upperLevel = level` (move toward lower quality)
  - After 5 iterations, returns `bestWithinTarget` (the best candidate found during search)

### Candidate Selection Logic (Custom)

```
for each candidate:
  if size < originalSize:
    if size <= targetBytes:
      pick the LARGEST such file (closest to target without exceeding)
    else (above target but still smaller than original):
      pick the SMALLEST such file (best effort when target unreachable)
```

This means Custom **prefers larger files within the target** rather than the smallest possible — it maximizes quality while staying under budget.

---

## 3. Compression Engine Invariants

### PDF Correctness (All Modes)

| # | Invariant | Evidence |
|---|-----------|----------|
| 3.1 | Output is a valid, loadable PDF | `outputPdf.save()` from pdf-lib; tests verify with `PDFDocument.load(result.bytes)` |
| 3.2 | Page count is preserved | `outputPdf.addPage()` called once per input page; tests verify page count |
| 3.3 | Physical page dimensions are preserved | `pageViewport = page.getViewport({ scale: 1 })` used for `addPage([w, h])`; `pageViewport` is the unscaled PDF.js viewport which includes the page's natural `/Rotate` |
| 3.4 | Page rotation is preserved | `page.getViewport({ scale: 1 })` inherits the page's intrinsic rotation; `outputPdf.addPage()` uses the rotated dimensions |
| 3.5 | No page is silently lost | Loop iterates `1` to `pdf.numPages` inclusive; every iteration calls `addPage()` |

### Rasterization

| # | Invariant | Evidence |
|---|-----------|----------|
| 3.6 | Rasterization scale affects rendered pixel resolution only | `renderViewport` (scale) sets canvas size; `pageViewport` (scale=1) sets output page size |
| 3.7 | Rasterization scale must not alter physical PDF page dimensions | Output page uses `pageViewport.width/height`, not `renderViewport.width/height` |
| 3.8 | JPEG quality affects image encoding | Passed as third argument to `canvas.toBlob("image/jpeg", quality)` and `canvas.toDataURL("image/jpeg", quality)` |
| 3.9 | Rendered pages are embedded at original physical dimensions | `drawImage(image, { x: 0, y: 0, width: pageViewport.width, height: pageViewport.height })` |
| 3.10 | Light always uses scale `2.2`, quality `0.92` | Hard-coded in `getSettings("light")`; verified by `rasterize.test.ts` |
| 3.11 | Heavy always uses scale `1.0`, quality `0.55` | Hard-coded in `getSettings("heavy")`; verified by `rasterize.test.ts` |
| 3.12 | Custom uses independent scale/quality range | `CUSTOM_MIN_SCALE=0.75`, `CUSTOM_MAX_SCALE=2.0`, `CUSTOM_MIN_QUALITY=0.45`, `CUSTOM_MAX_QUALITY=0.92` defined in `compress.ts`, not in `rasterize.ts` |
| 3.13 | Custom's search range must not mutate Light/Heavy settings | Light/Heavy settings live in `rasterize.ts`; Custom settings are interpolated from constants in `compress.ts`; no shared state |

### Safety / Fallback

| # | Invariant | Evidence |
|---|-----------|----------|
| 3.14 | Never return a larger file as a successful compression when the mode promises compression | Light/Heavy: `savedPdfBytes.length >= originalSize` → fallback to original; Custom: candidates filtered by `size < originalSize` |
| 3.15 | Never return malformed/truncated PDF bytes | `outputPdf.save()` always produces a complete PDF; fallback uses `new Uint8Array(originalPdfBytes)` which was already validated by `PDFDocument.load()` |
| 3.16 | Corrupted/encrypted input produces intended user-facing errors | `loadCompressibleSourceOrThrow()` catches `PDFDocument.load()` errors, checks `/encrypt/i`, throws specific messages; tests verify both paths |
| 3.17 | If no Custom candidate is smaller than original, original is returned | `return bestWithinTarget ?? smallestPractical ?? originalBytes` |
| 3.18 | If Custom target is above/at original size, no rasterization occurs | Early return: `originalSize <= targetBytes ? originalBytes : ...` |

### Resource Safety

| # | Invariant | Evidence |
|---|-----------|----------|
| 3.19 | PDF.js page resources are released | `page.cleanup()` in `finally` block when `releaseResources=true` |
| 3.20 | Canvases are released/reset | `canvas.width = 0; canvas.height = 0` in `finally` block |
| 3.21 | PDF.js document cleanup occurs | `pdf.cleanup()` in outer `finally` block |
| 3.22 | Loading task destruction occurs | `loadingTask.destroy()` in outer `finally` block |
| 3.23 | Multi-page processing yields to the browser | `requestAnimationFrame` between every page |

---

## 4. Invariants vs Expected Behavior vs Unsupported Assumptions

### Invariants (Must Always Hold)

1. **Page count is preserved** — deterministic loop over all pages.
2. **Physical page dimensions are preserved** — `pageViewport` at scale=1 used for output.
3. **Page rotation is preserved** — PDF.js viewport inherits intrinsic rotation.
4. **No page is silently lost** — explicit loop with `addPage()` per iteration.
5. **Light settings are fixed** — hard-coded `scale: 2.2`, `quality: 0.92`.
6. **Heavy settings are fixed** — hard-coded `scale: 1.0`, `quality: 0.55`.
7. **Custom settings range is independent** — constants in `compress.ts`, not shared with Light/Heavy.
8. **Custom never returns a larger file** — filtered by `size < originalSize`.
9. **Custom short-circuits when target ≥ original** — no rasterization, returns original.
10. **Invalid Custom target throws** — `!Number.isFinite(customTargetSizeMb) || customTargetSizeMb <= 0` throws `"A positive custom target size is required."`.
11. **Encrypted input throws password-protected error** — regex detection on pdf-lib error.
12. **Corrupted input throws read error** — generic catch after encryption check.
13. **Resource cleanup runs on all paths** — `finally` blocks in `rasterizePDFWithSettings`.
14. **Browser yields between pages** — `requestAnimationFrame` in loop.
15. **Selectable text is NOT preserved** — explicitly documented in `rasterize.ts` JSDoc.

### Expected Behavior (Normal Tendency, Not Guaranteed)

1. **Lower JPEG quality produces a smaller file** — Generally true for photographic content, but highly dependent on image entropy. A flat-color page may compress similarly at q=0.45 and q=0.92.
2. **Lower scale produces a smaller file** — Fewer pixels = smaller JPEG, but the relationship is sublinear and content-dependent.
3. **Heavy produces smaller output than Light** — Expected because Heavy uses lower scale and quality, but the actual delta depends on source content.
4. **Light produces output between 60% and 100% of original** — This is the *acceptable window*, not a guarantee. The 60% floor is a safety check, not a target.
5. **Custom binary search converges toward target** — The algorithm attempts this, but with only 5 iterations and monotonicity assumptions on the mock, real-world convergence is not guaranteed.
6. **Higher scale produces sharper text** — Expected for rasterized output, but perceptual quality also depends on original content resolution and display scaling.

### Unsupported Assumptions (Not Guaranteed by Current Implementation)

1. **Custom always hits the exact requested target size** — ❌ NOT GUARANTEED. The binary search finds the best candidate within 5 attempts. If the target falls between two candidate sizes, it will not hit exactly. Tests explicitly document this as a "baseline finding."
2. **Custom binary search assumes monotonicity** — The algorithm implicitly assumes that `size(level)` is monotonically increasing with `level`. If real rasterization violates this (e.g., due to JPEG encoding entropy at certain quality thresholds), the binary search may behave unpredictably.
3. **Page dimensions are EXACTLY preserved to sub-point precision** — `pageViewport` uses PDF.js's viewport calculation. Subtle differences in how PDF.js vs pdf-lib interpret crop boxes or media boxes could produce minor discrepancies. The implementation does not explicitly assert dimension equality.
4. **Output PDF maintains document-level metadata** — The rasterization rebuilds the PDF from scratch. Bookmarks, outlines, embedded files, form fields, JavaScript, annotations, and document metadata are all lost.
5. **All pages in a multi-page PDF have the same dimensions** — The code handles per-page dimensions correctly, but no test verifies that mixed-dimension PDFs produce correct output per-page.
6. **The rasterizer handles all PDF.js-supported PDFs** — PDF.js has its own limitations (certain font types, transparency modes, blend modes). The engine does not fall back gracefully if PDF.js fails to render a page.
7. **Canvas dimensions never overflow** — For very large pages with high scale (Custom max scale 2.0, Light scale 2.2), the canvas dimensions could exceed browser canvas size limits. There is no guard for this.
8. **Memory usage scales linearly with page count** — While resources are cleaned per-page, the output PDF accumulates all embedded JPEGs in memory until `save()`. Very large documents could OOM.
9. **The 60% Light floor prevents degradation** — It's a heuristic. A 59% output might be perfectly readable; a 61% output might be degraded. The threshold is arbitrary.

---

## 5. PDF-Type Behavior Analysis

### 5.1 Text/Vector PDFs

- **Expected compression benefit**: LOW to NEGATIVE. Text and vector graphics are already highly compact. Rasterizing them to JPEGs typically *increases* file size.
- **Expected quality impact**: HIGH NEGATIVE. Selectable text becomes unselectable images. Vector edges become pixelated. Fonts lose hinting.
- **Rasterization appropriate?**: NO. This is the worst-case content type for this engine.
- **Selectable text preserved?**: NO. Explicitly destroyed by design.
- **Likely failure/edge cases**: Light/Heavy will likely fall back to original bytes (rasterized output > original size). Custom may also return original if no candidate beats it. The 60% Light floor may trigger incorrectly if a text PDF with many pages somehow produces very small rasterized output (unlikely but possible with extreme downsampling).

### 5.2 Scanned PDFs

- **Expected compression benefit**: HIGH. Scanned pages are typically full-page images at high resolution. Rasterizing with controlled scale/quality can substantially reduce size.
- **Expected quality impact**: MODERATE. JPEG artifacts visible at Heavy settings. Light (scale 2.2, q 0.92) should preserve readability.
- **Rasterization appropriate?**: YES. Scanned PDFs are already images; this engine just re-encodes them.
- **Selectable text preserved?**: NO (but there was none to begin with for pure scans).
- **Likely failure/edge cases**: Very high-resolution scans (e.g., 600 DPI) may produce canvas dimensions that exceed browser limits when multiplied by scale 2.2. OCR text layers (if present) are destroyed.

### 5.3 Image-Heavy PDFs

- **Expected compression benefit**: HIGH. Multiple embedded images per page re-encoded to unified JPEG quality.
- **Expected quality impact**: MODERATE. Mixed image types (PNG diagrams, photos, vector art) all flattened to JPEG. Transparency lost. Color shifts possible.
- **Rasterization appropriate?**: MOSTLY YES. If the PDF is primarily for visual consumption, yes. If it contains diagrams with fine detail or transparency, quality loss may be unacceptable.
- **Selectable text preserved?**: NO. Any text overlays become part of the rasterized image.
- **Likely failure/edge cases**: Images with alpha channels (transparency) will have transparency flattened to white or black. Sharp-edged diagrams (e.g., line art) will show JPEG blocking artifacts at lower qualities.

### 5.4 Mixed-Content PDFs

- **Expected compression benefit**: VARIABLE. Depends on text-to-image ratio. Pages with lots of text may not compress well; image-heavy pages will.
- **Expected quality impact**: VARIABLE. Text pages degraded, image pages improved.
- **Rasterization appropriate?**: DEPENDS. Acceptable for archive/sharing, unacceptable for editing.
- **Selectable text preserved?**: NO.
- **Likely failure/edge cases**: Uneven quality across pages — some pages may look great, others degraded. No per-page quality control.

### 5.5 High-Resolution Scans

- **Expected compression benefit**: VERY HIGH. 300–600 DPI scans have massive pixel counts. Even Light mode at scale 2.2 may downsample significantly.
- **Expected quality impact**: MODERATE to HIGH. Fine details (small text, halftone patterns) may moiré or blur.
- **Rasterization appropriate?**: YES, with caveats.
- **Likely failure/edge cases**: Canvas size overflow. A 600 DPI A4 page is ~4961×7016 pixels. At scale 2.2, that's ~10914×15435 — well above typical browser canvas limits (~16384 max dimension in Chrome, but memory-limited before that).

### 5.6 PDFs with Unusual Page Dimensions

- **Expected compression benefit**: UNKNOWN. Depends on content, not dimensions.
- **Expected quality impact**: The scale factor applies uniformly. A 1-inch square page at scale 2.2 gets a 2.2-inch-square canvas. A 6-foot poster at scale 2.2 gets a 13.2-foot canvas — potential overflow.
- **Rasterization appropriate?**: DANGEROUS for very large pages. No safeguards.
- **Likely failure/edge cases**: Canvas dimension overflow, memory exhaustion. `canvas.width/height` are set to `Math.ceil(renderViewport.width/height)` with no upper bound check.

### 5.7 PDFs with Page Rotation

- **Expected compression benefit**: Same as unrotated counterpart.
- **Expected quality impact**: None from rotation itself.
- **Rasterization appropriate?**: YES.
- **Likely failure/edge cases**: The two-viewport design should handle this, but there's no explicit test that verifies a rotated page produces correct output dimensions. The `pageViewport` inherits rotation from PDF.js, but the canvas dimensions use `renderViewport` — if the rotation swaps width/height, the canvas should still be correct since `renderViewport` also inherits rotation.

---

## 6. Existing Test Coverage

### `compress.test.ts` (Phase 3.1 baseline — mocked rasterizer)

| Test | Category |
|------|----------|
| Light: returns smaller valid output, preserves page count | Engine behavior + PDF validity |
| Light: falls back when raster output ≥ original | Fallback behavior |
| Light: falls back when raster output < 60% of original | Fallback behavior |
| Heavy: returns smaller valid output, preserves page count | Engine behavior + PDF validity |
| Heavy: accepts output below 60% floor (no floor for Heavy) | Fallback behavior |
| Heavy: falls back when raster output ≥ original | Fallback behavior |
| Custom: returns original when target > original | Custom target behavior |
| Custom: returns original when target == original | Custom target behavior |
| Custom: preserves dimensions/rotation on identity path | Page geometry |
| Custom: converges via binary search when target reachable | Custom target behavior |
| Custom: falls back to smallest practical when target unreachable | Custom target behavior + Fallback |
| Custom: falls back to original when no candidate beats original | Fallback behavior |
| Custom: returns output larger than target but smaller than original | Custom target behavior |
| Custom: range regression — level 1 = 2.0/0.92, level 0 = 0.75/0.45 | Rasterizer settings |
| Custom: rejects undefined/zero/negative/NaN targets | Error handling |
| Malformed/corrupt PDF: rejects with clear error | Error handling |
| Encrypted PDF: rejects with password-protected error | Error handling |
| Empty PDF (zero pages): light mode behavior | Edge case |
| Empty PDF (zero pages): custom mode behavior | Edge case |
| Fixture coverage: mixed, scan, unusual sizes, high-res | PDF validity + Page count |
| Result shape: originalSize, processingTime | Measurement |
| Result shape: reductionPercent calculation | Measurement |

### `rasterize.test.ts` (Phase 3.2 setting regression)

| Test | Category |
|------|----------|
| Light: uses validated settings (scale 2.2, quality 0.92) | Rasterizer settings |
| Heavy: unchanged settings (scale 1.0, quality 0.55) | Rasterizer settings |
| Light quality > Heavy quality | Rasterizer settings |

### Fixture Builders (`__fixtures__/pdf.ts`)

| Fixture | Pages | Content |
|---------|-------|---------|
| `buildTextVectorPdfBytes` | configurable | Text, headings, lines, rectangles, ellipses |
| `buildScannedImageOnlyPdfBytes` | configurable | Full-bleed PNG image per page |
| `buildImageHeavyPdfBytes` | configurable | 3 images per page |
| `buildMixedPdfBytes` | 3 | Text page + image page + scan page |
| `buildMixedOrientationPdfBytes` | 5 | Portrait, landscape, /Rotate 90/180/270 |
| `buildUnusualPageSizePdfBytes` | 3 | 1×1 inch, letter, 2000×3000 pt |
| `buildEmptyPdfBytes` | 0 (pdf-lib reports 1) | No pages added |
| `buildEncryptedPdfBytes` | 1 | Password-protected |
| `buildMalformedPdfBytes` | 1 (truncated) | Truncated at 50% |
| `buildHighResScanPdfBytes` | 1 | 2480×3508 PNG (~A4 at 300 DPI) |

---

## 7. Phase 3.3 Test Gaps

### Critical Gaps (Real rasterizer not tested)

The entire `rasterizePDFWithSettings` function — the actual canvas rendering, JPEG encoding, and PDF reconstruction — is **never exercised in the test suite**. The unit tests mock it completely. This is the single largest gap.

| Gap | Priority | Why It Matters |
|-----|----------|----------------|
| **Real rasterizer output validation** | CRITICAL | No test verifies that `rasterizePDFWithSettings` actually produces a valid PDF, preserves page count, preserves dimensions, or produces JPEGs at all. |
| **Page dimension preservation with real PDF.js** | HIGH | Mocked tests verify `addPage([w,h])` calls, but the mapping from PDF.js viewport to pdf-lib page size is untested with real data. |
| **Rotation preservation with real PDF.js** | HIGH | No test renders a rotated page and verifies the output has the same rotation and dimensions. |
| **Text-based PDF real compression** | HIGH | No evidence that text PDFs actually compress; they likely expand. Need to verify fallback works in practice. |
| **Scanned PDF real compression** | HIGH | The primary use case. No automated test verifies real size reduction on scanned content. |

### Important Gaps (Mocked coverage incomplete)

| Gap | Priority | Why It Matters |
|-----|----------|----------------|
| **Custom binary search monotonicity assumption** | HIGH | The algorithm assumes size increases monotonically with quality level. If real rasterization violates this, binary search may misbehave. No test validates this assumption. |
| **Custom target not reached: bestWithinTarget is largest under target** | MEDIUM | The code picks the largest file ≤ target, but this is only verified with a mock that obeys monotonicity. |
| **Heavy lower-bound behavior** | MEDIUM | Heavy has no lower sanity check. A bug that produced near-zero-byte output would be accepted. Is this intentional? |
| **Canvas dimension overflow** | MEDIUM | No guard against pages that would exceed browser canvas limits. |
| **Empty PDF (0 pages) → pdf-lib reports 1 page** | LOW | Documented as "baseline finding" but no action taken. Is this acceptable user-facing behavior? |
| **Resource cleanup verification** | MEDIUM | `releaseResources=true` calls cleanup, but there's no test that verifies no leaks occur (would need memory profiling). |
| **PDF.js render failure handling** | HIGH | If `page.render()` throws (e.g., unsupported font, corrupted page content), the error propagates uncaught. The `try/finally` only covers the canvas/embed block, not the render itself. Wait — let me re-read... |

**Re-reading the rasterize.ts error handling**: The `try` block starts AFTER `page.render()` is called? No — looking again:

```typescript
const page = await pdf.getPage(pageNumber);
// ... viewport setup ...
const context = canvas.getContext("2d");
if (!context) throw ...;
try {
  await page.render({...}).promise;
  // ... jpeg encode, embed, draw ...
} finally {
  if (releaseResources) { page.cleanup(); canvas.width = 0; canvas.height = 0; }
}
```

Actually, `page.render()` IS inside the `try`. So render errors would be caught by the outer `try/finally`. But what about `pdf.getPage()` errors? Those are OUTSIDE the `try` — if `getPage()` throws on page N, pages 1..N-1 are already in `outputPdf`, but the outer `finally` would still run `pdf.cleanup()` and `loadingTask.destroy()`. However, `outputPdf.save()` would not be called, so no bytes returned. The error would propagate to `compressPDF` and the user would get a generic error. This is acceptable but not ideal — no per-page error recovery.

### Coverage by Category

| Category | Covered by mocks? | Covered by real rasterizer? | Gap Level |
|----------|-------------------|----------------------------|-----------|
| Engine behavior (mode branching) | ✅ Yes | ❌ No | Low |
| Rasterizer settings (scale/quality) | ✅ Yes | ❌ No | Low |
| Fallback behavior | ✅ Yes (mocks) | ❌ No | Medium |
| Custom target behavior | ✅ Yes (mocks) | ❌ No | Medium |
| PDF validity | ✅ Yes (mock output validated) | ❌ No | **Critical** |
| Page count | ✅ Yes | ❌ No | Medium |
| Geometry/dimensions | ⚠️ Partial (identity path only) | ❌ No | **High** |
| Rotation | ⚠️ Partial (identity path only) | ❌ No | **High** |
| Error handling (encrypted, malformed) | ✅ Yes | N/A | Low |
| Performance/resource behavior | ❌ No | ❌ No | **High** |
| Text-based PDF compression | ❌ No | ❌ No | **High** |
| Scanned PDF compression | ❌ No | ❌ No | **High** |

---

## 8. Implementation Risks

### Risk 1: Untested Real Rasterization Path (CRITICAL)

The actual `rasterizePDFWithSettings` function has zero automated test coverage. All tests mock it. This means:
- Canvas sizing bugs could go undetected
- JPEG encoding issues (browser-specific `toBlob`/`toDataURL` behavior) untested
- PDF.js worker loading failures in production untested
- Page rotation handling with real PDF.js data untested
- Physical dimension preservation with real PDF.js data untested

**Mitigation**: Browser-based integration tests or manual browser checklist verification (referenced in `compress.test.ts` comments).

### Risk 2: Custom Binary Search Monotonicity Assumption (HIGH)

`compressToCustomTarget` assumes that as `level` increases (higher scale, higher quality), output size monotonically increases. This is tested with a mock that enforces this property. In reality:
- JPEG encoding entropy can be non-monotonic with quality (certain images compress better at q=0.6 than q=0.5 due to quantization table boundaries)
- Scale and quality both change simultaneously, compounding unpredictability
- With only 5 binary search iterations, the search space is coarse

**Impact**: Binary search could converge to a suboptimal candidate, or oscillate in edge cases.

### Risk 3: Canvas Memory/Size Limits (HIGH)

No checks on `canvas.width * canvas.height` or individual dimensions. For:
- Large pages (e.g., architectural drawings, posters)
- High scale (Light: 2.2, Custom max: 2.0)
- High-resolution scans

Canvas creation could:
- Exceed browser canvas pixel limits (varies by browser, ~268 megapixels in Chrome, but lower in practice due to memory)
- Cause `canvas` allocation to fail silently (zero-size canvas) or throw
- Cause out-of-memory crashes on large documents

**Impact**: Tab crashes, silent failures, or corrupted output.

### Risk 4: No Per-Page Error Recovery (MEDIUM)

If `page.render()` fails on page N of a 100-page document, the entire compression fails. There's no mechanism to:
- Skip the problematic page
- Fall back to original for that page
- Report partial success

**Impact**: Some valid-but-edge-case PDFs may fail compression entirely.

### Risk 5: Heavy Mode Missing Lower Sanity Check (MEDIUM)

Light has a 60% floor to catch suspiciously small output. Heavy has no equivalent floor. A bug or edge case could produce:
- Near-empty output (all pages rendered as 1×1 pixel due to a bug)
- Severely degraded output accepted as "success"

**Impact**: User receives unusable output without warning. The task spec notes this is a "baseline finding" — it is intentional but carries risk.

### Risk 6: Document-Level Structure Loss (MEDIUM)

The rasterizer builds a completely new PDF. The following are lost:
- Bookmarks / outlines
- Form fields (AcroForm)
- Embedded files / attachments
- JavaScript actions
- Annotations (comments, highlights)
- Document metadata (author, title, etc.)
- Page labels
- Named destinations
- OCR text layers

**Impact**: Users may be surprised that "compressed" PDFs lose functionality. This is a known trade-off of rasterization but may not be obvious.

### Risk 7: No Streaming / Progress Indication (LOW)

Large PDFs process one page at a time with `requestAnimationFrame` yields, but:
- No progress callback to the UI
- The entire PDF is held in memory until `outputPdf.save()`
- No streaming output

**Impact**: Poor UX for large files; potential memory issues with very large documents.

---

## 9. Recommended Next Step

**Add browser-based integration tests first.**

The current unit test suite provides excellent coverage of `compress.ts` logic (branching, fallbacks, error handling, result shape) but exercises the actual rasterization engine (`rasterizePDFWithSettings`) zero times. Every test mocks the boundary. This means the most critical correctness properties — "does the output PDF actually have the right page count?", "are physical dimensions actually preserved?", "does rotation survive?" — are only verified against mocked data, not real PDF.js + canvas behavior.

### Rationale

| Option | Assessment |
|--------|------------|
| **Change the engine** | ❌ Not justified. No bug has been identified. The engine is designed for scanned/image-heavy PDFs and works as intended. |
| **Add tests first** | ✅ Strongly recommended. The critical gap is real rasterizer validation. A browser-based test harness (Playwright, Puppeteer, or even a manual browser checklist as referenced in Phase 3.1/3.2 docs) would validate the untested path before any further changes. |
| **Run real browser benchmarks first** | ⚠️ Useful but secondary. Benchmarks measure performance; they don't prove correctness. Tests should come before benchmarks. |
| **Leave unchanged** | ❌ Risky. The untested rasterization path is the heart of the engine. Without real validation, future changes (including the Phase 3.3 work this inspection precedes) could break it silently. |

### Suggested Test Additions (for browser-based harness)

1. **End-to-end roundtrip**: Upload a real scanned PDF → Light compress → verify valid PDF, correct page count, dimensions preserved, file smaller.
2. **Rotation preservation**: Upload a PDF with /Rotate 90 pages → compress → verify output has same rotation and dimensions.
3. **Text PDF fallback**: Upload a text-only PDF → verify Light/Heavy return original bytes (rasterized output is larger).
4. **Custom target reachability**: Upload an image-heavy PDF → Custom with reachable target → verify output ≤ target and < original.
5. **Canvas limit stress test**: Upload a very large page or high-DPI scan → verify graceful handling (not a crash).

### Conclusion

The compression engine is well-structured and the mocked unit tests thoroughly cover the orchestration layer. The Phase 3.3 work should **begin with adding browser-based integration tests that exercise the real `rasterizePDFWithSettings` path** before making any engine changes. This will establish a correctness baseline for the actual rasterization behavior that the mocks cannot provide.
