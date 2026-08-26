# Phase 3.3 — Real Rasterizer Browser Harness

## Purpose

This is the first Phase 3.3 step after the inspection report. It validates the real browser-only path before any changes are made to `services/pdf/compress.ts` or `services/pdf/rasterize.ts`.

The harness exercises:

- PDF.js document loading
- PDF.js page rendering
- real browser Canvas rendering
- real JPEG encoding through `canvas.toBlob()`
- JPEG embedding through pdf-lib
- output PDF serialization
- the existing `compressPDF()` orchestration for selected cases

The rasterizer is **not mocked**.

## Run locally

Start the development server:

```powershell
npm run dev
```

Open:

```text
http://localhost:3000/__phase-3-3__/rasterizer
```

Click **Run all Phase 3.3 tests**.

## Tests currently included

### 1. Real rasterizer — scanned PDF roundtrip

Creates a deterministic scan-like two-page PDF in the browser and calls:

```ts
rasterizePDFWithSettings(file, { scale: 1, quality: 0.55 }, true)
```

Checks:

- output is loadable by pdf-lib
- page count is preserved
- physical page width/height are preserved
- Heavy rasterization actually reduces the source size

### 2. Real rasterizer — rotation preservation

Creates four pages with `/Rotate` values `0`, `90`, `180`, and `270`, then runs the real rasterizer.

Checks:

- page count
- page rotation
- media-box dimensions

This test is intentionally strict. If the current implementation does not preserve the `/Rotate` entry, the test should fail and record that as an evidence-based Phase 3.3 finding. Do not modify the engine merely to make the test green.

### 3. Compression engine — text/vector fallback

Creates a small selectable-text/vector PDF and runs the real `compressPDF(file, "light")` path.

Checks:

- compression never returns a larger successful result
- if the original-size fallback is selected, the returned bytes are unchanged
- result remains a valid PDF

### 4. Compression engine — reachable custom target

Creates a scan-like PDF and requests a target at 90% of the original size.

Checks:

- output is valid
- output is smaller than original
- output is at or below the requested target

## Important

This harness is evidence gathering, not an engine fix.

Do **not** change compression settings, fallback thresholds, page geometry logic, or Custom binary-search logic until the browser results identify a concrete failure and the failure is understood.

## Current expected outcome

The most important result is not necessarily `4/4 PASS`.

A failure in the rotation test may reveal that the current rasterizer preserves the **visual orientation and viewport dimensions** but does not copy the original PDF page's `/Rotate` metadata into the reconstructed page. That distinction must be verified by the browser result before changing implementation.
