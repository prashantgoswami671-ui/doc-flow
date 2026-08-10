import { degrees, PDFDocument } from "pdf-lib";

/** Relative, clockwise rotation applied on top of a page's existing /Rotate value. */
export type PageRotation = 0 | 90 | 180 | 270;

/**
 * Editable state for a single page of the uploaded PDF.
 *
 * This is the shared model behind DocFlow's page-management tools: the array
 * order is the current page order, while `sourcePageNumber` keeps pointing at
 * the page in the uploaded document.
 */
export interface ManagedPage {
  /** One-based page number in the uploaded PDF. Stable across edits. */
  sourcePageNumber: number;
  /** Preview image, or null when the preview was skipped. */
  thumbnailDataUrl: string | null;
  selected: boolean;
  deleted: boolean;
  rotation: PageRotation;
}

/** One kept page of the output document, in output order. */
export interface PageOperation {
  sourcePageNumber: number;
  rotation: PageRotation;
}

export interface OrganizeResult {
  bytes: Uint8Array;
  originalPageCount: number;
  deletedPageCount: number;
  rotatedPageCount: number;
  remainingPageCount: number;
  reordered: boolean;
  processingTime: number;
}

export function createManagedPages(
  thumbnails: { pageNumber: number; dataUrl: string | null }[],
): ManagedPage[] {
  return thumbnails.map((thumbnail) => ({
    sourcePageNumber: thumbnail.pageNumber,
    thumbnailDataUrl: thumbnail.dataUrl,
    selected: false,
    deleted: false,
    rotation: 0,
  }));
}

export function normalizeRotation(angle: number): PageRotation {
  const normalized = ((Math.round(angle / 90) * 90) % 360 + 360) % 360;

  return normalized as PageRotation;
}

/** Moves a page to a new position, shifting the pages in between. */
export function movePage(
  pages: ManagedPage[],
  fromIndex: number,
  toIndex: number,
): ManagedPage[] {
  if (
    fromIndex === toIndex ||
    fromIndex < 0 ||
    toIndex < 0 ||
    fromIndex >= pages.length ||
    toIndex >= pages.length
  ) {
    return pages;
  }

  const reordered = [...pages];
  const [moved] = reordered.splice(fromIndex, 1);

  reordered.splice(toIndex, 0, moved);

  return reordered;
}

/** Returns true when the kept pages are no longer in ascending source order. */
export function isReordered(pages: ManagedPage[]): boolean {
  const kept = pages.filter((page) => !page.deleted);

  return kept.some(
    (page, index) =>
      index > 0 && page.sourcePageNumber < kept[index - 1].sourcePageNumber,
  );
}

/** Builds the output page sequence: kept pages, in their current order. */
export function buildPageOperations(pages: ManagedPage[]): PageOperation[] {
  return pages
    .filter((page) => !page.deleted)
    .map((page) => ({
      sourcePageNumber: page.sourcePageNumber,
      rotation: page.rotation,
    }));
}

function validateOperations(
  operations: PageOperation[],
  pageCount: number,
): void {
  if (operations.length === 0) {
    throw new Error("You cannot delete every page. Keep at least one page.");
  }

  const seen = new Set<number>();

  for (const operation of operations) {
    const { sourcePageNumber, rotation } = operation;

    if (!Number.isSafeInteger(sourcePageNumber) || sourcePageNumber < 1) {
      throw new Error(
        `Page ${sourcePageNumber} is invalid. Page numbers start at 1.`,
      );
    }

    if (sourcePageNumber > pageCount) {
      throw new Error(
        `Page ${sourcePageNumber} is outside this PDF's ${pageCount}-page range.`,
      );
    }

    if (seen.has(sourcePageNumber)) {
      throw new Error(`Page ${sourcePageNumber} appears more than once.`);
    }

    if (rotation !== 0 && rotation !== 90 && rotation !== 180 && rotation !== 270) {
      throw new Error("Rotation must be 0, 90, 180, or 270 degrees.");
    }

    seen.add(sourcePageNumber);
  }
}

/**
 * Applies deletions, rotations and reordering to the uploaded PDF in a single
 * pass over one document.
 *
 * Pages that survive are the original page objects, so their content,
 * MediaBox/CropBox and other page-level entries are carried over untouched;
 * only /Rotate is updated, relative to whatever the page already had. The
 * uploaded file is never modified in place.
 */
export async function organizePages(
  file: File,
  operations: PageOperation[],
): Promise<OrganizeResult> {
  const startTime = performance.now();
  const sourceBytes = await file.arrayBuffer();
  const pdf = await PDFDocument.load(sourceBytes);
  const originalPageCount = pdf.getPageCount();

  validateOperations(operations, originalPageCount);

  const sourcePages = pdf.getPages();
  const keptPages = operations.map(
    (operation) => sourcePages[operation.sourcePageNumber - 1],
  );

  for (const operation of operations) {
    if (operation.rotation === 0) continue;

    const page = sourcePages[operation.sourcePageNumber - 1];

    page.setRotation(
      degrees(normalizeRotation(page.getRotation().angle + operation.rotation)),
    );
  }

  const reordered = operations.some(
    (operation, index) =>
      index > 0 &&
      operation.sourcePageNumber < operations[index - 1].sourcePageNumber,
  );
  const isSameOrder =
    !reordered && keptPages.length === originalPageCount;

  if (!isSameOrder) {
    // Detach every page, then re-attach the kept pages in their new order.
    // The page objects themselves are reused, so nothing is re-encoded.
    for (let index = originalPageCount - 1; index >= 0; index--) {
      pdf.removePage(index);
    }

    for (const page of keptPages) {
      pdf.addPage(page);
    }
  }

  const bytes = await pdf.save();

  return {
    bytes,
    originalPageCount,
    deletedPageCount: originalPageCount - operations.length,
    rotatedPageCount: operations.filter((operation) => operation.rotation !== 0)
      .length,
    remainingPageCount: operations.length,
    reordered,
    processingTime: performance.now() - startTime,
  };
}
