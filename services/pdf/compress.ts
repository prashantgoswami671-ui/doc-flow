import { PDFDocument } from "pdf-lib";
import { rasterizePDF } from "./rasterize";

/** Supported compression presets. */
export type CompressionMode = "light" | "heavy" | "custom";

/** Information returned after processing a PDF. */
export interface CompressionResult {
  bytes: Uint8Array;
  originalSize: number;
  processedSize: number;
  reductionPercent: number;
  processingTime: number;
  pageCount: number;
  mode: CompressionMode;
}

export async function compressPDF(
  file: File,
  mode: CompressionMode,
): Promise<CompressionResult> {
  const startTime = performance.now();

  const originalSize = file.size;

  let savedPdfBytes: Uint8Array;
  let pageCount: number;

  /*
   * Light and Heavy compression:
   * Render every PDF page as a JPEG image and
   * rebuild the PDF using the compressed images.
   */
  if (mode === "light" || mode === "heavy") {
    const rasterMode = mode === "light" ? "light" : "heavy";

    savedPdfBytes = await rasterizePDF(file, rasterMode);

    // Get the original page count.
    const originalPdfBytes = await file.arrayBuffer();
    const originalPdf = await PDFDocument.load(originalPdfBytes);

    pageCount = originalPdf.getPageCount();

    if (
      mode === "light" &&
      (savedPdfBytes.length >= originalSize ||
        savedPdfBytes.length < originalSize * 0.6)
    ) {
      savedPdfBytes = new Uint8Array(originalPdfBytes);
    }
  } else {
    /*
     * Custom compression is not implemented yet.
     * For now, use the normal pdf-lib load/save pipeline.
     */
    const pdfBytes = await file.arrayBuffer();
    const pdfDoc = await PDFDocument.load(pdfBytes);

    savedPdfBytes = await pdfDoc.save();
    pageCount = pdfDoc.getPageCount();
  }

  const processedSize = savedPdfBytes.length;

  const reductionPercent =
    originalSize === 0
      ? 0
      : ((originalSize - processedSize) / originalSize) * 100;

  const processingTime = performance.now() - startTime;

  return {
    bytes: savedPdfBytes,
    originalSize,
    processedSize,
    reductionPercent,
    processingTime,
    pageCount,
    mode,
  };
}
