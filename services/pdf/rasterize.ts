import { degrees, PDFDocument } from "pdf-lib";

export type RasterCompressionMode = "light" | "heavy";

export interface RasterSettings {
  scale: number;
  quality: number;
}

// Exported (not just used internally) so compress.test.ts / rasterize.test.ts
// can assert on the concrete Light/Heavy numbers directly, instead of only
// observing them indirectly through mocked rasterizePDF() call args.
export function getSettings(mode: RasterCompressionMode): RasterSettings {
  if (mode === "heavy") {
    return {
      scale: 1.0,
      quality: 0.55,
    };
  }

  // Validated Light settings (Phase 3.5 baseline):
  // scale 2.2 + JPEG quality 0.92 produced a 33.0% reduction on the real
  // ~27 MB test PDF while remaining clear and readable. Scale controls
  // rasterization resolution only; pageViewport below keeps the output
  // PDF's physical page dimensions unchanged.
  return {
    scale: 2.2,
    quality: 0.92,
  };
}

/**
 * Normalizes a PDF.js page's `/Rotate`-derived `rotate` value (which can be
 * negative or >= 360, e.g. from malformed source PDFs) into the 0-359
 * range, in a multiple of 90.
 */
export function normalizeRotationDegrees(rotate: number): number {
  return ((rotate % 360) + 360) % 360;
}

// Phase 3.5 — Rasterizer robustness / edge-case hardening.
//
// PHASE_3_3_INSPECTION_REPORT.md (Risk 3, "Canvas Memory/Size Limits")
// flagged that nothing here guards against very large pages producing a
// canvas the browser can't/shouldn't allocate: canvas.width/height were
// set directly from renderViewport with no upper bound, so a large
// physical page (e.g. a poster-sized custom page size) combined with
// Light's scale 2.2 or Custom's max scale 2.0 could request a canvas
// beyond what browsers reliably support, risking a crash, a silently
// zero-sized canvas, or excessive memory use.
//
// 16384px is used as the safe per-dimension ceiling because it's the
// figure the project's own inspection report cites as the typical Chrome
// canvas dimension limit (memory limits aside), and it comfortably clears
// every existing fixture (e.g. the 2000x3000pt "large" unusual-page-size
// fixture at Light's scale 2.2 is 4400x6600 — well under this ceiling —
// and the 2480x3508 high-res-scan fixture at 2.2 is 5456x7718), so normal
// and already-tested pages render at their existing resolution, unchanged.
export const MAX_CANVAS_DIMENSION = 16384;

/**
 * Given a page's intrinsic (scale=1) width/height and the requested raster
 * `scale`, returns the scale that should actually be used to render the
 * page: `scale` unchanged if the resulting canvas would fit within
 * `maxDimension` on its longest side, otherwise `scale` reduced by
 * whatever factor brings the longest side down to `maxDimension` (aspect
 * ratio preserved).
 *
 * This only ever affects raster *resolution* — it must never be used to
 * compute the output PDF's physical page size (that remains
 * `pageViewport` at the unclamped scale=1, exactly as before), so page
 * count, physical dimensions, and rotation semantics are all unaffected;
 * only the sharpness of the embedded JPEG is reduced, and only for pages
 * large enough that the unclamped render would otherwise risk failing to
 * allocate a canvas at all.
 */
export function computeSafeRenderScale(
  pageWidth: number,
  pageHeight: number,
  scale: number,
  maxDimension: number = MAX_CANVAS_DIMENSION,
): number {
  const requestedWidth = pageWidth * scale;
  const requestedHeight = pageHeight * scale;
  const longestSide = Math.max(requestedWidth, requestedHeight);

  if (!Number.isFinite(longestSide) || longestSide <= maxDimension) {
    return scale;
  }

  return scale * (maxDimension / longestSide);
}

// Phase 3.6 — Rasterizer robustness / edge-case hardening (next gap after
// Phase 3.5's canvas-size guard).
//
// canvas.width/height were computed as `Math.max(1, Math.ceil(value))`.
// That reads as a safe floor, but Math.max/Math.ceil both propagate NaN:
// `Math.max(1, Math.ceil(NaN))` is NaN, not 1. Per the HTML canvas spec,
// assigning a non-finite number to canvas.width/height then silently
// coerces to 0. So a non-finite renderViewport dimension slipped straight
// past the existing guard into an unusable canvas, with no clear error —
// just a confusing downstream failure in page.render()/JPEG encoding.
//
// This is reachable because rasterizePDFWithSettings is an exported,
// directly-callable function that performs no validation on `settings`:
// nothing today stops a caller from passing a non-finite `scale`. It's
// also distinct from Phase 3.5's guard: computeSafeRenderScale above
// explicitly returns `scale` unchanged whenever its own longestSide
// computation is non-finite (it can't meaningfully clamp a broken
// number), so a non-finite scale sails through it unchanged into the raw
// canvas assignment this function guards instead.
//
// For every existing finite value this returns exactly what the old
// `Math.max(1, Math.ceil(value))` expression already returned, so no
// currently-tested page's rendered resolution changes.
export function computeSafeCanvasDimension(value: number): number {
  if (!Number.isFinite(value)) {
    return 1;
  }

  return Math.max(1, Math.ceil(value));
}

/**
 * Converts a PDF into a new PDF made from compressed JPEG page images.
 *
 * This is intended for aggressive compression.
 * Because pages are rasterized, selectable text is not preserved.
 */
