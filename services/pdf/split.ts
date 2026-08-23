import { PDFDocument } from "pdf-lib";

/** One output range, in one-based page numbers, inclusive on both ends. */
export interface SplitRange {
  partNumber: number;
  startPage: number;
  endPage: number;
  pageCount: number;
}

export interface SplitPart {
  range: SplitRange;
  bytes: Uint8Array;
}

export interface SplitResult {
  parts: SplitPart[];
  sourcePageCount: number;
  processingTime: number;
}

/**
 * Loads a PDF via pdf-lib, translating an encrypted source into a clear,
 * actionable message instead of pdf-lib's generic load error. Mirrors the
 * encryption-detection pattern already used by compress.ts / protect.ts /
 * unlock.ts / repairValidate.ts.
 */
async function loadSplitSourceOrThrow(file: File): Promise<PDFDocument> {
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
        `"${file.name}" is password protected. Use Unlock PDF first, then split the unlocked file.`,
      );
    }

    throw new Error(
      `"${file.name}" could not be read as a PDF. It may be corrupted or not a valid PDF file.`,
    );
  }
}

/** Reads the page count of a PDF without modifying it. */
export async function getPdfPageCount(file: File): Promise<number> {
  const pdf = await loadSplitSourceOrThrow(file);

  return pdf.getPageCount();
}

/**
 * Parses and validates raw split-point input (e.g. "20, 50, 75") against a
 * known page count.
 *
 * Split points are boundary pages: a document divides after each split
 * point. Points must be integers strictly between 1 and pageCount - 1
 * (inclusive), so every resulting range has at least one page. Duplicates
 * are rejected and the result is returned sorted ascending.
 */
export function parseSplitPoints(input: string, pageCount: number): number[] {
  if (!Number.isInteger(pageCount) || pageCount < 1) {
    throw new Error("The PDF does not contain any pages to split.");
  }

  if (pageCount < 2) {
    throw new Error("A single-page PDF cannot be split.");
  }

  const trimmed = input.trim();

  if (trimmed === "") {
    throw new Error("Enter at least one split point.");
  }

  const points: number[] = [];
  const seen = new Set<number>();

  for (const rawEntry of trimmed.split(",")) {
    const entry = rawEntry.trim();

    if (entry === "") {
      throw new Error("Split points cannot be empty.");
    }

    if (!/^\d+$/.test(entry)) {
      throw new Error(`"${entry}" is not a valid whole page number.`);
    }

    const point = Number(entry);

    if (!Number.isSafeInteger(point) || point < 1 || point >= pageCount) {
      throw new Error(
        `Split point ${point} must be between 1 and ${pageCount - 1} for this ${pageCount}-page PDF.`,
      );
    }

    if (seen.has(point)) {
      throw new Error(`Split point ${point} was entered more than once.`);
    }

    seen.add(point);
    points.push(point);
  }

  return points.sort((a, b) => a - b);
}

/** Turns sorted, validated split points into contiguous, gap-free ranges. */
export function buildRanges(
  splitPoints: number[],
  pageCount: number,
): SplitRange[] {
  const boundaries = [0, ...splitPoints, pageCount];
  const ranges: SplitRange[] = [];

  for (let index = 0; index < boundaries.length - 1; index++) {
    const startPage = boundaries[index] + 1;
    const endPage = boundaries[index + 1];

    ranges.push({
      partNumber: index + 1,
      startPage,
      endPage,
      pageCount: endPage - startPage + 1,
    });
  }

  return ranges;
}

/**
 * Splits a PDF into multiple PDFs at the given split points.
 *
 * Each output PDF is built with pdf-lib's `copyPages`, the same approach
 * `extractPages` uses, so page dimensions, rotation metadata and content
 * carry over as far as pdf-lib permits. The source file is never modified,
 * and pages are never rasterized.
 */
export async function splitPdf(
  file: File,
  splitPoints: number[],
): Promise<SplitResult> {
  const startTime = performance.now();
  const sourcePdf = await loadSplitSourceOrThrow(file);
  const sourcePageCount = sourcePdf.getPageCount();

  // Re-validate against the actual loaded document, in case the caller's
  // page count (e.g. from an earlier, stale read) no longer matches.
  for (const point of splitPoints) {
    if (point < 1 || point >= sourcePageCount) {
      throw new Error(
        `Split point ${point} is outside this PDF's ${sourcePageCount}-page range.`,
      );
    }
  }

  const ranges = buildRanges(splitPoints, sourcePageCount);
  const parts: SplitPart[] = [];

  for (const range of ranges) {
    const partPdf = await PDFDocument.create();
    const pageIndices = Array.from(
      { length: range.pageCount },
      (_, offset) => range.startPage - 1 + offset,
    );
    const copiedPages = await partPdf.copyPages(sourcePdf, pageIndices);

    for (const page of copiedPages) {
      partPdf.addPage(page);
    }

    parts.push({ range, bytes: await partPdf.save() });
  }

  return {
    parts,
    sourcePageCount,
    processingTime: performance.now() - startTime,
  };
}
