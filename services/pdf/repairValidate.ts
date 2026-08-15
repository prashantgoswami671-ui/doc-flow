import {
  PDFDocument,
  StandardFonts,
  PDFArray,
  PDFCatalog,
  PDFDict,
  PDFName,
  PDFObject,
  PDFPageLeaf,
  PDFPageTree,
  PDFRef,
  PDFStreamWriter,
} from "pdf-lib";
import {
  rasterizePDFWithSettings,
  type RasterSettings,
} from "./rasterize";

export type PdfValidationStatus = "valid" | "repairable" | "invalid";

export interface PdfValidationIssue {
  severity: "info" | "warning" | "error";
  code: string;
  message: string;
}

export interface PdfValidationResult {
  status: PdfValidationStatus;
  pageCount: number | null;
  fileSize: number;
  pdfLibLoadable: boolean;
  pdfJsLoadable: boolean;
  renderablePages: number;
  issues: PdfValidationIssue[];
}

export type RepairMethod =
  | "structural-rebuild"
  | "structural-recovery"
  | "page-tree-reconstruction"
  | "structural-reconstruction"
  | "raster-salvage";

export interface RepairPdfOptions {
  /**
   * Raster salvage rebuilds every page as a flattened image and is lossy
   * (no selectable text, no vectors, no forms/annotations). It is only
   * attempted when every structural strategy fails AND the caller has
   * explicitly opted in.
   */
  allowRasterSalvage?: boolean;
}

/**
 * Diagnostic record specific to the low-level `page-tree-reconstruction`
 * strategy. Populated only on the `StrategyDiagnostics` entry for that
 * strategy; every other strategy leaves `pageTree` as `null`.
 */
export interface PageTreeReconstructionDetails {
  /** Whether `context.enumerateIndirectObjects()` completed without throwing. */
  objectScanSucceeded: boolean;
  /** Total indirect objects found in the source PDF's object graph. */
  indirectObjectsDiscovered: number;
  /** Indirect objects whose /Type is /Page. */
  candidatePageObjectsFound: number;
  /** Whether an existing /Catalog object was found (vs. one being created). */
  catalogFound: boolean;
  /** Whether at least one existing /Pages (page tree) object was found. */
  pagesTreeFound: boolean;
  /** Number of /Page objects actually included in the rebuilt page tree. */
  pagesReconstructed: number;
  /** True only when every reconstructed page's position came from intact, fully-covering page-tree structure. */
  pageOrderConfident: boolean;
  /** Where the final page ordering came from. */
  pageOrderSource: "existing-page-tree" | "object-number-heuristic" | "none";
  /** Pages that already had (or inherited) a usable /MediaBox. */
  mediaBoxRecoveredCount: number;
  /** Pages where no /MediaBox could be found at all, so a standard-size fallback was used. */
  mediaBoxFallbackCount: number;
  /** Pages that already had (or inherited) a /Resources dictionary. */
  resourcesRecoveredCount: number;
  /** Pages where no /Resources could be found, so an empty dictionary was used. */
  resourcesMissingCount: number;
  /** Pages that still reference /Contents (existing content streams, untouched). */
  contentsPresentCount: number;
  /** Pages with no /Contents entry at all (render as blank, but are not dropped). */
  contentsMissingCount: number;
  /** Object numbers of /Page objects whose position had to be inferred from object numbering rather than intact page-tree structure. */
  orphanPageObjectNumbers: number[];
  /** Object numbers of candidate /Page objects that were too damaged to reuse and were excluded. */
  damagedPageObjectNumbers: number[];
}

/**
 * Diagnostic record for a single repair strategy attempt. Populated
 * whether the strategy succeeds or fails, so a failure always ships with
 * an explanation instead of being silently swallowed.
 */
export interface StrategyDiagnostics {
  strategy: RepairMethod;
  attempted: boolean;
  succeeded: boolean;
  /** Was this candidate accepted as lossy (e.g. placeholder pages, rasterized)? */
  lossy: boolean;
  /** pdf-lib's PDFDocument.load() step for this strategy's source read. */
  pdfLibLoad: {
    succeeded: boolean;
    error: string | null;
    /** Page count read directly from pdf-lib, independent of PDF.js. */
    pageCount: number | null;
  };
  /** copyPages() step. Only applicable to strategies that copy pages. */
  copyPages: {
    applicable: boolean;
    succeeded: boolean;
    error: string | null;
    pagesCopied: number;
    /** 1-based page numbers that individually failed to copy (reconstruction only). */
    pagesFailed: number[];
  };
  /** save() step. */
  save: {
    succeeded: boolean;
    error: string | null;
  };
  /** Result of re-validating the saved candidate bytes with PDF.js. */
  postSaveValidation: {
    attempted: boolean;
    pdfJsLoadable: boolean | null;
    pageCount: number | null;
    renderablePages: number | null;
    issues: PdfValidationIssue[];
  };
  /** Human-readable summary of why this strategy did not produce an accepted candidate. */
  failureReason: string | null;
  /** Exact error name + message thrown by this strategy, if any. */
  rawError: string | null;
  /** Populated only for the `page-tree-reconstruction` strategy; `null` for every other strategy. */
  pageTree: PageTreeReconstructionDetails | null;
}

export interface RepairPdfResult {
  bytes: Uint8Array;
  method: RepairMethod;
  /** True when the repair is lossy (raster salvage, or placeholder pages). */
  lossy: boolean;
  originalSize: number;
  repairedSize: number;
  pageCount: number;
  originalPageCount: number | null;
  pagesVerified: number;
  warnings: string[];
  validation: PdfValidationResult;
  /** Per-strategy diagnostics for every strategy that was attempted, in order. */
  diagnostics: StrategyDiagnostics[];
}

/**
 * Thrown when the structural recovery strategies could not produce a valid
 * PDF, but raster salvage (lossy) is available and the caller has not
 * opted in yet via `allowRasterSalvage`. The UI uses this to prompt for
 * explicit confirmation before rebuilding pages as images.
 */
export class RasterSalvageRequiredError extends Error {
  diagnostics: StrategyDiagnostics[];

  constructor(diagnostics: StrategyDiagnostics[] = []) {
    super(
      "This PDF can only be recovered by rebuilding pages as images. Text may no longer be selectable and vector/form/annotation data may be lost.",
    );
    this.name = "RasterSalvageRequiredError";
    this.diagnostics = diagnostics;
  }
}

/** Thrown when no safe repair strategy could produce a valid PDF. */
export class SafeRepairUnavailableError extends Error {
  diagnostics: StrategyDiagnostics[];

  constructor(diagnostics: StrategyDiagnostics[] = []) {
    super(
      "This PDF is too severely damaged for DocFlow's current browser-based recovery methods.",
    );
    this.name = "SafeRepairUnavailableError";
    this.diagnostics = diagnostics;
  }
}

/** Thrown when the source PDF is password protected / encrypted. */
export class PasswordProtectedError extends Error {
  constructor() {
    super("This PDF is password protected. Use Unlock PDF first.");
    this.name = "PasswordProtectedError";
  }
}

