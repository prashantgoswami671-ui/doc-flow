import { PDFDocument } from "pdf-lib";
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

export interface RepairPdfOptions {
  allowRasterFallback?: boolean;
  forceRasterFallback?: boolean;
}

export interface RepairPdfResult {
  bytes: Uint8Array;
  method: "direct" | "raster-fallback";
  originalSize: number;
  repairedSize: number;
  pageCount: number;
  validation: PdfValidationResult;
}

const VALIDATION_RENDER_SCALE = 0.8;
const MAX_VALIDATION_RENDER_PAGES = 24;
const RASTER_FALLBACK_SETTINGS: RasterSettings = {
  scale: 1.4,
  quality: 0.9,
};

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
    const loaded = await PDFDocument.load(bytes.buffer.slice(0));

    pdfLibLoadable = true;
    pageCount = loaded.getPageCount();
  } catch (error) {
    if (isPasswordError(error)) {
      issues.push({
        severity: "error",
        code: "password-protected",
        message:
          "This PDF is password protected. Unlock it before validation or repair.",
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
  let pdf: { numPages: number; getPage: (pageNumber: number) => Promise<any>; cleanup: () => void } | null = null;

  try {
    pdf = await loadingTask.promise;
    pdfJsLoadable = true;
    pageCount = pageCount ?? pdf.numPages;

    const pagesToRender = Math.min(pdf.numPages, MAX_VALIDATION_RENDER_PAGES);

    for (let pageNumber = 1; pageNumber <= pagesToRender; pageNumber++) {
      const page = await pdf.getPage(pageNumber);
      const canvas = document.createElement("canvas");

      try {
        const viewport = page.getViewport({ scale: VALIDATION_RENDER_SCALE });

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

    if (pdf.numPages > pagesToRender) {
      issues.push({
        severity: "info",
        code: "render-sampled-pages",
        message: `Validated renderability on the first ${pagesToRender} pages to keep memory usage low.`,
      });
    }

    if (renderablePages === 0 && pdf.numPages > 0) {
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
        message:
          "This PDF is password protected. Unlock it before validation or repair.",
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

  const hasError = issues.some((issue) => issue.severity === "error");
  const hasWarning = issues.some((issue) => issue.severity === "warning");

  const status: PdfValidationStatus = !pdfJsLoadable || hasError
    ? "invalid"
    : hasWarning
      ? "repairable"
      : "valid";

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

async function rebuildWithPdfLib(file: File): Promise<Uint8Array> {
  let sourceBytes: ArrayBuffer;

  try {
    sourceBytes = await file.arrayBuffer();
  } catch {
    throw new Error("The uploaded file could not be read.");
  }

  const sourcePdf = await PDFDocument.load(sourceBytes);

  try {
    const rebuiltPdf = await PDFDocument.create();
    const copiedPages = await rebuiltPdf.copyPages(
      sourcePdf,
      sourcePdf.getPageIndices(),
    );

    for (const page of copiedPages) {
      rebuiltPdf.addPage(page);
    }

    return rebuiltPdf.save();
  } catch {
    return sourcePdf.save();
  }
}

async function rebuildWithRasterFallback(file: File): Promise<Uint8Array> {
  try {
    return await rasterizePDFWithSettings(file, RASTER_FALLBACK_SETTINGS, true);
  } catch {
    throw new Error("PDF could not be rendered for raster fallback repair.");
  }
}

export async function repairPdf(
  file: File,
  options: RepairPdfOptions = {},
): Promise<RepairPdfResult> {
  const initialValidation = await validatePdf(file);

  if (
    initialValidation.status === "invalid" ||
    !initialValidation.pdfJsLoadable ||
    initialValidation.renderablePages === 0
  ) {
    throw new Error("Unable to repair this PDF in the browser.");
  }

  const shouldForceRaster = options.forceRasterFallback ?? false;
  let repairedBytes: Uint8Array | null = null;
  let method: RepairPdfResult["method"] = "direct";

  if (!shouldForceRaster && initialValidation.pdfLibLoadable) {
    try {
      repairedBytes = await rebuildWithPdfLib(file);
      method = "direct";
    } catch {
      repairedBytes = null;
    }
  }

  if (!repairedBytes) {
    if (!options.allowRasterFallback) {
      throw new Error(
        "This PDF can only be rebuilt with raster fallback. Text may no longer be selectable.",
      );
    }

    repairedBytes = await rebuildWithRasterFallback(file);
    method = "raster-fallback";
  }

  const repairedFile = new File([repairedBytes], buildRepairedFilename(file.name), {
    type: "application/pdf",
  });
  const repairedValidation = await validatePdf(repairedFile);

  if (
    repairedValidation.status === "invalid" ||
    !repairedValidation.pdfJsLoadable ||
    repairedValidation.renderablePages === 0
  ) {
    throw new Error("Repaired PDF failed verification.");
  }

  return {
    bytes: repairedBytes,
    method,
    originalSize: file.size,
    repairedSize: repairedBytes.length,
    pageCount: repairedValidation.pageCount ?? initialValidation.pageCount ?? 0,
    validation: repairedValidation,
  };
}
