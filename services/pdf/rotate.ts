import { degrees, PDFDocument } from "pdf-lib";

export type RotationDegrees = 90 | 180 | 270;

export interface RotationResult {
  bytes: Uint8Array;
  pageCount: number;
  requestedRotation: RotationDegrees;
  processingTime: number;
}

export interface PageRotationCorrection {
  pageNumber: number;
  rotation: RotationDegrees;
}

export interface PageRotationResult {
  bytes: Uint8Array;
  pageCount: number;
  appliedCorrections: PageRotationCorrection[];
  processingTime: number;
}

function isSupportedRotation(value: number): value is RotationDegrees {
  return value === 90 || value === 180 || value === 270;
}

function normalizeRotation(angle: number): number {
  return ((angle % 360) + 360) % 360;
}

/**
 * Loads a PDF via pdf-lib, translating an encrypted source into a clear,
 * actionable message instead of pdf-lib's generic load error. Mirrors the
 * encryption-detection pattern already used by compress.ts / protect.ts /
 * unlock.ts / repairValidate.ts.
 */
async function loadRotateSourceOrThrow(file: File): Promise<PDFDocument> {
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
        `"${file.name}" is password protected. Use Unlock PDF first, then rotate the unlocked file.`,
      );
    }

    throw new Error(
      `"${file.name}" could not be read as a PDF. It may be corrupted or not a valid PDF file.`,
    );
  }
}

function applyRelativeRotation(
  page: { getRotation: () => { angle: number }; setRotation: (rotation: ReturnType<typeof degrees>) => void },
  requestedRotation: RotationDegrees,
): void {
  const existingRotation = page.getRotation().angle;
  const nextRotation = normalizeRotation(existingRotation + requestedRotation);

  page.setRotation(degrees(nextRotation));
}

/**
 * Applies rotations only to explicitly confirmed one-based page numbers.
 * It mutates page rotation metadata without rasterizing, resizing, or copying pages.
 */
export async function applyPageRotations(
  file: File,
  corrections: PageRotationCorrection[],
): Promise<PageRotationResult> {
  if (corrections.length === 0) {
    throw new Error("Select at least one detected page to fix.");
  }

  const startTime = performance.now();
  const pdfDocument = await loadRotateSourceOrThrow(file);
  const pages = pdfDocument.getPages();
  const correctedPages = new Set<number>();

  for (const correction of corrections) {
    if (!Number.isInteger(correction.pageNumber)) {
      throw new Error("Each selected page must have a valid page number.");
    }

    if (!isSupportedRotation(correction.rotation)) {
      throw new Error("Rotation must be 90, 180, or 270 degrees.");
    }

    if (correction.pageNumber < 1 || correction.pageNumber > pages.length) {
      throw new Error(
        `Page ${correction.pageNumber} is outside this PDF's page range.`,
      );
    }

    if (correctedPages.has(correction.pageNumber)) {
      throw new Error(`Page ${correction.pageNumber} was selected more than once.`);
    }

    correctedPages.add(correction.pageNumber);
    applyRelativeRotation(pages[correction.pageNumber - 1], correction.rotation);
  }

  const bytes = await pdfDocument.save();

  return {
    bytes,
    pageCount: pages.length,
    appliedCorrections: corrections,
    processingTime: performance.now() - startTime,
  };
}

/**
 * Applies a clockwise rotation to every page without rasterizing, resizing,
 * redrawing, or copying page content.
 */
export async function rotatePDF(
  file: File,
  requestedRotation: RotationDegrees,
): Promise<RotationResult> {
  if (!isSupportedRotation(requestedRotation)) {
    throw new Error("Rotation must be 90, 180, or 270 degrees.");
  }

  const startTime = performance.now();
  const pdfDocument = await loadRotateSourceOrThrow(file);
  const pages = pdfDocument.getPages();

  for (const page of pages) {
    applyRelativeRotation(page, requestedRotation);
  }

  const bytes = await pdfDocument.save();

  return {
    bytes,
    pageCount: pages.length,
    requestedRotation,
    processingTime: performance.now() - startTime,
  };
}
