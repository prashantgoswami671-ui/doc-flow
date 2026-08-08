import { PDFDocument } from "pdf-lib";

export type RasterCompressionMode = "light" | "heavy";

function getSettings(mode: RasterCompressionMode) {
  if (mode === "heavy") {
    return {
      scale: 1.0,
      quality: 0.55,
    };
  }

  return {
    // Keep more detail than Heavy while avoiding the previous upscaling.
    scale: 2.0,
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
  // Import PDF.js only in the browser.
  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");

  // `disableWorker` is not a supported getDocument option in pdfjs-dist v6.
  // Resolve the matching worker through Turbopack so PDF.js can create it.
  pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
    "pdfjs-dist/legacy/build/pdf.worker.min.mjs",
    import.meta.url,
  ).toString();

  const settings = getSettings(mode);

  const inputBytes = new Uint8Array(await file.arrayBuffer());

  const loadingTask = pdfjsLib.getDocument({
    data: inputBytes,
  });

  const pdf = await loadingTask.promise;

  const outputPdf = await PDFDocument.create();

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
    const page = await pdf.getPage(pageNumber);

    const viewport = page.getViewport({
      scale: settings.scale,
    });

    const canvas = document.createElement("canvas");

    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);

    const context = canvas.getContext("2d");

    if (!context) {
      throw new Error("Unable to create canvas rendering context.");
    }

    await page.render({
      canvas,
      canvasContext: context,
      viewport,
    }).promise;

    const jpegDataUrl = canvas.toDataURL(
      "image/jpeg",
      settings.quality,
    );

    const jpegResponse = await fetch(jpegDataUrl);

    const jpegBytes = new Uint8Array(
      await jpegResponse.arrayBuffer(),
    );

    const image = await outputPdf.embedJpg(jpegBytes);

    const outputPage = outputPdf.addPage([
      viewport.width,
      viewport.height,
    ]);

    outputPage.drawImage(image, {
      x: 0,
      y: 0,
      width: viewport.width,
      height: viewport.height,
    });
  }

  return outputPdf.save();
}
