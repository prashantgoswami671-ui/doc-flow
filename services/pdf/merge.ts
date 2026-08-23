import { PDFDocument } from "pdf-lib";

export interface MergeResult {
  bytes: Uint8Array;
  fileCount: number;
  totalPageCount: number;
  processingTime: number;
}

/**
 * Merges multiple PDFs into one, in the given order.
 *
 * Pages are copied with pdf-lib's `copyPages`, the same approach
 * `extractPages` uses, so page dimensions, rotation metadata, vector
 * content and embedded fonts/resources carry over as far as pdf-lib
 * permits. Pages are never rasterized or re-encoded.
 */
export async function mergePdfs(files: File[]): Promise<MergeResult> {
  const startTime = performance.now();

  if (files.length < 2) {
    throw new Error("Select at least two PDFs to merge.");
  }

  const mergedPdf = await PDFDocument.create();
  let totalPageCount = 0;

  for (const file of files) {
    let sourcePdf: PDFDocument;

    try {
      const sourceBytes = await file.arrayBuffer();
      sourcePdf = await PDFDocument.load(sourceBytes);
    } catch (loadError) {
      const message = loadError instanceof Error ? loadError.message : "";

      if (/encrypt/i.test(message)) {
        throw new Error(
          `"${file.name}" is password protected. Use Unlock PDF first, then merge the unlocked file.`,
        );
      }

      throw new Error(
        `"${file.name}" could not be read as a PDF. It may be corrupted or not a valid PDF file.`,
      );
    }

    const pageIndices = sourcePdf.getPageIndices();
    const copiedPages = await mergedPdf.copyPages(sourcePdf, pageIndices);

    for (const page of copiedPages) {
      mergedPdf.addPage(page);
    }

    totalPageCount += pageIndices.length;
  }

  if (totalPageCount === 0) {
    throw new Error("The selected PDFs do not contain any pages to merge.");
  }

  const bytes = await mergedPdf.save();

  return {
    bytes,
    fileCount: files.length,
    totalPageCount,
    processingTime: performance.now() - startTime,
  };
}