const VALIDATION_RENDER_SCALE = 0.8;
const MAX_VALIDATION_RENDER_PAGES = 24;
const RASTER_SALVAGE_SETTINGS: RasterSettings = {
  scale: 1.4,
  quality: 0.9,
};
const FALLBACK_PLACEHOLDER_WIDTH = 612;
const FALLBACK_PLACEHOLDER_HEIGHT = 792;

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getErrorLabel(error: unknown): string {
  const name = error instanceof Error ? error.name : "Error";
  return `${name}: ${getErrorMessage(error)}`;
}

function isPasswordError(error: unknown): boolean {
  const message = getErrorMessage(error);

  return /password|encrypt|needpassword|incorrectpassword/i.test(message);
}

function buildRepairedFilename(name: string): string {
  if (name.toLowerCase().endsWith(".pdf")) {
    return `${name.slice(0, -4)}-repaired.pdf`;
  }

  return `${name}-repaired.pdf`;
}

function emptyDiagnostics(strategy: RepairMethod): StrategyDiagnostics {
  return {
    strategy,
    attempted: false,
    succeeded: false,
    lossy: false,
    pdfLibLoad: { succeeded: false, error: null, pageCount: null },
    copyPages: {
      applicable: false,
      succeeded: false,
      error: null,
      pagesCopied: 0,
      pagesFailed: [],
    },
    save: { succeeded: false, error: null },
    postSaveValidation: {
      attempted: false,
      pdfJsLoadable: null,
      pageCount: null,
      renderablePages: null,
      issues: [],
    },
    failureReason: null,
    rawError: null,
    pageTree: null,
  };
}

async function validatePdfBytes(
  bytes: Uint8Array,
  fileSize: number,
): Promise<PdfValidationResult> {
  const issues: PdfValidationIssue[] = [];
  let pageCount: number | null = null;
  let pdfLibLoadable = false;
  let pdfJsLoadable = false;
  let renderablePages = 0;

  try {
    const loaded = await PDFDocument.load(bytes);

    pdfLibLoadable = true;
    pageCount = loaded.getPageCount();
  } catch (error) {
    if (isPasswordError(error)) {
      issues.push({
        severity: "error",
        code: "password-protected",
        message: "This PDF is password protected. Use Unlock PDF first.",
      });
    } else {
      issues.push({
        severity: "warning",
        code: "pdf-lib-load-failed",
        message:
          "The document could not be fully parsed for structural checks, but rendering may still work.",
      });
    }
  }

  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");

  if (typeof window !== "undefined") {
    pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
      "pdfjs-dist/legacy/build/pdf.worker.min.mjs",
      import.meta.url,
    ).toString();
  }

  const loadingTask = pdfjsLib.getDocument({ data: bytes });
  let pdf: Awaited<typeof loadingTask.promise> | null = null;

  try {
    const loadedPdf = await loadingTask.promise;
    pdf = loadedPdf;
    pdfJsLoadable = true;
    pageCount = pageCount ?? loadedPdf.numPages;

    const pagesToRender = Math.min(
      loadedPdf.numPages,
      MAX_VALIDATION_RENDER_PAGES,
    );

    for (let pageNumber = 1; pageNumber <= pagesToRender; pageNumber++) {
      const page = await loadedPdf.getPage(pageNumber);
      const canvas = document.createElement("canvas");

      try {
        const viewport = page.getViewport({ scale: VALIDATION_RENDER_SCALE });

        if (!(viewport.width > 0) || !(viewport.height > 0)) {
          issues.push({
            severity: "warning",
            code: "invalid-page-dimensions",
            message: `Page ${pageNumber} reported invalid page dimensions.`,
          });
        }

        canvas.width = Math.max(1, Math.ceil(viewport.width));
        canvas.height = Math.max(1, Math.ceil(viewport.height));

        const context = canvas.getContext("2d");

        if (!context) {
          throw new Error("Unable to create canvas rendering context.");
        }

        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, canvas.width, canvas.height);

        await page.render({ canvas, canvasContext: context, viewport }).promise;
        renderablePages += 1;
      } catch {
        issues.push({
          severity: "warning",
          code: "page-render-failed",
          message: `Page ${pageNumber} could not be rendered cleanly.`,
        });
      } finally {
        page.cleanup();
        canvas.width = 0;
        canvas.height = 0;
      }
    }

    if (loadedPdf.numPages > pagesToRender) {
      issues.push({
        severity: "info",
        code: "render-sampled-pages",
        message: `Validated renderability on the first ${pagesToRender} pages to keep memory usage low.`,
      });
    }

    if (renderablePages === 0 && loadedPdf.numPages > 0) {
      issues.push({
        severity: "error",
        code: "pdf-not-renderable",
        message: "This PDF could not be rendered in the browser.",
      });
    }
  } catch (error) {
    if (isPasswordError(error)) {
      issues.push({
        severity: "error",
        code: "password-protected",
        message: "This PDF is password protected. Use Unlock PDF first.",
      });
    } else if (pdfLibLoadable) {
      // pdf-lib could still parse the document's structure even though
      // PDF.js couldn't load/render it. This is exactly the case a repair
      // attempt should be offered for, so this is kept as a (non-blocking)
      // warning rather than a hard error.
      issues.push({
        severity: "warning",
        code: "pdfjs-load-failed-recoverable",
        message:
          "PDF structure can still be read, but page rendering could not be verified. A repair attempt is available.",
      });
    } else {
      issues.push({
        severity: "error",
        code: "pdfjs-load-failed",
        message: "This PDF could not be opened for rendering.",
      });
    }
  } finally {
    if (pdf) {
      pdf.cleanup();
    }
    await loadingTask.destroy();
  }

  if (!pdfLibLoadable && pdfJsLoadable && renderablePages > 0) {
    issues.push({
      severity: "warning",
      code: "repairable-structure-issues",
      message:
        "The PDF can render, but structural issues were detected. Rebuild may help.",
    });
  }

  const isPasswordProtected = issues.some(
    (issue) => issue.code === "password-protected",
  );
  const hasBlockingError = issues.some(
    (issue) =>
      issue.severity === "error" &&
      issue.code !== "pdfjs-load-failed-recoverable",
  );
  const hasWarning = issues.some((issue) => issue.severity === "warning");

  let status: PdfValidationStatus;

  if (isPasswordProtected) {
    status = "invalid";
  } else if (pdfJsLoadable && renderablePages > 0 && !hasBlockingError) {
    status = hasWarning ? "repairable" : "valid";
  } else if (pdfLibLoadable) {
    // pdf-lib can still parse the document even though PDF.js could not
    // load or render it (or rendered zero pages). This must NOT be treated
    // as plain "invalid" — a structural repair attempt is still possible.
    status = "repairable";
  } else {
    status = "invalid";
  }

  return {
    status,
    pageCount,
    fileSize,
    pdfLibLoadable,
    pdfJsLoadable,
    renderablePages,
    issues,
  };
}

export async function validatePdf(file: File): Promise<PdfValidationResult> {
  let bytes: Uint8Array;

  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch {
    throw new Error("The uploaded file could not be read.");
  }

  return validatePdfBytes(bytes, file.size);
}

interface RepairCandidateEvaluation {
  accepted: boolean;
  validation: PdfValidationResult;
  /**
   * Populated whenever the candidate is rejected — always explains *why*,
   * covering the "save() succeeded but PDF.js still rejects it" case
   * explicitly rather than just returning null.
   */
  rejectReason: string | null;
}

