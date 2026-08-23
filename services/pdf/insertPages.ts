import { PDFDocument } from "pdf-lib";
import { parsePageSelection } from "./extract";

export interface InsertPagesResult {
  bytes: Uint8Array;
  targetPageCount: number;
  insertedPageCount: number;
  finalPageCount: number;
  insertPosition: number;
  selectedSourcePageNumbers: number[];
  processingTime: number;
}

/**
 * Validates an insert position against a target PDF's page count.
 * Position is zero-based: 0 means "before page 1" (beginning),
 * targetPageCount means "after the last page" (end).
 */
export function validateInsertPosition(
  insertPosition: number,
  targetPageCount: number,
): void {
  if (
    !Number.isInteger(insertPosition) ||
    insertPosition < 0 ||
    insertPosition > targetPageCount
  ) {
    throw new Error(
      `Insert position must be between 0 (beginning) and ${targetPageCount} (end) for this ${targetPageCount}-page target PDF.`,
    );
  }
}

/**
 * Inserts selected pages from a source PDF into a target PDF at a given
 * position, without modifying either original file.
 *
 * Uses pdf-lib's `copyPages`, the same approach Extract/Organize/Merge/Split
 * already use, so page dimensions, rotation metadata and content are
 * preserved as far as pdf-lib permits. Pages are never rasterized.
 *
 * The page-selection syntax (e.g. "2,4,7" or "2-5") is parsed with the
 * existing `parsePageSelection` from the Extract feature — reused as-is
 * rather than duplicated.
 */
export async function insertPages(
  targetFile: File,
  sourceFile: File,
  sourcePageSelection: string,
  insertPosition: number,
): Promise<InsertPagesResult> {
  const startTime = performance.now();

  let targetPdf: PDFDocument;

  try {
    const targetBytes = await targetFile.arrayBuffer();
    targetPdf = await PDFDocument.load(targetBytes);
  } catch (loadError) {
    const message = loadError instanceof Error ? loadError.message : "";

    if (/encrypt/i.test(message)) {
      throw new Error(
        `"${targetFile.name}" is password protected. Use Unlock PDF first, then insert pages into the unlocked file.`,
      );
    }

    throw new Error(
      `"${targetFile.name}" could not be read as a PDF. It may be corrupted or not a valid PDF file.`,
    );
  }

  let sourcePdf: PDFDocument;

  try {
    const sourceBytes = await sourceFile.arrayBuffer();
    sourcePdf = await PDFDocument.load(sourceBytes);
  } catch (loadError) {
    const message = loadError instanceof Error ? loadError.message : "";

    if (/encrypt/i.test(message)) {
      throw new Error(
        `"${sourceFile.name}" is password protected. Use Unlock PDF first, then insert pages from the unlocked file.`,
      );
    }

    throw new Error(
      `"${sourceFile.name}" could not be read as a PDF. It may be corrupted or not a valid PDF file.`,
    );
  }

  const targetPageCount = targetPdf.getPageCount();

  validateInsertPosition(insertPosition, targetPageCount);

  const selectedSourcePageNumbers = parsePageSelection(
    sourcePageSelection,
    sourcePdf.getPageCount(),
  );

  const resultPdf = await PDFDocument.create();

  const beforeIndices = Array.from(
    { length: insertPosition },
    (_, index) => index,
  );
  const afterIndices = Array.from(
    { length: targetPageCount - insertPosition },
    (_, index) => insertPosition + index,
  );
  const sourceIndices = selectedSourcePageNumbers.map(
    (pageNumber) => pageNumber - 1,
  );

  const beforePages = await resultPdf.copyPages(targetPdf, beforeIndices);
  for (const page of beforePages) {
    resultPdf.addPage(page);
  }

  const insertedPages = await resultPdf.copyPages(sourcePdf, sourceIndices);
  for (const page of insertedPages) {
    resultPdf.addPage(page);
  }

  const afterPages = await resultPdf.copyPages(targetPdf, afterIndices);
  for (const page of afterPages) {
    resultPdf.addPage(page);
  }

  const bytes = await resultPdf.save();

  return {
    bytes,
    targetPageCount,
    insertedPageCount: selectedSourcePageNumbers.length,
    finalPageCount: targetPageCount + selectedSourcePageNumbers.length,
    insertPosition,
    selectedSourcePageNumbers,
    processingTime: performance.now() - startTime,
  };
}
