import { PDFDocument, StandardFonts, degrees, rgb, type PDFFont } from "pdf-lib";
import { parsePageSelection } from "./extract";

/** Positions available for the watermark. Includes "center". */
export type WatermarkPosition =
  | "top-left"
  | "top-center"
  | "top-right"
  | "center"
  | "bottom-left"
  | "bottom-center"
  | "bottom-right";

/** Positions available for page numbers. No "center" — page numbers sit on an edge. */
export type PageNumberPosition =
  | "top-left"
  | "top-center"
  | "top-right"
  | "bottom-left"
  | "bottom-center"
  | "bottom-right";

export type WatermarkRotationDegrees = 0 | 45 | -45;

export type PageNumberFormat =
  /** "1", "2", "3", ... */
  | "number"
  /** "Page 1", "Page 2", ... */
  | "page-number"
  /** "Page 1 of 5", "Page 2 of 5", ... */
  | "page-number-of-total";

export type PageRangeMode = "all" | "selected";

export interface WatermarkRgbColor {
  r: number;
  g: number;
  b: number;
}

export interface WatermarkConfig {
  enabled: boolean;
  text: string;
  position: WatermarkPosition;
  rotation: WatermarkRotationDegrees;
  /** 0.1 to 1.0 (10% to 100%). */
  opacity: number;
  fontSize: number;
  /** Optional override; defaults to black. 0-255 per channel. */
  color?: WatermarkRgbColor;
}

export interface PageNumberConfig {
  enabled: boolean;
  format: PageNumberFormat;
  position: PageNumberPosition;
  startingNumber: number;
  fontSize: number;
  pageRange: PageRangeMode;
  /** Only read when pageRange === "selected". Same syntax as Extract Pages. */
  pageSelection: string;
}

export interface WatermarkPageNumbersResult {
  bytes: Uint8Array;
  pageCount: number;
  watermarkApplied: boolean;
  pageNumbersApplied: boolean;
  numberedPageCount: number;
  processingTime: number;
}

export const WATERMARK_DEFAULTS: WatermarkConfig = {
  enabled: false,
  text: "CONFIDENTIAL",
  position: "center",
  rotation: -45,
  opacity: 0.2,
  fontSize: 48,
};

export const PAGE_NUMBER_DEFAULTS: PageNumberConfig = {
  enabled: false,
  format: "page-number",
  position: "bottom-center",
  startingNumber: 1,
  fontSize: 10,
  pageRange: "all",
  pageSelection: "",
};

export const WATERMARK_MARGIN = 36;
export const PAGE_NUMBER_MARGIN = 28;
const MIN_OPACITY = 0.1;
const MAX_OPACITY = 1;
const MIN_FONT_SIZE = 6;
const MAX_FONT_SIZE = 200;

/** Clamps a computed anchor into the page so text stays on very small pages. */
function clampAnchor(
  value: number,
  textDimension: number,
  pageDimension: number,
): number {
  const max = Math.max(pageDimension - textDimension, 0);

  return Math.min(Math.max(value, 0), max);
}

/**
 * Computes a text draw origin (bottom-left of the unrotated glyph box) for a
 * given position, using this page's own width/height. Every page is measured
 * independently, so mixed-size and mixed-orientation PDFs are each handled
 * on their own terms.
 *
 * Note: this anchor is in the page's own (unrotated) content coordinate
 * space — the same space the page's existing content lives in. If a page
 * carries /Rotate metadata, the overlay rotates together with that existing
 * content when a viewer applies the rotation, rather than being
 * independently re-anchored to the post-rotation visual edges.
 */
export function anchorFor(
  position: WatermarkPosition | PageNumberPosition,
  pageWidth: number,
  pageHeight: number,
  textWidth: number,
  textHeight: number,
  margin: number,
): { x: number; y: number } {
  let x: number;
  let y: number;

  switch (position) {
    case "top-left":
      x = margin;
      y = pageHeight - margin - textHeight;
      break;
    case "top-center":
      x = (pageWidth - textWidth) / 2;
      y = pageHeight - margin - textHeight;
      break;
    case "top-right":
      x = pageWidth - margin - textWidth;
      y = pageHeight - margin - textHeight;
      break;
    case "center":
      x = (pageWidth - textWidth) / 2;
      y = (pageHeight - textHeight) / 2;
      break;
    case "bottom-left":
      x = margin;
      y = margin;
      break;
    case "bottom-center":
      x = (pageWidth - textWidth) / 2;
      y = margin;
      break;
    case "bottom-right":
      x = pageWidth - margin - textWidth;
      y = margin;
      break;
  }

  return {
    x: clampAnchor(x, textWidth, pageWidth),
    y: clampAnchor(y, textHeight, pageHeight),
  };
}

export function formatPageNumber(
  format: PageNumberFormat,
  current: number,
  lastNumber: number,
): string {
  switch (format) {
    case "number":
      return String(current);
    case "page-number":
      return `Page ${current}`;
    case "page-number-of-total":
      return `Page ${current} of ${lastNumber}`;
  }
}