/**
 * Validates a repair candidate's bytes and only accepts it as a safe,
 * complete replacement for the original document: no zero-page output, no
 * silently missing pages relative to the original page count, and no
 * PDF.js load failure. Unlike a boolean/null result, this always returns
 * the full validation plus an explicit reject reason so callers can report
 * *why* a candidate that pdf-lib happily wrote was still turned down.
 */
async function evaluateRepairCandidate(
  bytes: Uint8Array,
  originalPageCount: number | null,
): Promise<RepairCandidateEvaluation> {
  const candidateFile = new File([bytes as BlobPart], "candidate.pdf", {
    type: "application/pdf",
  });
  const validation = await validatePdf(candidateFile);

  if (validation.status === "invalid") {
    return {
      accepted: false,
      validation,
      rejectReason:
        "The repaired candidate failed post-repair validation (status: invalid).",
    };
  }
  if (!validation.pdfJsLoadable) {
    return {
      accepted: false,
      validation,
      rejectReason:
        "pdf-lib's save() produced bytes, but PDF.js could not load the resulting PDF.",
    };
  }
  if (!validation.pageCount || validation.pageCount === 0) {
    return {
      accepted: false,
      validation,
      rejectReason: "The repaired candidate reported zero pages.",
    };
  }
  if (
    originalPageCount != null &&
    originalPageCount > 0 &&
    validation.pageCount !== originalPageCount
  ) {
    return {
      accepted: false,
      validation,
      rejectReason: `The repaired candidate has ${validation.pageCount} page(s); the original had ${originalPageCount}. Rejected to avoid silently dropping or adding pages.`,
    };
  }
  if (validation.renderablePages === 0) {
    return {
      accepted: false,
      validation,
      rejectReason:
        "PDF.js loaded the candidate, but zero pages could actually be rendered to a canvas.",
    };
  }

  return { accepted: true, validation, rejectReason: null };
}

/**
 * Internal error used inside strategy implementations to tag exactly which
 * documented pdf-lib step (load / copyPages / save) failed, so the
 * pipeline can build precise diagnostics instead of a single opaque catch.
 */
class StrategyStepError extends Error {
  step: "load" | "copyPages" | "save";

  constructor(step: "load" | "copyPages" | "save", cause: unknown) {
    super(getErrorMessage(cause));
    this.name = cause instanceof Error ? cause.name : "Error";
    this.step = step;
  }
}

/** Best-effort metadata carry-over; any single field that can't be safely read is skipped. */
function copyMetadataBestEffort(
  sourcePdf: PDFDocument,
  destPdf: PDFDocument,
): void {
  try {
    const title = sourcePdf.getTitle();
    if (title) destPdf.setTitle(title);
  } catch {
    /* skip */
  }
  try {
    const author = sourcePdf.getAuthor();
    if (author) destPdf.setAuthor(author);
  } catch {
    /* skip */
  }
  try {
    const subject = sourcePdf.getSubject();
    if (subject) destPdf.setSubject(subject);
  } catch {
    /* skip */
  }
  try {
    const keywords = sourcePdf.getKeywords();
    if (keywords) {
      destPdf.setKeywords(
        keywords.split(/\s+/).filter((keyword) => keyword.length > 0),
      );
    }
  } catch {
    /* skip */
  }
  try {
    const creator = sourcePdf.getCreator();
    if (creator) destPdf.setCreator(creator);
  } catch {
    /* skip */
  }
  try {
    const producer = sourcePdf.getProducer();
    if (producer) destPdf.setProducer(producer);
  } catch {
    /* skip */
  }
  try {
    const creationDate = sourcePdf.getCreationDate();
    if (creationDate) destPdf.setCreationDate(creationDate);
  } catch {
    /* skip */
  }
  try {
    const modificationDate = sourcePdf.getModificationDate();
    if (modificationDate) destPdf.setModificationDate(modificationDate);
  } catch {
    /* skip */
  }
}

interface StrategyRunResult {
  bytes: Uint8Array;
  pageCountFromPdfLib: number;
  pagesCopied: number;
}

/**
 * STRATEGY 1 — Structural rebuild.
 *
 * Parses the source with pdf-lib and copies every page into a brand new
 * PDFDocument, which discards any corrupted xref/trailer data around the
 * original object graph while preserving page content, dimensions, and
 * rotation (all carried over automatically by `copyPages`, since rotation
 * lives on the copied page's own dictionary). Document-level metadata is
 * copied on a best-effort basis.
 *
 * Known limitation (see diagnostics): `copyPages` copies page content
 * streams and resource dictionaries largely as-is. If the corruption lives
 * *inside* a content stream, a stream filter, or a resource dict — rather
 * than in the xref/trailer that a fresh page tree discards — that
 * corruption survives the copy, `save()` still succeeds, and the resulting
 * bytes still fail PDF.js validation. This is the case where pdf-lib
 * parses the source fine but PDF.js still can't render the source *or* the
 * rebuilt candidate.
 */
async function structuralRebuild(file: File): Promise<StrategyRunResult> {
  const sourceBytes = await file.arrayBuffer();

  let sourcePdf: PDFDocument;
  try {
    sourcePdf = await PDFDocument.load(sourceBytes);
  } catch (error) {
    throw new StrategyStepError("load", error);
  }

  const pageCountFromPdfLib = sourcePdf.getPageCount();
  const rebuiltPdf = await PDFDocument.create();

  let copiedPages;
  try {
    copiedPages = await rebuiltPdf.copyPages(
      sourcePdf,
      sourcePdf.getPageIndices(),
    );
  } catch (error) {
    throw new StrategyStepError("copyPages", error);
  }

  for (const page of copiedPages) {
    rebuiltPdf.addPage(page);
  }

  copyMetadataBestEffort(sourcePdf, rebuiltPdf);

  try {
    const bytes = await rebuiltPdf.save();
    return { bytes, pageCountFromPdfLib, pagesCopied: copiedPages.length };
  } catch (error) {
    throw new StrategyStepError("save", error);
  }
}

/**
 * STRATEGY 2 — Structural recovery.
 *
 * Only attempted if strategy 1 fails or is rejected. Uses pdf-lib's
 * documented `capNumbers` load option (clips out-of-range numeric tokens
 * instead of throwing — useful for byte-deletion/truncation-style
 * corruption in the xref/trailer) and re-serializes the ORIGINAL object
 * graph directly via `save()`, without rebuilding a fresh page tree or
 * calling `copyPages`. This targets a different class of damage than
 * strategy 1: corruption in the cross-reference/trailer data that a lenient
 * re-parse can route around, as opposed to corruption inside a page's own
 * content stream (which this strategy does not touch or repair).
 *
 * This does not hand-write any xref/object parsing — it only uses
 * documented `PDFDocument.load` / `PDFDocument.save` capabilities.
 */
async function structuralRecovery(file: File): Promise<StrategyRunResult> {
  const sourceBytes = await file.arrayBuffer();

  let sourcePdf: PDFDocument;
  try {
    sourcePdf = await PDFDocument.load(sourceBytes, {
      capNumbers: true,
      throwOnInvalidObject: false,
    });
  } catch (error) {
    throw new StrategyStepError("load", error);
  }

  const pageCountFromPdfLib = sourcePdf.getPageCount();

  try {
    const bytes = await sourcePdf.save();
    return { bytes, pageCountFromPdfLib, pagesCopied: pageCountFromPdfLib };
  } catch (error) {
    throw new StrategyStepError("save", error);
  }
}

