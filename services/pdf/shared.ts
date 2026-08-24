import { PDFDocument } from "pdf-lib";

/**
 * Shared, service-agnostic helpers for working around a specific class of
 * PDF corruption: PDFs (most commonly ones carrying C2PA/Content
 * Credentials, or otherwise incrementally updated) whose object graph
 * contains multiple *generations* of the same indirect object number
 * (e.g. both `1 0 R` and `1 1 R`). pdf-lib's `load() -> mutate -> save()`
 * path can preserve both generations internally, which can produce output
 * whose `/Root` reference no longer resolves cleanly for strict PDF
 * parsers (e.g. qpdf, pikepdf), even though lenient reloads via pdf-lib or
 * PDF.js may still appear to "work".
 *
 * These helpers are intentionally narrow:
 *  - `detectDuplicateGenerationObjects` only flags the specific condition
 *    "same object number + different generation numbers" -- it does not
 *    treat every indirect object, or every duplicate reference, as
 *    suspicious.
 *  - `rebuildPdfWithFreshPageTree` only performs the documented,
 *    independently-verified `PDFDocument.create()` + `copyPages()` escape
 *    hatch. It intentionally does NOT copy document-level structures like
 *    /AF, /Names/EmbeddedFiles, Content Credentials/C2PA, /Outlines,
 *    /PageLabels, named destinations, document-level JS/actions, or
 *    AcroForm document-level structures -- callers must only use this for
 *    page-level operations (rotate/organize/delete-pages) where that
 *    trade-off is acceptable, never unconditionally for every PDF.
 */

export interface DuplicateGenerationResult {
  /** True when at least one object number has more than one distinct generation number. */
  hasDuplicateGenerations: boolean;
  /** Object numbers that have more than one generation present, ascending. */
  affectedObjectNumbers: number[];
}

/**
 * Enumerates a loaded PDFDocument's indirect objects and detects when the
 * same object number exists with more than one distinct generation number
 * (e.g. `1 0 R` and `1 1 R` both present). This is the specific corruption
 * signature seen with some incrementally-updated PDFs (notably ones with
 * C2PA/Content Credentials added via incremental update), not a general
 * "is this PDF weird" check.
 *
 * Pure/read-only: does not mutate `pdfDocument` in any way.
 */
export function detectDuplicateGenerationObjects(
  pdfDocument: PDFDocument,
): DuplicateGenerationResult {
  const generationsByObjectNumber = new Map<number, Set<number>>();

  for (const [ref] of pdfDocument.context.enumerateIndirectObjects()) {
    let generations = generationsByObjectNumber.get(ref.objectNumber);

    if (!generations) {
      generations = new Set<number>();
      generationsByObjectNumber.set(ref.objectNumber, generations);
    }

    generations.add(ref.generationNumber);
  }

  const affectedObjectNumbers: number[] = [];

  for (const [objectNumber, generations] of generationsByObjectNumber) {
    if (generations.size > 1) {
      affectedObjectNumbers.push(objectNumber);
    }
  }

  affectedObjectNumbers.sort((first, second) => first - second);

  return {
    hasDuplicateGenerations: affectedObjectNumbers.length > 0,
    affectedObjectNumbers,
  };
}

/**
 * Escapes a corrupted/duplicate-generation object graph for page-level
 * operations by rebuilding a fresh document and copying every page across
 * via pdf-lib's own `copyPages`, exactly as independently verified:
 *
 *   const outputPdf = await PDFDocument.create();
 *   const pages = await outputPdf.copyPages(sourcePdf, sourcePdf.getPageIndices());
 *   for (const page of pages) outputPdf.addPage(page);
 *
 * The returned document contains only the copied pages, in their original
 * order -- callers should perform any page-level mutations (rotation,
 * reordering, deletion, cropping) directly on the pages of the *returned*
 * document, then save from it.
 *
 * This intentionally does NOT carry over document-level structures such as
 * /AF, /Names/EmbeddedFiles, Content Credentials/C2PA, /Outlines,
 * /PageLabels, named destinations, document-level JavaScript/actions, or
 * document-level AcroForm structures. Callers must only reach for this on
 * services whose primary mutation is page-level, where that loss is an
 * accepted, deliberate trade-off for producing a strictly valid PDF -- not
 * as a default/blanket rebuild path for every PDF.
 */
export async function rebuildPdfWithFreshPageTree(
  sourcePdf: PDFDocument,
): Promise<PDFDocument> {
  const outputPdf = await PDFDocument.create();
  const copiedPages = await outputPdf.copyPages(
    sourcePdf,
    sourcePdf.getPageIndices(),
  );

  for (const page of copiedPages) {
    outputPdf.addPage(page);
  }

  return outputPdf;
}

export interface PageLevelWorkingDocument {
  /** The document to perform page-level mutations on, then save(). */
  pdfDocument: PDFDocument;
  /** True when `pdfDocument` is a fresh rebuild rather than the original loaded document. */
  rebuilt: boolean;
  /** Populated (non-empty) only when `rebuilt` is true. */
  affectedObjectNumbers: number[];
}

/**
 * Decides, for a page-level service (rotate/organize/delete-pages), which
 * document a caller should mutate: the original loaded `sourcePdf` for the
 * normal, fast/direct path, or a fresh `copyPages()` rebuild when
 * `sourcePdf` has duplicate-generation objects. Normal, single-generation
 * PDFs are returned unchanged (`rebuilt: false`) so their existing
 * behavior and document fidelity is entirely unaffected by this helper.
 */
export async function getPageLevelWorkingDocument(
  sourcePdf: PDFDocument,
): Promise<PageLevelWorkingDocument> {
  const detection = detectDuplicateGenerationObjects(sourcePdf);

  if (!detection.hasDuplicateGenerations) {
    return { pdfDocument: sourcePdf, rebuilt: false, affectedObjectNumbers: [] };
  }

  const pdfDocument = await rebuildPdfWithFreshPageTree(sourcePdf);

  return {
    pdfDocument,
    rebuilt: true,
    affectedObjectNumbers: detection.affectedObjectNumbers,
  };
}