function toColor(color: WatermarkRgbColor | undefined) {
  if (!color) {
    return rgb(0, 0, 0);
  }

  return rgb(
    Math.min(Math.max(color.r, 0), 255) / 255,
    Math.min(Math.max(color.g, 0), 255) / 255,
    Math.min(Math.max(color.b, 0), 255) / 255,
  );
}

function validateWatermarkConfig(watermark: WatermarkConfig): void {
  if (!watermark.enabled) return;

  if (watermark.text.trim() === "") {
    throw new Error("Watermark text cannot be empty.");
  }

  if (
    !Number.isFinite(watermark.opacity) ||
    watermark.opacity < MIN_OPACITY ||
    watermark.opacity > MAX_OPACITY
  ) {
    throw new Error("Watermark opacity must be between 10% and 100%.");
  }

  if (
    !Number.isFinite(watermark.fontSize) ||
    watermark.fontSize < MIN_FONT_SIZE ||
    watermark.fontSize > MAX_FONT_SIZE
  ) {
    throw new Error(
      `Watermark font size must be between ${MIN_FONT_SIZE} and ${MAX_FONT_SIZE}.`,
    );
  }

  if (
    watermark.rotation !== 0 &&
    watermark.rotation !== 45 &&
    watermark.rotation !== -45
  ) {
    throw new Error("Watermark rotation must be 0°, 45°, or -45°.");
  }
}

function validatePageNumberConfig(pageNumbers: PageNumberConfig): void {
  if (!pageNumbers.enabled) return;

  if (
    !Number.isInteger(pageNumbers.startingNumber) ||
    pageNumbers.startingNumber < 1
  ) {
    throw new Error("Starting number must be a whole number of 1 or greater.");
  }

  if (
    !Number.isFinite(pageNumbers.fontSize) ||
    pageNumbers.fontSize < MIN_FONT_SIZE ||
    pageNumbers.fontSize > MAX_FONT_SIZE
  ) {
    throw new Error(
      `Page number font size must be between ${MIN_FONT_SIZE} and ${MAX_FONT_SIZE}.`,
    );
  }

  if (
    pageNumbers.pageRange === "selected" &&
    pageNumbers.pageSelection.trim() === ""
  ) {
    throw new Error(
      "Enter at least one page number or range for the selected pages.",
    );
  }
}

async function loadPdfOrThrow(file: File): Promise<PDFDocument> {
  let bytes: ArrayBuffer;

  try {
    bytes = await file.arrayBuffer();
  } catch {
    throw new Error(`"${file.name}" could not be read.`);
  }

  try {
    return await PDFDocument.load(bytes);
  } catch (loadError) {
    const message = loadError instanceof Error ? loadError.message : "";

    if (/encrypt/i.test(message)) {
      throw new Error(
        `"${file.name}" is password protected. Remove the password before using this tool — DocFlow does not decrypt protected PDFs.`,
      );
    }

    throw new Error(
      `"${file.name}" could not be read as a PDF. It may be corrupted or not a valid PDF file.`,
    );
  }
}

/**
 * Computes the axis-aligned bounding box of a `width` x `height` rectangle
 * (bottom-left corner at the origin) after it is rotated by `angleDegrees`
 * about that same origin.
 *
 * Watermark positioning needs this because `anchorFor()` only knows how to
 * place an axis-aligned box: at 0° the text's own box is already
 * axis-aligned, but at 45°/-45° the *visible* footprint of the rotated
 * glyphs is a different, larger axis-aligned box. Positioning from the
 * unrotated box (the old behavior) anchors the wrong box, so a "Center"
 * watermark visibly drifts off-center once rotated. Positioning from this
 * rotated box keeps every position correct at any supported angle.
 */
export function rotatedBoundingBox(
  width: number,
  height: number,
  angleDegrees: number,
): { minX: number; minY: number; width: number; height: number } {
  if (angleDegrees === 0) {
    return { minX: 0, minY: 0, width, height };
  }

  const angleRadians = (angleDegrees * Math.PI) / 180;
  const cos = Math.cos(angleRadians);
  const sin = Math.sin(angleRadians);
  // Same corner order/handedness as pdf-lib's own text rotation, so this
  // bbox matches what drawText() will actually paint at this angle.
  const corners = [
    { x: 0, y: 0 },
    { x: width, y: 0 },
    { x: 0, y: height },
    { x: width, y: height },
  ];
  const rotatedXs = corners.map((c) => c.x * cos - c.y * sin);
  const rotatedYs = corners.map((c) => c.x * sin + c.y * cos);
  const minX = Math.min(...rotatedXs);
  const maxX = Math.max(...rotatedXs);
  const minY = Math.min(...rotatedYs);
  const maxY = Math.max(...rotatedYs);

  return { minX, minY, width: maxX - minX, height: maxY - minY };
}