interface ReconstructionRunResult extends StrategyRunResult {
  pagesFailed: number[];
}

/**
 * STRATEGY 3 — Structural reconstruction (page-by-page).
 *
 * Only attempted if strategies 1 and 2 both fail or are rejected. This is
 * the strategy that lets DocFlow safely recover more partially-damaged
 * PDFs than before, without falling straight through to raster salvage.
 *
 * Strategy 1 copies all pages in a single `copyPages` call and fails the
 * *entire* document if any single page's resource graph can't be copied
 * (e.g. one page has a broken content stream or a malformed font/XObject
 * dict). Strategy 3 instead copies pages one at a time from a leniently
 * re-parsed source (same `capNumbers`/`throwOnInvalidObject: false`
 * options as strategy 2). Pages that copy cleanly keep their original
 * vector content, text, and fonts — nothing is rasterized. Only pages that
 * individually fail to copy are replaced with a blank placeholder page
 * (matching the original page size where obtainable) that is visibly
 * labeled "Page N could not be recovered" so the loss is never silent.
 *
 * The candidate is only accepted as non-lossy if every page copied
 * successfully; if any placeholder was used, the result is explicitly
 * marked `lossy: true` with a warning listing the affected pages.
 */
async function structuralReconstruction(
  file: File,
): Promise<ReconstructionRunResult> {
  const sourceBytes = await file.arrayBuffer();

  let sourcePdf: PDFDocument;
  try {
    sourcePdf = await PDFDocument.load(sourceBytes, {
      capNumbers: true,
      throwOnInvalidObject: false,
    });
  } catch (error) {
    throw new StrategyStepError("load", error);
  }

  const pageCountFromPdfLib = sourcePdf.getPageCount();
  const indices = sourcePdf.getPageIndices();
  const rebuiltPdf = await PDFDocument.create();
  const pagesFailed: number[] = [];
  let pagesCopied = 0;
  let placeholderFont: Awaited<
    ReturnType<PDFDocument["embedFont"]>
  > | null = null;

  for (const index of indices) {
    try {
      const [copiedPage] = await rebuiltPdf.copyPages(sourcePdf, [index]);
      rebuiltPdf.addPage(copiedPage);
      pagesCopied += 1;
    } catch {
      // This specific page could not be structurally copied. Replace it
      // with a clearly labeled placeholder rather than dropping the page
      // (which would change the page count) or aborting the whole document.
      pagesFailed.push(index + 1);

      let width = FALLBACK_PLACEHOLDER_WIDTH;
      let height = FALLBACK_PLACEHOLDER_HEIGHT;

      try {
        const originalPage = sourcePdf.getPage(index);
        const size = originalPage.getSize();
        if (size.width > 0 && size.height > 0) {
          width = size.width;
          height = size.height;
        }
      } catch {
        /* fall back to default page size */
      }

      const placeholder = rebuiltPdf.addPage([width, height]);

      try {
        if (!placeholderFont) {
          placeholderFont = await rebuiltPdf.embedFont(
            StandardFonts.Helvetica,
          );
        }
        placeholder.drawText(`Page ${index + 1} could not be recovered`, {
          x: 36,
          y: Math.max(36, height - 72),
          size: 14,
          font: placeholderFont,
        });
      } catch {
        // If even labeling fails, the blank placeholder page still keeps
        // the page count correct; the warning surfaced by the caller
        // still discloses the loss.
      }
    }
  }

  copyMetadataBestEffort(sourcePdf, rebuiltPdf);

  try {
    const bytes = await rebuiltPdf.save();
    return { bytes, pageCountFromPdfLib, pagesCopied, pagesFailed };
  } catch (error) {
    throw new StrategyStepError("save", error);
  }
}

interface PageTreeReconstructionRunResult {
  bytes: Uint8Array;
  pagesReconstructed: number;
  details: PageTreeReconstructionDetails;
}

/**
 * STRATEGY 3 — Low-level page-tree / catalog reconstruction.
 *
 * Only attempted if strategies 1 and 2 both fail or are rejected. Unlike
 * every other structural strategy, this one never calls pdf-lib's
 * high-level `getPageCount()`, `getPages()`, `getPage()`, or `copyPages()`
 * APIs on the source document — those all traverse the page tree starting
 * from `catalog.Pages()`, and when `/Root` is missing/dangling or the
 * `/Catalog`, `/Pages`, or `/Kids` structure is damaged, pdf-lib's
 * `PDFDocument.catalog` is simply `undefined` at runtime (it is assigned
 * once, unchecked, from `context.lookup(context.trailerInfo.Root)` when the
 * document is constructed). Calling any of those APIs against an `undefined`
 * catalog is exactly what produces the
 * `Cannot read properties of undefined (reading 'Pages')` failure this
 * strategy exists to work around.
 *
 * Instead, this strategy works directly against `PDFDocument.context`:
 *  1. Enumerate every indirect object pdf-lib was able to parse
 *     (`context.enumerateIndirectObjects()`), regardless of whether the
 *     trailer's `/Root` resolves. pdf-lib auto-classifies parsed objects by
 *     their `/Type` while parsing, so `/Type /Page` objects are already
 *     `PDFPageLeaf` instances, `/Type /Pages` objects are `PDFPageTree`
 *     instances, and `/Type /Catalog` objects are `PDFCatalog` instances —
 *     scanning for `instanceof` is enough to recover candidates even when
 *     the trailer/xref pointing at them is broken.
 *  2. Determine page order defensively: if exactly one page-tree object is
 *     not itself referenced as another page-tree object's `/Kids` entry, it
 *     is treated as the root and walked (with cycle protection, and without
 *     throwing on a missing/invalid `/Kids` array) to recover reading order.
 *     Any discovered `/Page` objects that walk doesn't reach ("orphans") are
 *     appended afterward in ascending object-number order — pdf-lib assigns
 *     object numbers in the order objects are written, which is the best
 *     remaining structural evidence, but it is a heuristic. If no single
 *     root can be identified at all, every discovered page falls back to
 *     ascending object-number order. Either fallback marks the candidate
 *     `lossy: true` (surfaced as a warning) rather than silently claiming a
 *     fully confident repair.
 *  3. Before reparenting, bake each page's inherited `/MediaBox`, `/CropBox`,
 *     `/Rotate`, and `/Resources` (walked up the page's *original* `/Parent`
 *     chain, with its own bounded, cycle-safe walker — not pdf-lib's
 *     `ascend()`) directly onto the page dictionary, since the page is about
 *     to be reparented under a brand new `/Pages` node that carries none of
 *     that inherited state itself. A standard Letter-size `/MediaBox` is
 *     only used as a last resort when no direct or inherited box exists
 *     anywhere in the chain; `/Resources` falls back to an empty dictionary
 *     in the same circumstance. `/Contents` and the page's actual drawing
 *     content are never touched.
 *  4. Rebuild a brand new, flat `Catalog -> Pages -> Page, Page, ...`
 *     hierarchy: a fresh `/Pages` node is registered and each recovered page
 *     is appended to it via pdf-lib's own `pushLeafNode`/`setParent` (which
 *     keeps `/Count` correct); an existing `/Catalog` object is reused and
 *     repointed at the new `/Pages` node if one was found, otherwise a new
 *     one is created. `context.trailerInfo.Root` is updated to reference it.
 *     Objects that were not reused (old, broken page-tree nodes, etc.) are
 *     left in place, unreferenced — harmless per the PDF spec, and far
 *     safer than trying to guess which objects are safe to delete.
 *  5. Serialize directly via `PDFStreamWriter` (the same writer pdf-lib's
 *     own `PDFDocument.save()` uses by default) against the patched
 *     `context`, bypassing `PDFDocument.save()` entirely — `save()` starts
 *     by calling `this.getPageCount()`, which would immediately hit the same
 *     `undefined` catalog this strategy is built to route around.
 *
 * As with every other strategy, producing bytes is never treated as success
 * on its own: the caller always re-validates the candidate through the same
 * `evaluateRepairCandidate` pipeline (PDF.js load, page count, rendering)
 * before accepting it.
 */