export async function rasterizePDF(
  file: File,
  mode: RasterCompressionMode,
): Promise<Uint8Array> {
  // Light/Heavy compression must release PDF.js resources (page/canvas
  // cleanup, pdf.cleanup(), loadingTask.destroy()) exactly like the Custom
  // mode path already does below — otherwise every page render in this
  // mode leaks. This does not change scale, quality, or the encoded bytes
  // for any page: `releaseResources` only switches the JPEG-encode call
  // from canvas.toDataURL()+fetch() to the equivalent canvas.toBlob(), and
  // adds the same finally-block cleanup already used elsewhere.
  return rasterizePDFWithSettings(file, getSettings(mode), true);
}

export async function rasterizePDFWithSettings(
  file: File,
  settings: RasterSettings,
  releaseResources = true,
): Promise<Uint8Array> {
  // Import PDF.js only in the browser.
  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");

  // `disableWorker` is not a supported getDocument option in pdfjs-dist v6.
  // Resolve the matching worker through Turbopack so PDF.js can create it.
  pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
    "pdfjs-dist/legacy/build/pdf.worker.min.mjs",
    import.meta.url,
  ).toString();

  const inputBytes = new Uint8Array(await file.arrayBuffer());

  const loadingTask = pdfjsLib.getDocument({
    data: inputBytes,
  });

  const pdf = await loadingTask.promise;

  const outputPdf = await PDFDocument.create();

  try {
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      const page = await pdf.getPage(pageNumber);

      // The source page's /Rotate value, normalized to one of 0/90/180/270.
      // Captured here so it can be written back out as output PDF rotation
      // metadata below, instead of only being baked into pixels.
      const sourceRotation = normalizeRotationDegrees(page.rotate);

      // `settings.scale` controls render *resolution* (pixel density) only.
      // It must never determine the output PDF's physical page size — a
      // page.getViewport({ scale }) viewport scales linearly with `scale`,
      // so reusing it for `outputPdf.addPage()` would make Light (scale
      // 2.0) render every page at 2x the original width/height (4x the
      // area) and Custom pages vary in physical size (0.75x-2x) depending
      // on which quality level the binary search lands on. `pageViewport`
      // (scale: 1, rotation: 0) is the page's *intrinsic* (pre-rotation)
      // physical size — the same bounding box pdf-lib reports for the
      // original page before /Rotate is applied. `renderViewport` is only
      // used to size the canvas/JPEG so quality settings still control
      // detail, independent of page geometry. Both viewports pin
      // `rotation: 0` (rather than letting PDF.js apply the page's own
      // /Rotate as it does by default) so the raster is produced in the
      // page's un-rotated orientation; `outputPage.setRotation()` below
      // reapplies `sourceRotation` for display. Baking the rotation into
      // the pixels here (the previous behavior) and then also writing
      // /Rotate metadata would rotate the page twice.
      const pageViewport = page.getViewport({ scale: 1, rotation: 0 });

      // Phase 3.5: clamp only the *render* scale, never pageViewport
      // above (physical output size) — see computeSafeRenderScale's doc
      // comment. Unaffected for every page/mode already covered by
      // existing tests; only engages for pages large enough that the
      // unclamped canvas would risk exceeding what browsers support.
      const safeScale = computeSafeRenderScale(
        pageViewport.width,
        pageViewport.height,
        settings.scale,
      );
      const renderViewport = page.getViewport({
        scale: safeScale,
        rotation: 0,
      });

      const canvas = document.createElement("canvas");

      canvas.width = computeSafeCanvasDimension(renderViewport.width);
      canvas.height = computeSafeCanvasDimension(renderViewport.height);

      const context = canvas.getContext("2d");

      if (!context) {
        throw new Error("Unable to create canvas rendering context.");
      }

      try {
        await page.render({
          canvas,
          canvasContext: context,
          viewport: renderViewport,
        }).promise;

        let jpegBytes: Uint8Array;

        if (releaseResources) {
          const jpegBlob = await new Promise<Blob>((resolve, reject) => {
            canvas.toBlob((blob) => {
              if (blob) {
                resolve(blob);
              } else {
                reject(new Error("Unable to encode page as JPEG."));
              }
            }, "image/jpeg", settings.quality);
          });

          jpegBytes = new Uint8Array(await jpegBlob.arrayBuffer());
        } else {
          const jpegDataUrl = canvas.toDataURL(
            "image/jpeg",
            settings.quality,
          );
          const jpegResponse = await fetch(jpegDataUrl);

          jpegBytes = new Uint8Array(await jpegResponse.arrayBuffer());
        }
        const image = await outputPdf.embedJpg(jpegBytes);

        const outputPage = outputPdf.addPage([
          pageViewport.width,
          pageViewport.height,
        ]);

        outputPage.setRotation(degrees(sourceRotation));

        outputPage.drawImage(image, {
          x: 0,
          y: 0,
          width: pageViewport.width,
          height: pageViewport.height,
        });
      } finally {
        if (releaseResources) {
          page.cleanup();
          canvas.width = 0;
          canvas.height = 0;
        }
      }

      // Yield to the browser between pages. The JPEG encode above
      // (canvas.toDataURL / toBlob) and the surrounding render/embed work
      // run on the main thread with few natural yield points, so on
      // multi-page PDFs the tab can go unresponsive for the whole loop.
      // This does not change scale, quality, or the encoded bytes for any
      // page — it only lets the browser paint/handle input between pages.
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }

    return outputPdf.save();
  } finally {
    if (releaseResources) {
      pdf.cleanup();
      await loadingTask.destroy();
    }
  }
}