function drawWatermarkOnPage(
  page: ReturnType<PDFDocument["getPages"]>[number],
  watermark: WatermarkConfig,
  font: PDFFont,
): void {
  const pageWidth = page.getWidth();
  const pageHeight = page.getHeight();
  const textWidth = font.widthOfTextAtSize(watermark.text, watermark.fontSize);
  const textHeight = font.heightAtSize(watermark.fontSize);

  // Anchor the rotated bbox (identical to the plain text box at 0°), not
  // the raw text box, so "Center"/"Top *"/"Bottom *" all stay correct once
  // rotation is applied.
  const bbox = rotatedBoundingBox(textWidth, textHeight, watermark.rotation);

  const { x: bboxX, y: bboxY } = anchorFor(
    watermark.position,
    pageWidth,
    pageHeight,
    bbox.width,
    bbox.height,
    WATERMARK_MARGIN,
  );

  // anchorFor() returns the bottom-left corner of the *rotated* bbox.
  // Convert that back to the unrotated text origin, since that's the point
  // pdf-lib's `rotate` option actually pivots drawText() around.
  const x = bboxX - bbox.minX;
  const y = bboxY - bbox.minY;

  page.drawText(watermark.text, {
    x,
    y,
    size: watermark.fontSize,
    font,
    color: toColor(watermark.color),
    opacity: watermark.opacity,
    rotate: degrees(watermark.rotation),
  });
}

function drawPageNumberOnPage(
  page: ReturnType<PDFDocument["getPages"]>[number],
  label: string,
  pageNumbers: PageNumberConfig,
  font: PDFFont,
): void {
  const pageWidth = page.getWidth();
  const pageHeight = page.getHeight();
  const textWidth = font.widthOfTextAtSize(label, pageNumbers.fontSize);
  const textHeight = font.heightAtSize(pageNumbers.fontSize);

  const { x, y } = anchorFor(
    pageNumbers.position,
    pageWidth,
    pageHeight,
    textWidth,
    textHeight,
    PAGE_NUMBER_MARGIN,
  );

  page.drawText(label, {
    x,
    y,
    size: pageNumbers.fontSize,
    font,
    color: rgb(0, 0, 0),
  });
}

/**
 * Adds a text watermark and/or page numbers to a PDF, in a single load →
 * modify → save pipeline. The uploaded file is never modified in place, no
 * page is rasterized, page content/rotation/dimensions are left exactly as
 * pdf-lib loaded them, and only one PDFDocument is created and saved.
 */
export async function applyWatermarkAndPageNumbers(
  file: File,
  watermark: WatermarkConfig,
  pageNumbers: PageNumberConfig,
): Promise<WatermarkPageNumbersResult> {
  const startTime = performance.now();

  if (!watermark.enabled && !pageNumbers.enabled) {
    throw new Error(
      "Enable a watermark, page numbers, or both before applying changes.",
    );
  }

  validateWatermarkConfig(watermark);
  validatePageNumberConfig(pageNumbers);

  const pdf = await loadPdfOrThrow(file);
  const pageCount = pdf.getPageCount();
  const pages = pdf.getPages();

  let numberedPageIndexSet: Set<number> | null = null;

  if (pageNumbers.enabled) {
    if (pageNumbers.pageRange === "selected") {
      const selected = parsePageSelection(pageNumbers.pageSelection, pageCount);

      // Numbering always follows the PDF's own page order, regardless of the
      // order the user typed the selection in.
      numberedPageIndexSet = new Set(selected.map((pageNumber) => pageNumber - 1));
    } else {
      numberedPageIndexSet = new Set(pages.map((_, index) => index));
    }
  }

  const totalNumberedPages = numberedPageIndexSet?.size ?? 0;
  const lastPageNumber = pageNumbers.startingNumber + totalNumberedPages - 1;

  const font = await pdf.embedFont(StandardFonts.Helvetica);
  let numberedCount = 0;

  for (let index = 0; index < pages.length; index++) {
    const page = pages[index];

    if (watermark.enabled) {
      drawWatermarkOnPage(page, watermark, font);
    }

    if (pageNumbers.enabled && numberedPageIndexSet?.has(index)) {
      numberedCount += 1;
      const currentNumber = pageNumbers.startingNumber + numberedCount - 1;
      const label = formatPageNumber(
        pageNumbers.format,
        currentNumber,
        lastPageNumber,
      );

      drawPageNumberOnPage(page, label, pageNumbers, font);
    }
  }

  let bytes: Uint8Array;

  try {
    bytes = await pdf.save();
  } catch {
    throw new Error("Failed to save the PDF with the requested changes.");
  }

  return {
    bytes,
    pageCount,
    watermarkApplied: watermark.enabled,
    pageNumbersApplied: pageNumbers.enabled,
    numberedPageCount: numberedCount,
    processingTime: performance.now() - startTime,
  };
}

/** Reads a PDF's page count without modifying it. Mirrors split.ts's helper. */
export async function getWatermarkTargetPageCount(file: File): Promise<number> {
  const pdf = await loadPdfOrThrow(file);

  return pdf.getPageCount();
}