async function pageTreeReconstruction(
  file: File,
): Promise<PageTreeReconstructionRunResult> {
  const sourceBytes = await file.arrayBuffer();

  let sourcePdf: PDFDocument;
  try {
    sourcePdf = await PDFDocument.load(sourceBytes, {
      capNumbers: true,
      throwOnInvalidObject: false,
    });
  } catch (error) {
    throw new StrategyStepError("load", error);
  }

  const context = sourcePdf.context;

  let allObjects: ReturnType<typeof context.enumerateIndirectObjects>;
  try {
    allObjects = context.enumerateIndirectObjects();
  } catch (error) {
    throw new Error(
      `Failed to enumerate the source PDF's indirect objects: ${getErrorMessage(error)}`,
    );
  }

  const pageCandidateRefs: PDFRef[] = [];
  const pageTreeCandidateRefs: PDFRef[] = [];
  let catalogRef: PDFRef | undefined;
  let catalogDict: PDFDict | undefined;

  for (const [ref, obj] of allObjects) {
    if (obj instanceof PDFPageLeaf) {
      pageCandidateRefs.push(ref);
    } else if (obj instanceof PDFPageTree) {
      pageTreeCandidateRefs.push(ref);
    } else if (obj instanceof PDFCatalog && !catalogRef) {
      catalogRef = ref;
      catalogDict = obj;
    }
  }

  if (pageCandidateRefs.length === 0) {
    throw new Error(
      "No recoverable /Page objects were found in the document's object graph.",
    );
  }

  const KidsName = PDFName.of("Kids");

  // --- Determine which page-tree object (if any) is the root ---
  const referencedAsKid = new Set<PDFRef>();
  for (const treeRef of pageTreeCandidateRefs) {
    const tree = context.lookup(treeRef);
    if (!(tree instanceof PDFPageTree)) continue;

    let kidsArray: PDFArray | undefined;
    try {
      kidsArray = tree.lookupMaybe(KidsName, PDFArray);
    } catch {
      kidsArray = undefined;
    }
    if (!kidsArray) continue;

    for (let i = 0; i < kidsArray.size(); i++) {
      let kidObj: ReturnType<PDFArray["get"]> | undefined;
      try {
        kidObj = kidsArray.get(i);
      } catch {
        continue;
      }
      if (kidObj instanceof PDFRef && pageTreeCandidateRefs.includes(kidObj)) {
        referencedAsKid.add(kidObj);
      }
    }
  }
  const rootCandidates = pageTreeCandidateRefs.filter(
    (ref) => !referencedAsKid.has(ref),
  );

  // --- Walk the tree defensively (cycle-safe, never throws on bad /Kids) ---
  const visitedForOrder = new Set<PDFRef>();
  const collectFromTree = (rootRef: PDFRef, order: PDFRef[]): void => {
    if (visitedForOrder.has(rootRef)) return;
    visitedForOrder.add(rootRef);

    const node = context.lookup(rootRef);
    if (node instanceof PDFPageLeaf) {
      order.push(rootRef);
      return;
    }
    if (!(node instanceof PDFPageTree)) return;

    let kidsArray: PDFArray | undefined;
    try {
      kidsArray = node.lookupMaybe(KidsName, PDFArray);
    } catch {
      kidsArray = undefined;
    }
    if (!kidsArray) return;

    for (let i = 0; i < kidsArray.size(); i++) {
      let kidObj: ReturnType<PDFArray["get"]> | undefined;
      try {
        kidObj = kidsArray.get(i);
      } catch {
        continue;
      }
      if (kidObj instanceof PDFRef) {
        collectFromTree(kidObj, order);
      }
    }
  };

  let orderedPageRefs: PDFRef[] = [];
  let orphanRefs: PDFRef[] = [];
  let pageOrderSource: PageTreeReconstructionDetails["pageOrderSource"] =
    "none";
  let pageOrderConfident = false;

  if (rootCandidates.length === 1) {
    const order: PDFRef[] = [];
    collectFromTree(rootCandidates[0], order);
    const recoveredSet = new Set(order);
    const orphans = pageCandidateRefs.filter((ref) => !recoveredSet.has(ref));

    if (order.length > 0 && orphans.length === 0) {
      orderedPageRefs = order;
      pageOrderSource = "existing-page-tree";
      pageOrderConfident = true;
    } else if (order.length > 0) {
      orphanRefs = [...orphans].sort(
        (a, b) => a.objectNumber - b.objectNumber,
      );
      orderedPageRefs = [...order, ...orphanRefs];
      pageOrderSource = "object-number-heuristic";
      pageOrderConfident = false;
    }
  }

  if (orderedPageRefs.length === 0) {
    // No single, fully-covering page tree could be identified. Fall back to
    // ascending object number for every discovered page — the best
    // remaining structural evidence, but a heuristic, not a guarantee.
    orderedPageRefs = [...pageCandidateRefs].sort(
      (a, b) => a.objectNumber - b.objectNumber,
    );
    orphanRefs = orderedPageRefs;
    pageOrderSource = "object-number-heuristic";
    pageOrderConfident = false;
  }

  // --- Bake inherited geometry/resources onto each page before reparenting ---
  const MediaBoxName = PDFName.MediaBox;
  const CropBoxName = PDFName.CropBox;
  const RotateName = PDFName.Rotate;
  const ResourcesName = PDFName.Resources;
  const ContentsName = PDFName.Contents;
  const ParentName = PDFName.Parent;

  const resolveInherited = (page: PDFDict, name: PDFName) => {
    const visited = new Set<PDFDict>();
    let node: PDFDict | undefined = page;
    let hops = 0;
    while (node && !visited.has(node) && hops < 64) {
      visited.add(node);
      const direct = node.get(name);
      if (direct !== undefined) return direct;

      let parentValue;
      try {
        parentValue = node.get(ParentName);
      } catch {
        parentValue = undefined;
      }
      const parentRef: PDFRef | undefined =
        parentValue instanceof PDFRef ? parentValue : undefined;
      const resolvedParent: PDFObject | undefined = parentRef
        ? context.lookup(parentRef)
        : undefined;
      node = resolvedParent instanceof PDFDict ? resolvedParent : undefined;
      hops += 1;
    }
    return undefined;
  };

  let mediaBoxRecoveredCount = 0;
  let mediaBoxFallbackCount = 0;
  let resourcesRecoveredCount = 0;
  let resourcesMissingCount = 0;
  let contentsPresentCount = 0;
  let contentsMissingCount = 0;
  const damagedPageObjectNumbers: number[] = [];
  const pageEntries: { ref: PDFRef; leaf: PDFPageLeaf }[] = [];

  for (const ref of orderedPageRefs) {
    let leaf;
    try {
      leaf = context.lookup(ref);
    } catch {
      damagedPageObjectNumbers.push(ref.objectNumber);
      continue;
    }
    if (!(leaf instanceof PDFPageLeaf)) {
      damagedPageObjectNumbers.push(ref.objectNumber);
      continue;
    }

    try {
      if (leaf.has(MediaBoxName)) {
        mediaBoxRecoveredCount += 1;
      } else {
        const inherited = resolveInherited(leaf, MediaBoxName);
        if (inherited) {
          leaf.set(MediaBoxName, inherited);
          mediaBoxRecoveredCount += 1;
        } else {
          leaf.set(
            MediaBoxName,
            context.obj([
              0,
              0,
              FALLBACK_PLACEHOLDER_WIDTH,
              FALLBACK_PLACEHOLDER_HEIGHT,
            ]),
          );
          mediaBoxFallbackCount += 1;
        }
      }
    } catch {
      damagedPageObjectNumbers.push(ref.objectNumber);
      continue;
    }

    try {
      if (!leaf.has(CropBoxName)) {
        const inherited = resolveInherited(leaf, CropBoxName);
        if (inherited) leaf.set(CropBoxName, inherited);
      }
    } catch {
      /* best effort only — CropBox falls back to MediaBox per the PDF spec */
    }

    try {
      if (!leaf.has(RotateName)) {
        const inherited = resolveInherited(leaf, RotateName);
        if (inherited) leaf.set(RotateName, inherited);
      }
    } catch {
      /* best effort only — Rotate defaults to 0 per the PDF spec */
    }

    try {
      if (leaf.has(ResourcesName)) {
        resourcesRecoveredCount += 1;
      } else {
        const inherited = resolveInherited(leaf, ResourcesName);
        if (inherited) {
          leaf.set(ResourcesName, inherited);
          resourcesRecoveredCount += 1;
        } else {
          leaf.set(ResourcesName, context.obj({}));
          resourcesMissingCount += 1;
        }
      }
    } catch {
      resourcesMissingCount += 1;
    }

    try {
      if (leaf.has(ContentsName)) {
        contentsPresentCount += 1;
      } else {
        contentsMissingCount += 1;
      }
    } catch {
      contentsMissingCount += 1;
    }

    pageEntries.push({ ref, leaf });
  }

  if (pageEntries.length === 0) {
    throw new Error(
      "Every candidate /Page object was too damaged to reuse (missing or unreadable page dictionaries).",
    );
  }

  // --- Rebuild a brand new, flat Catalog -> Pages -> Page hierarchy ---
  const newPagesTree = PDFPageTree.withContext(context);
  const newPagesRef = context.register(newPagesTree);

  for (const { ref, leaf } of pageEntries) {
    newPagesTree.pushLeafNode(ref);
    leaf.setParent(newPagesRef);
  }

  let finalCatalogRef: PDFRef;
  if (catalogDict && catalogRef) {
    catalogDict.set(PDFName.of("Type"), PDFName.of("Catalog"));
    catalogDict.set(PDFName.of("Pages"), newPagesRef);
    finalCatalogRef = catalogRef;
  } else {
    const newCatalog = context.obj({ Type: "Catalog" });
    newCatalog.set(PDFName.of("Pages"), newPagesRef);
    finalCatalogRef = context.register(newCatalog);
  }

  context.trailerInfo.Root = finalCatalogRef;

  let bytes: Uint8Array;
  try {
    bytes = await PDFStreamWriter.forContext(context, 50).serializeToBuffer();
  } catch (error) {
    throw new StrategyStepError("save", error);
  }

  const details: PageTreeReconstructionDetails = {
    objectScanSucceeded: true,
    indirectObjectsDiscovered: allObjects.length,
    candidatePageObjectsFound: pageCandidateRefs.length,
    catalogFound: Boolean(catalogDict),
    pagesTreeFound: pageTreeCandidateRefs.length > 0,
    pagesReconstructed: pageEntries.length,
    pageOrderConfident,
    pageOrderSource,
    mediaBoxRecoveredCount,
    mediaBoxFallbackCount,
    resourcesRecoveredCount,
    resourcesMissingCount,
    contentsPresentCount,
    contentsMissingCount,
    orphanPageObjectNumbers: orphanRefs.map((ref) => ref.objectNumber),
    damagedPageObjectNumbers,
  };

  return { bytes, pagesReconstructed: pageEntries.length, details };
}

