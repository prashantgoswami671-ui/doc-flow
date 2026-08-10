import { PDFDocument } from "pdf-lib";

export interface DeletePagesResult {
  bytes: Uint8Array;
  originalPageCount: number;
  deletedPageCount: number;
  remainingPageCount: number;
  deletedPageNumbers: number[];
  processingTime: number;
}

/**
 * Validates a one-based page selection to delete against a page count.
 * Returns the ascending, de-duplicated page numbers to remove.
 */
export function validatePagesToDelete(
  pageNumbers: Iterable<number>,
  pageCount: number,
): number[] {
  if (!Number.isInteger(pageCount) || pageCount < 1) {
    throw new Error("The PDF does not contain any pages to delete.");
  }

  const uniquePages = new Set<number>();

  for (const pageNumber of pageNumbers) {
    if (!Number.isSafeInteger(pageNumber) || pageNumber < 1) {
      throw new Error(`Page ${pageNumber} is invalid. Page numbers start at 1.`);
    }

    if (pageNumber > pageCount) {
      throw new Error(
        `Page ${pageNumber} is outside this PDF's ${pageCount}-page range.`,
      );
    }

    uniquePages.add(pageNumber);
  }

  if (uniquePages.size === 0) {
    throw new Error("Select at least one page to delete.");
  }

  if (uniquePages.size === pageCount) {
    throw new Error("You cannot delete every page. Keep at least one page.");
  }

  return [...uniquePages].sort((first, second) => first - second);
}

/**
 * Removes the selected pages and returns a new PDF with the remaining pages
 * in their original order. The uploaded file is never modified in place.
 */
export async function deletePages(
  file: File,
  pageNumbers: Iterable<number>,
): Promise<DeletePagesResult> {
  const startTime = performance.now();
  const sourceBytes = await file.arrayBuffer();
  const pdf = await PDFDocument.load(sourceBytes);
  const originalPageCount = pdf.getPageCount();
  const deletedPageNumbers = validatePagesToDelete(
    pageNumbers,
    originalPageCount,
  );

  // Remove from the end so earlier indices stay valid.
  for (let index = deletedPageNumbers.length - 1; index >= 0; index--) {
    pdf.removePage(deletedPageNumbers[index] - 1);
  }

  const bytes = await pdf.save();

  return {
    bytes,
    originalPageCount,
    deletedPageCount: deletedPageNumbers.length,
    remainingPageCount: originalPageCount - deletedPageNumbers.length,
    deletedPageNumbers,
    processingTime: performance.now() - startTime,
  };
}
