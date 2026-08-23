import { PDFDocument } from "pdf-lib";

export interface ExtractionResult {
  bytes: Uint8Array;
  sourcePageCount: number;
  extractedPageCount: number;
  selectedPageNumbers: number[];
  processingTime: number;
}

/**
 * Parses a one-based page selection such as "1-3, 5, 8-10".
 * The selection order is retained so the generated PDF follows the user's input.
 */
export function parsePageSelection(
  input: string,
  pageCount: number,
): number[] {
  if (!Number.isInteger(pageCount) || pageCount < 1) {
    throw new Error("The PDF does not contain any pages to extract.");
  }

  if (input.trim() === "") {
    throw new Error("Enter at least one page number or page range.");
  }

  const pageNumbers: number[] = [];
  const selectedPages = new Set<number>();
  const entries = input.split(",");

  for (const entry of entries) {
    const selection = entry.trim();

    if (selection === "") {
      throw new Error("Page selections cannot be empty.");
    }

    const singlePageMatch = /^(\d+)$/.exec(selection);
    const rangeMatch = /^(\d+)\s*-\s*(\d+)$/.exec(selection);
    let pagesToAdd: number[];

    if (singlePageMatch) {
      pagesToAdd = [Number(singlePageMatch[1])];
    } else if (rangeMatch) {
      const start = Number(rangeMatch[1]);
      const end = Number(rangeMatch[2]);

      if (!Number.isSafeInteger(start) || start < 1) {
        throw new Error(`Page ${start} is invalid. Page numbers start at 1.`);
      }

      if (!Number.isSafeInteger(end) || end < 1) {
        throw new Error(`Page ${end} is invalid. Page numbers start at 1.`);
      }

      if (start > end) {
        throw new Error(`Page range \"${selection}\" is reversed.`);
      }

      if (end > pageCount) {
        throw new Error(
          `Page ${end} is outside this PDF's ${pageCount}-page range.`,
        );
      }

      pagesToAdd = Array.from(
        { length: end - start + 1 },
        (_, index) => start + index,
      );
    } else {
      throw new Error(
        `\"${selection}\" is not a valid page number or range. Use values like 1-3, 5, 8-10.`,
      );
    }

    for (const pageNumber of pagesToAdd) {
      if (!Number.isSafeInteger(pageNumber) || pageNumber < 1) {
        throw new Error(`Page ${pageNumber} is invalid. Page numbers start at 1.`);
      }

      if (pageNumber > pageCount) {
        throw new Error(
          `Page ${pageNumber} is outside this PDF's ${pageCount}-page range.`,
        );
      }

      if (selectedPages.has(pageNumber)) {
        throw new Error(`Page ${pageNumber} is selected more than once.`);
      }

      selectedPages.add(pageNumber);
      pageNumbers.push(pageNumber);
    }
  }

  return pageNumbers;
}

/**
 * Loads a PDF via pdf-lib, translating an encrypted source into a clear,
 * actionable message instead of pdf-lib's generic load error. Mirrors the
 * encryption-detection pattern already used by compress.ts / protect.ts /
 * unlock.ts / repairValidate.ts.
 */
async function loadExtractSourceOrThrow(file: File): Promise<PDFDocument> {
  let sourceBytes: ArrayBuffer;

  try {
    sourceBytes = await file.arrayBuffer();
  } catch {
    throw new Error(`"${file.name}" could not be read.`);
  }

  try {
    return await PDFDocument.load(sourceBytes);
  } catch (loadError) {
    const message = loadError instanceof Error ? loadError.message : "";

    if (/encrypt/i.test(message)) {
      throw new Error(
        `"${file.name}" is password protected. Use Unlock PDF first, then extract pages from the unlocked file.`,
      );
    }

    throw new Error(
      `"${file.name}" could not be read as a PDF. It may be corrupted or not a valid PDF file.`,
    );
  }
}

/** Extracts selected pages without rasterizing or changing their page content. */
export async function extractPages(
  file: File,
  pageSelection: string,
): Promise<ExtractionResult> {
  const startTime = performance.now();
  const sourcePdf = await loadExtractSourceOrThrow(file);
  const sourcePageCount = sourcePdf.getPageCount();
  const selectedPageNumbers = parsePageSelection(pageSelection, sourcePageCount);

  const extractedPdf = await PDFDocument.create();
  const copiedPages = await extractedPdf.copyPages(
    sourcePdf,
    selectedPageNumbers.map((pageNumber) => pageNumber - 1),
  );

  for (const page of copiedPages) {
    extractedPdf.addPage(page);
  }

  const bytes = await extractedPdf.save();

  return {
    bytes,
    sourcePageCount,
    extractedPageCount: selectedPageNumbers.length,
    selectedPageNumbers,
    processingTime: performance.now() - startTime,
  };
}