/**
 * Runs the `page-tree-reconstruction` strategy and evaluates the resulting
 * candidate through the exact same `evaluateRepairCandidate` pipeline as
 * every other strategy — producing bytes is never treated as success on its
 * own. Always returns a fully populated `StrategyDiagnostics` record, with
 * `pageTree` filled in whenever the object scan itself succeeded (even if
 * the candidate was ultimately rejected), so a failure always ships with an
 * explanation instead of being silently swallowed.
 */
async function runPageTreeReconstruction(
  file: File,
  originalPageCount: number | null,
): Promise<{
  diagnostics: StrategyDiagnostics;
  bytes: Uint8Array | null;
  accepted: boolean;
}> {
  const diagnostics = emptyDiagnostics("page-tree-reconstruction");
  diagnostics.attempted = true;
  diagnostics.copyPages.applicable = false;

  let runResult: PageTreeReconstructionRunResult;
  try {
    runResult = await pageTreeReconstruction(file);
  } catch (error) {
    diagnostics.rawError = getErrorLabel(error);

    if (error instanceof StrategyStepError && error.step === "load") {
      diagnostics.pdfLibLoad = {
        succeeded: false,
        error: error.message,
        pageCount: null,
      };
      diagnostics.failureReason = `PDFDocument.load() failed: ${error.message}`;
    } else if (error instanceof StrategyStepError && error.step === "save") {
      diagnostics.pdfLibLoad.succeeded = true;
      diagnostics.save = { succeeded: false, error: error.message };
      diagnostics.failureReason = `Serialization failed: ${error.message}`;
    } else {
      // Load succeeded; the failure happened during object-graph scanning
      // or reconstruction (e.g. no recoverable /Page objects at all).
      diagnostics.pdfLibLoad.succeeded = true;
      diagnostics.failureReason = getErrorMessage(error);
    }

    return { diagnostics, bytes: null, accepted: false };
  }

  diagnostics.pdfLibLoad = {
    succeeded: true,
    error: null,
    pageCount: runResult.pagesReconstructed,
  };
  diagnostics.pageTree = runResult.details;
  diagnostics.save = { succeeded: true, error: null };

  const evaluation = await evaluateRepairCandidate(
    runResult.bytes,
    originalPageCount,
  );

  diagnostics.postSaveValidation = {
    attempted: true,
    pdfJsLoadable: evaluation.validation.pdfJsLoadable,
    pageCount: evaluation.validation.pageCount,
    renderablePages: evaluation.validation.renderablePages,
    issues: evaluation.validation.issues,
  };

  if (!evaluation.accepted) {
    diagnostics.failureReason = evaluation.rejectReason;
    return { diagnostics, bytes: null, accepted: false };
  }

  diagnostics.succeeded = true;
  diagnostics.lossy =
    !runResult.details.pageOrderConfident ||
    runResult.details.mediaBoxFallbackCount > 0 ||
    runResult.details.damagedPageObjectNumbers.length > 0;

  return { diagnostics, bytes: runResult.bytes, accepted: true };
}

