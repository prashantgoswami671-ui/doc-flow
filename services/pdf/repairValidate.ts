import { PDFDocument } from "pdf-lib";
import { rasterizePDFWithSettings } from "./rasterize";

/**
 * Validation result for a PDF document.
 * Reports capabilities of each supported library.
 */
export interface PdfValidationResult {
  /** Whether pdf-lib can load the document */
  pdfLibCanLoad: boolean;
  /** Whether PDF.js can render the document */
  pdfJsCanRender: boolean;
  /** Page count if successfully loaded */
  pageCount: number | null;
  /** Error message from pdf-lib if load failed */
  pdfLibError: string | null;
  /** Error message from PDF.js if render failed */
  pdfJsError: string | null;
  /** Whether the PDF is password protected */
  isPasswordProtected: boolean;
}

/**
 * Strategy result after each repair attempt.
 */
export interface RepairStrategyResult {
  /** Which strategy was attempted */
  strategy:
    | "structural-rebuild"
    | "structural-recovery"
    | "raster-salvage"
    | "none";
  /** Whether the repair succeeded */
  success: boolean;
  /** Repaired PDF bytes, if successful */
  repairedBytes?: Uint8Array;
  /** Page count of repaired PDF, if successful */
  repairedPageCount?: number;
  /** Original page count from source */
  originalPageCount: number;
  /** Pages that were recovered (if partial) */
  recoveredPageCount?: number;
  /** Pages that failed to recover (if partial) */
  failedPageNumbers?: number[];
  /** Error message if repair failed */
  error?: string;
  /** Warning about lossy operations */
  warning?: string;
}

/**
 * Complete repair result with validation and strategy information.
 */
export interface PdfRepairResult {
  /** Overall success */
  success: boolean;
  /** Which repair strategy succeeded (or "none" if all failed) */
  repairMethod:
    | "structural-rebuild"
    | "structural-recovery"
    | "raster-salvage"
    | "partial-recovery"
    | "none";
  /** Repaired PDF bytes, if successful */
  repairedBytes?: Uint8Array;
  /** Original page count */
  originalPageCount: number;
  /** Page count after repair, if successful */
  repairedPageCount?: number;
  /** Pages recovered in partial repairs */
  recoveredPageCount?: number;
  /** Pages that could not be recovered */
  failedPageNumbers?: number[];
  /** Validation result before repair */
  validationResult: PdfValidationResult;
  /** Validation result after repair (if successful) */
  postRepairValidation?: PdfValidationResult;
  /** Warnings to show the user */
  warnings: string[];
  /** Error message if all strategies failed */
  error?: string;
  /** Processing time in milliseconds */
  processingTime: number;
}

/**
 * Validates a PDF by testing both pdf-lib and PDF.js capabilities.
 * Does NOT attempt to parse low-level PDF syntax.
 * Returns what each library can and cannot do with the input.
 */
export async function validatePdf(file: File): Promise<PdfValidationResult> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let pdfLibCanLoad = false;
  let pdfLibError: string | null = null;
  let pageCount: number | null = null;
  let isPasswordProtected = false;

  // Test pdf-lib
  try {
    const pdf = await PDFDocument.load(bytes, { ignoreEncryption: true });
    pdfLibCanLoad = true;
    pageCount = pdf.getPageCount();
  } catch (err) {
    pdfLibCanLoad = false;
    pdfLibError = err instanceof Error ? err.message : String(err);

    // Check if it's a password protection error
    if (/encrypt/i.test(pdfLibError)) {
      isPasswordProtected = true;
    }
  }

  // Test PDF.js rendering capability
  let pdfJsCanRender = false;
  let pdfJsError: string | null = null;

  try {
    const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");

    if (typeof window !== "undefined") {
      pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
        "pdfjs-dist/legacy/build/pdf.worker.min.mjs",
        import.meta.url,
      ).toString();
    }

    const loadingTask = pdfjsLib.getDocument({ data: bytes });
    const pdf = await loadingTask.promise;

    // Try to get first page to verify rendering works
    if (pdf.numPages > 0) {
      const page = await pdf.getPage(1);
      const viewport = page.getViewport({ scale: 1 });
      // If viewport is valid, rendering should work
      if (viewport && viewport.width > 0 && viewport.height > 0) {
        pdfJsCanRender = true;
      }
    }

    pdf.cleanup();
    await loadingTask.destroy();
  } catch (err) {
    pdfJsCanRender = false;
    pdfJsError = err instanceof Error ? err.message : String(err);
  }

  return {
    pdfLibCanLoad,
    pdfJsCanRender,
    pageCount,
    pdfLibError,
    pdfJsError,
    isPasswordProtected,
  };
}

