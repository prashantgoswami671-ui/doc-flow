import { PDFDocument } from "pdf-lib";

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

  // Validated Light settings:
  // scale 2.2 + JPEG quality 0.92 produced a 31.3% reduction
  // on the real ~27 MB test PDF while remaining clear and readable.
  // Scale controls rasterization resolution only; pageViewport below
  // keeps the output PDF's physical page dimensions unchanged
  return {

    // Validated Light settings: scale 2.2 / JPEG quality 0.92
    // produced a 31.3% reduction on the real 27 MB test PDF while
    // remaining clear and readable.


    scale: 2.2,
    quality: 0.92,
  };
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
  releaseResources = false,
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

      // `settings.scale` controls render *resolution* (pixel density) only.
      // It must never determine the output PDF's physical page size — a
      // page.getViewport({ scale }) viewport scales linearly with `scale`,
      // so reusing it for `outputPdf.addPage()` would make Light (scale
      // 2.0) render every page at 2x the original width/height (4x the
      // area) and Custom pages vary in physical size (0.75x-2x) depending
      // on which quality level the binary search lands on. `pageViewport`
      // (scale: 1) is the physical page size — same bounding box pdf-lib
      // reports for the original page, rotation included, since PDF.js
      // applies the page's own /Rotate by default for both viewports.
      // `renderViewport` is only used to size the canvas/JPEG so quality
      // settings still control detail, independent of page geometry.
      const pageViewport = page.getViewport({ scale: 1 });
      const renderViewport = page.getViewport({ scale: settings.scale });

      const canvas = document.createElement("canvas");

      canvas.width = Math.max(1, Math.ceil(renderViewport.width));
      canvas.height = Math.max(1, Math.ceil(renderViewport.height));

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