/**
 * STRATEGY 4 — Raster salvage (lossy).
 *
 * Only used when PDF.js can actually render the source, and only when the
 * caller explicitly opts in. Reuses the existing rasterization pipeline
 * (`rasterizePDFWithSettings`), which already processes pages sequentially
 * and releases page/canvas/loading-task resources in `finally` blocks.
 * This remains the last resort, never the default.
 */
async function rasterSalvage(file: File): Promise<Uint8Array> {
  try {
    return await rasterizePDFWithSettings(file, RASTER_SALVAGE_SETTINGS, true);
  } catch (error) {
    throw new StrategyStepError("save", error);
  }
}

export type RepairStage =
  | "preparing"
  | "structural-rebuild"
  | "structural-recovery"
  | "page-tree-reconstruction"
  | "structural-reconstruction"
  | "raster-salvage"
  | "validating";

/**
 * Runs one of the pdf-lib-based strategies (rebuild / recovery /
 * reconstruction), evaluates the resulting candidate, and always returns a
 * fully populated `StrategyDiagnostics` record — whether the strategy
 * succeeded, was rejected after a successful save, or threw at a specific
 * documented pdf-lib step.
 */
async function runStructuralStrategy(
  strategy: Exclude<RepairMethod, "raster-salvage">,
  run: () => Promise<StrategyRunResult | ReconstructionRunResult>,
  originalPageCount: number | null,
): Promise<{
  diagnostics: StrategyDiagnostics;
  bytes: Uint8Array | null;
  accepted: boolean;
  pagesFailed: number[];
}> {
  const diagnostics = emptyDiagnostics(strategy);
  diagnostics.attempted = true;
  diagnostics.copyPages.applicable = strategy !== "structural-recovery";

  let runResult: StrategyRunResult | ReconstructionRunResult;

  try {
    runResult = await run();
  } catch (error) {
    diagnostics.rawError = getErrorLabel(error);

    if (error instanceof StrategyStepError) {
      if (error.step === "load") {
        diagnostics.pdfLibLoad = {
          succeeded: false,
          error: error.message,
          pageCount: null,
        };
        diagnostics.failureReason = `PDFDocument.load() failed: ${error.message}`;
      } else if (error.step === "copyPages") {
        diagnostics.pdfLibLoad.succeeded = true;
        diagnostics.copyPages.succeeded = false;
        diagnostics.copyPages.error = error.message;
        diagnostics.failureReason = `copyPages() failed: ${error.message}`;
      } else {
        diagnostics.pdfLibLoad.succeeded = true;
        if (diagnostics.copyPages.applicable) diagnostics.copyPages.succeeded = true;
        diagnostics.save = { succeeded: false, error: error.message };
        diagnostics.failureReason = `save() failed: ${error.message}`;
      }
    } else {
      diagnostics.failureReason = getErrorMessage(error);
    }

    return { diagnostics, bytes: null, accepted: false, pagesFailed: [] };
  }

  diagnostics.pdfLibLoad = {
    succeeded: true,
    error: null,
    pageCount: runResult.pageCountFromPdfLib,
  };
  if (diagnostics.copyPages.applicable) {
    diagnostics.copyPages.succeeded = true;
    diagnostics.copyPages.pagesCopied = runResult.pagesCopied;
    diagnostics.copyPages.pagesFailed =
      "pagesFailed" in runResult ? runResult.pagesFailed : [];
  }
  diagnostics.save = { succeeded: true, error: null };

  const evaluation = await evaluateRepairCandidate(
    runResult.bytes,
    originalPageCount,
  );

  diagnostics.postSaveValidation = {
    attempted: true,
    pdfJsLoadable: evaluation.validation.pdfJsLoadable,
    pageCount: evaluation.validation.pageCount,
    renderablePages: evaluation.validation.renderablePages,
    issues: evaluation.validation.issues,
  };

  const pagesFailed =
    "pagesFailed" in runResult ? runResult.pagesFailed : [];

  if (!evaluation.accepted) {
    diagnostics.failureReason = evaluation.rejectReason;
    return { diagnostics, bytes: null, accepted: false, pagesFailed };
  }

  diagnostics.succeeded = true;
  diagnostics.lossy = pagesFailed.length > 0;

  return { diagnostics, bytes: runResult.bytes, accepted: true, pagesFailed };
}

/**
 * Attempts to repair a PDF using an ordered, multi-strategy recovery
 * pipeline, from least to most invasive:
 *
 *   1. Structural rebuild        — pdf-lib parse + copy all pages at once
 *                                   into a fresh PDF (fastest, cleanest).
 *   2. Structural recovery       — lenient pdf-lib re-parse (capNumbers) +
 *                                   direct re-save of the original object
 *                                   graph; targets xref/trailer corruption.
 *   3. Structural reconstruction — page-by-page copy from a lenient
 *                                   re-parse; pages that individually fail
 *                                   to copy get a clearly labeled blank
 *                                   placeholder instead of failing the
 *                                   whole document. Non-lossy unless a
 *                                   placeholder was actually used.
 *   4. Page-tree reconstruction  — low-level catalog/page-tree rebuild
 *                                   via direct object-graph surgery; bypasses
 *                                   pdf-lib's high-level page APIs when the
 *                                   catalog or page tree is damaged.
 *   5. Raster salvage            — only if PDF.js can render the source;
 *                                   LOSSY; requires explicit opt-in via
 *                                   `options.allowRasterSalvage`. Never the
 *                                   default and never chosen silently.
 *
 * Every candidate produced by any strategy is revalidated (pdf-lib load,
 * PDF.js load, page count, page rendering) before being declared a
 * success. pdf-lib's `save()` succeeding is never, by itself, treated as
 * "repaired" — a repaired PDF must actually load and render in PDF.js.
 *
 * Every attempted strategy — including ones that fail — contributes a
 * `StrategyDiagnostics` entry to the result (on success) or to the thrown
 * error (on failure), so failures are never silent.
 */