/**
 * STRATEGY 1: Structural Rebuild
 * If pdf-lib can load the PDF, rebuild it page-by-page into a fresh document.
 */
async function attemptStructuralRebuild(
  file: File,
  originalPageCount: number,
): Promise<RepairStrategyResult> {
  const bytes = new Uint8Array(await file.arrayBuffer());

  try {
    const sourcePdf = await PDFDocument.load(bytes, { ignoreEncryption: true });
    const sourcePageCount = sourcePdf.getPageCount();

    if (sourcePageCount === 0) {
      return {
        strategy: "structural-rebuild",
        success: false,
        originalPageCount,
        error: "Source PDF has no pages.",
      };
    }

    // Create fresh output PDF
    const outputPdf = await PDFDocument.create();
    const sourcePages = sourcePdf.getPages();

    // Copy each page safely
    for (const sourcePage of sourcePages) {
      try {
        const [copiedPage] = await outputPdf.copyPages(sourcePdf, [
          sourcePages.indexOf(sourcePage),
        ]);
        outputPdf.addPage(copiedPage);
      } catch (pageErr) {
        // If any page fails, abort structural rebuild
        return {
          strategy: "structural-rebuild",
          success: false,
          originalPageCount,
          error: `Failed to copy page: ${pageErr instanceof Error ? pageErr.message : String(pageErr)}`,
        };
      }
    }

    const repairedBytes = await outputPdf.save();

    return {
      strategy: "structural-rebuild",
      success: true,
      repairedBytes,
      repairedPageCount: sourcePageCount,
      originalPageCount,
    };
  } catch (err) {
    return {
      strategy: "structural-rebuild",
      success: false,
      originalPageCount,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * STRATEGY 2: Raster Salvage
 * If PDF.js can render the document, rebuild it as JPEG-rasterized pages.
 * This is lossy but may save documents that structural methods cannot.
 */
async function attemptRasterSalvage(
  file: File,
  originalPageCount: number,
): Promise<RepairStrategyResult> {
  try {
    const repairedBytes = await rasterizePDFWithSettings(
      file,
      { scale: 1.5, quality: 0.85 },
      true, // releaseResources
    );

    // Validate that rasterized output can be loaded
    const validation = await validatePdf(
      new File([repairedBytes], "repaired.pdf", { type: "application/pdf" }),
    );

    if (!validation.pdfLibCanLoad || !validation.pageCount) {
      return {
        strategy: "raster-salvage",
        success: false,
        originalPageCount,
        error:
          "Rasterized output failed validation. Could not verify repaired pages.",
      };
    }

    return {
      strategy: "raster-salvage",
      success: true,
      repairedBytes,
      repairedPageCount: validation.pageCount,
      originalPageCount,
      warning:
        "Pages were rebuilt as images. Text may no longer be selectable and vector/form/annotation data was lost.",
    };
  } catch (err) {
    return {
      strategy: "raster-salvage",
      success: false,
      originalPageCount,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Main repair orchestration: attempts strategies in order until one succeeds.
 * Strategy order:
 * 1. Structural rebuild (preferred, lossless)
 * 2. Raster salvage (fallback, lossy)
 */
export async function repairPdf(
  file: File,
  validation: PdfValidationResult,
): Promise<PdfRepairResult> {
  const startTime = performance.now();
  const warnings: string[] = [];

  // Determine original page count
  let originalPageCount = validation.pageCount ?? 0;

  // If we couldn't determine page count, we can't proceed
  if (originalPageCount === 0) {
    if (validation.isPasswordProtected) {
      return {
        success: false,
        repairMethod: "none",
        originalPageCount,
        validationResult: validation,
        warnings: [
          "This PDF is password protected. Use Unlock PDF first before attempting repair.",
        ],
        error:
          "Password-protected PDFs must be unlocked before repair attempts.",
        processingTime: performance.now() - startTime,
      };
    }

    return {
      success: false,
      repairMethod: "none",
      originalPageCount,
      validationResult: validation,
      warnings,
      error: "Unable to determine PDF structure. Repair cannot proceed.",
      processingTime: performance.now() - startTime,
    };
  }

  // Healthy PDF check: if both libraries work, don't repair
  if (validation.pdfLibCanLoad && validation.pdfJsCanRender) {
    return {
      success: false,
      repairMethod: "none",
      originalPageCount,
      validationResult: validation,
      warnings,
      error:
        "This PDF is healthy and does not require repair. Both pdf-lib and PDF.js can process it successfully.",
      processingTime: performance.now() - startTime,
    };
  }

  // STRATEGY 1: Structural Rebuild
  if (validation.pdfLibCanLoad) {
    const result = await attemptStructuralRebuild(file, originalPageCount);

    if (result.success && result.repairedBytes) {
      // Post-repair validation
      const postValidation = await validatePdf(
        new File([result.repairedBytes], "repaired.pdf", {
          type: "application/pdf",
        }),
      );

      if (!postValidation.pdfLibCanLoad) {
        warnings.push(
          "Post-repair validation warning: pdf-lib cannot re-load the repaired output.",
        );
      }
      if (!postValidation.pdfJsCanRender) {
        warnings.push(
          "Post-repair validation warning: PDF.js cannot render the repaired output.",
        );
      }

      return {
        success: true,
        repairMethod: "structural-rebuild",
        repairedBytes: result.repairedBytes,
        originalPageCount,
        repairedPageCount: result.repairedPageCount,
        validationResult: validation,
        postRepairValidation: postValidation,
        warnings,
        processingTime: performance.now() - startTime,
      };
    }

    // Structural rebuild failed, log the error for debugging
    warnings.push(`Structural rebuild failed: ${result.error || "unknown error"}`);
  } else {
    warnings.push(
      "PDF structure cannot be read with pdf-lib. Skipping structural rebuild.",
    );
  }

  // STRATEGY 2: Raster Salvage (only if PDF.js can render)
  if (validation.pdfJsCanRender) {
    const result = await attemptRasterSalvage(file, originalPageCount);

    if (result.success && result.repairedBytes) {
      // Post-repair validation
      const postValidation = await validatePdf(
        new File([result.repairedBytes], "repaired.pdf", {
          type: "application/pdf",
        }),
      );

      if (!postValidation.pdfLibCanLoad) {
        warnings.push(
          "Post-repair validation warning: pdf-lib cannot re-load the rasterized output.",
        );
      }

      return {
        success: true,
        repairMethod: "raster-salvage",
        repairedBytes: result.repairedBytes,
        originalPageCount,
        repairedPageCount: result.repairedPageCount,
        validationResult: validation,
        postRepairValidation: postValidation,
        warnings: [...warnings, result.warning || ""].filter(Boolean),
        processingTime: performance.now() - startTime,
      };
    }

    // Raster salvage also failed
    warnings.push(`Raster salvage failed: ${result.error || "unknown error"}`);
  } else {
    warnings.push("PDF.js cannot render this document. Raster salvage not possible.");
  }

  // All strategies failed
  return {
    success: false,
    repairMethod: "none",
    originalPageCount,
    validationResult: validation,
    warnings,
    error:
      "This PDF is too severely damaged for DocFlow's browser-based recovery methods. No safe repair strategy could succeed.",
    processingTime: performance.now() - startTime,
  };
}

/**
 * Orchestrator: validate, then repair if needed.
 * Returns comprehensive result with validation and repair information.
 */
export async function validateAndRepairPdf(
  file: File,
): Promise<PdfRepairResult> {
  const validation = await validatePdf(file);
  const repairResult = await repairPdf(file, validation);
  return repairResult;
}