export async function repairPdf(
  file: File,
  options: RepairPdfOptions = {},
  onProgress?: (stage: RepairStage) => void,
): Promise<RepairPdfResult> {
  onProgress?.("preparing");

  const initialValidation = await validatePdf(file);

  if (
    initialValidation.issues.some(
      (issue) => issue.code === "password-protected",
    )
  ) {
    throw new PasswordProtectedError();
  }

  if (!initialValidation.pdfLibLoadable && !initialValidation.pdfJsLoadable) {
    throw new SafeRepairUnavailableError([]);
  }

  const originalPageCount = initialValidation.pageCount;
  const warnings: string[] = [];
  const diagnostics: StrategyDiagnostics[] = [];

  const finalize = (
    bytes: Uint8Array,
    method: RepairMethod,
    lossy: boolean,
    validation: PdfValidationResult,
  ): RepairPdfResult => ({
    bytes,
    method,
    lossy,
    originalSize: file.size,
    repairedSize: bytes.length,
    pageCount: validation.pageCount ?? originalPageCount ?? 0,
    originalPageCount,
    pagesVerified: validation.renderablePages,
    warnings,
    validation,
    diagnostics,
  });

  if (initialValidation.pdfLibLoadable) {
    // --- Strategy 1: structural rebuild ---
    onProgress?.("structural-rebuild");
    const rebuildAttempt = await runStructuralStrategy(
      "structural-rebuild",
      structuralRebuild.bind(null, file),
      originalPageCount,
    );
    diagnostics.push(rebuildAttempt.diagnostics);

    if (rebuildAttempt.accepted && rebuildAttempt.bytes) {
      return finalize(
        rebuildAttempt.bytes,
        "structural-rebuild",
        false,
        {
          status: rebuildAttempt.diagnostics.postSaveValidation
            .pdfJsLoadable
            ? "valid"
            : "repairable",
          pageCount: rebuildAttempt.diagnostics.postSaveValidation.pageCount,
          fileSize: rebuildAttempt.bytes.length,
          pdfLibLoadable: true,
          pdfJsLoadable: true,
          renderablePages:
            rebuildAttempt.diagnostics.postSaveValidation.renderablePages ??
            0,
          issues: rebuildAttempt.diagnostics.postSaveValidation.issues,
        },
      );
    }

    // --- Strategy 2: structural recovery ---
    onProgress?.("structural-recovery");
    const recoveryAttempt = await runStructuralStrategy(
      "structural-recovery",
      structuralRecovery.bind(null, file),
      originalPageCount,
    );
    diagnostics.push(recoveryAttempt.diagnostics);

    if (recoveryAttempt.accepted && recoveryAttempt.bytes) {
      return finalize(recoveryAttempt.bytes, "structural-recovery", false, {
        status: "repairable",
        pageCount: recoveryAttempt.diagnostics.postSaveValidation.pageCount,
        fileSize: recoveryAttempt.bytes.length,
        pdfLibLoadable: true,
        pdfJsLoadable: true,
        renderablePages:
          recoveryAttempt.diagnostics.postSaveValidation.renderablePages ??
          0,
        issues: recoveryAttempt.diagnostics.postSaveValidation.issues,
      });
    }

    // --- Strategy 3: structural reconstruction (page-by-page) ---
    onProgress?.("structural-reconstruction");
    const reconstructionAttempt = await runStructuralStrategy(
      "structural-reconstruction",
      structuralReconstruction.bind(null, file),
      originalPageCount,
    );
    diagnostics.push(reconstructionAttempt.diagnostics);

    if (reconstructionAttempt.accepted && reconstructionAttempt.bytes) {
      const lossy = reconstructionAttempt.pagesFailed.length > 0;

      if (lossy) {
        warnings.push(
          `Page(s) ${reconstructionAttempt.pagesFailed.join(", ")} could not be structurally recovered and were replaced with labeled blank placeholder pages. All other pages retain their original text and vector content.`,
        );
      }

      return finalize(
        reconstructionAttempt.bytes,
        "structural-reconstruction",
        lossy,
        {
          status: "repairable",
          pageCount:
            reconstructionAttempt.diagnostics.postSaveValidation.pageCount,
          fileSize: reconstructionAttempt.bytes.length,
          pdfLibLoadable: true,
          pdfJsLoadable: true,
          renderablePages:
            reconstructionAttempt.diagnostics.postSaveValidation
              .renderablePages ?? 0,
          issues:
            reconstructionAttempt.diagnostics.postSaveValidation.issues,
        },
      );
    }
  }

  // --- Strategy 4: page-tree / catalog reconstruction (low-level) ---
  onProgress?.("page-tree-reconstruction");
  const pageTreeAttempt = await runPageTreeReconstruction(
    file,
    originalPageCount,
  );
  diagnostics.push(pageTreeAttempt.diagnostics);

  if (pageTreeAttempt.accepted && pageTreeAttempt.bytes) {
    const pageTreeDetails = pageTreeAttempt.diagnostics.pageTree;

    if (pageTreeAttempt.diagnostics.lossy && pageTreeDetails) {
      if (!pageTreeDetails.pageOrderConfident) {
        warnings.push(
          "Page order was inferred from object numbering rather than intact page-tree structure; verify reading order after repair.",
        );
      }
      if (pageTreeDetails.mediaBoxFallbackCount > 0) {
        warnings.push(
          `${pageTreeDetails.mediaBoxFallbackCount} page(s) had no recoverable /MediaBox and were assigned a standard placeholder size.`,
        );
      }
      if (pageTreeDetails.damagedPageObjectNumbers.length > 0) {
        warnings.push(
          `${pageTreeDetails.damagedPageObjectNumbers.length} damaged page object(s) could not be included in the rebuild.`,
        );
      }
    }

    return finalize(
      pageTreeAttempt.bytes,
      "page-tree-reconstruction",
      pageTreeAttempt.diagnostics.lossy,
      {
        status: "repairable",
        pageCount: pageTreeAttempt.diagnostics.postSaveValidation.pageCount,
        fileSize: pageTreeAttempt.bytes.length,
        pdfLibLoadable: true,
        pdfJsLoadable: true,
        renderablePages:
          pageTreeAttempt.diagnostics.postSaveValidation.renderablePages ?? 0,
        issues: pageTreeAttempt.diagnostics.postSaveValidation.issues,
      },
    );
  }

  // --- Strategy 5: raster salvage (lossy, opt-in) ---
  const canAttemptRasterSalvage =
    initialValidation.pdfJsLoadable && initialValidation.renderablePages > 0;

  if (canAttemptRasterSalvage) {
    if (!options.allowRasterSalvage) {
      throw new RasterSalvageRequiredError(diagnostics);
    }

    onProgress?.("raster-salvage");
    const rasterDiagnostics = emptyDiagnostics("raster-salvage");
    rasterDiagnostics.attempted = true;

    let bytes: Uint8Array;
    try {
      bytes = await rasterSalvage(file);
      rasterDiagnostics.save = { succeeded: true, error: null };
    } catch (error) {
      rasterDiagnostics.rawError = getErrorLabel(error);
      rasterDiagnostics.save = {
        succeeded: false,
        error: getErrorMessage(error),
      };
      rasterDiagnostics.failureReason = `Raster salvage failed: ${getErrorMessage(error)}`;
      diagnostics.push(rasterDiagnostics);
      throw new SafeRepairUnavailableError(diagnostics);
    }

    onProgress?.("validating");
    const evaluation = await evaluateRepairCandidate(bytes, originalPageCount);
    rasterDiagnostics.postSaveValidation = {
      attempted: true,
      pdfJsLoadable: evaluation.validation.pdfJsLoadable,
      pageCount: evaluation.validation.pageCount,
      renderablePages: evaluation.validation.renderablePages,
      issues: evaluation.validation.issues,
    };

    if (!evaluation.accepted) {
      rasterDiagnostics.failureReason = evaluation.rejectReason;
      diagnostics.push(rasterDiagnostics);
      throw new SafeRepairUnavailableError(diagnostics);
    }

    rasterDiagnostics.succeeded = true;
    rasterDiagnostics.lossy = true;
    diagnostics.push(rasterDiagnostics);

    warnings.push(
      "Pages were rebuilt as images. Text may no longer be selectable and vector/form/annotation data may be lost.",
    );

    return finalize(bytes, "raster-salvage", true, evaluation.validation);
  }

  // --- Strategy 6: failure ---
  throw new SafeRepairUnavailableError(diagnostics);
}

export function getRepairedFilename(originalName: string): string {
  return buildRepairedFilename(originalName);
}
