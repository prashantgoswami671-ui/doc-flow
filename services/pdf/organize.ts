import { degrees, PDFDocument } from "pdf-lib";
import type { PageBox } from "./thumbnails";

/** Relative, clockwise rotation applied on top of a page's existing /Rotate value. */
export type PageRotation = 0 | 90 | 180 | 270;

/**
 * A crop rectangle in the PDF's own default user-space coordinate system:
 * origin at the page's lower-left corner, x increasing right, y increasing
 * up, units in points. `x`/`y` are absolute (they already include a page's
 * existing CropBox offset, if any) so this can be passed directly to
 * pdf-lib's `page.setCropBox(x, y, width, height)`.
 */
export interface PageCrop {
  x: number;
  y: number;
  width: number;
  height: number;
}

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
  /** Pending crop for this page, or undefined when the page isn't cropped. */
  crop?: PageCrop;
}

/** One kept page of the output document, in output order. */
export interface PageOperation {
  sourcePageNumber: number;
  rotation: PageRotation;
  crop?: PageCrop;
}

export interface OrganizeResult {
  bytes: Uint8Array;
  originalPageCount: number;
  deletedPageCount: number;
  rotatedPageCount: number;
  croppedPageCount: number;
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
      crop: page.crop,
    }));
}

// ---------------------------------------------------------------------------
// Crop coordinate conversion
//
// The crop editor draws over an UNROTATED render of a page (see
// `renderCropEditorPreview` in services/pdf/thumbnails.ts), in ordinary
// screen/canvas pixel space: origin top-left, x right, y down. A page's
// PDF coordinate space (and its CropBox) uses origin bottom-left, x right,
// y up, in points. These helpers make that conversion explicit in both
// directions, using the page's actual current box (`PageBox`, from
// pdf-lib's CropBox/MediaBox) and the actual render scale (pixels per
// point) — never a guessed or assumed factor.
//
// Because the render is always unrotated, these conversions are the same
// regardless of what rotation (if any) the user has additionally applied
// for display — rotation only affects how the rectangle is drawn on
// screen (a CSS transform applied by the caller), never how it is stored
// or applied to the PDF. This is also how the PDF spec itself treats
// CropBox vs. /Rotate: CropBox is always defined in the page's default,
// unrotated user space, and /Rotate is applied on top for display/print.
// ---------------------------------------------------------------------------

export interface PixelRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Converts a crop rectangle from unrotated render-pixel space into PDF point space. */
export function pixelCropToPdfCrop(
  pixelRect: PixelRect,
  renderScale: number,
  pageBox: PageBox,
): PageCrop {
  const width = pixelRect.width / renderScale;
  const height = pixelRect.height / renderScale;
  const x = pageBox.x + pixelRect.x / renderScale;
  // Flip Y: pixel y grows downward from the top; PDF y grows upward from the bottom.
  const y = pageBox.y + (pageBox.height - pixelRect.y / renderScale - height);

  return { x, y, width, height };
}

/** Converts a crop rectangle from PDF point space back into unrotated render-pixel space. */
export function pdfCropToPixelCrop(
  crop: PageCrop,
  renderScale: number,
  pageBox: PageBox,
): PixelRect {
  const width = crop.width * renderScale;
  const height = crop.height * renderScale;
  const x = (crop.x - pageBox.x) * renderScale;
  const y = (pageBox.height - (crop.y - pageBox.y) - crop.height) * renderScale;

  return { x, y, width, height };
}

/** Clamps a crop rectangle so it stays fully inside the page's current box. */
export function clampCropToPageBox(crop: PageCrop, pageBox: PageBox): PageCrop {
  const width = Math.min(Math.max(crop.width, 0), pageBox.width);
  const height = Math.min(Math.max(crop.height, 0), pageBox.height);
  const x = Math.min(
    Math.max(crop.x, pageBox.x),
    pageBox.x + pageBox.width - width,
  );
  const y = Math.min(
    Math.max(crop.y, pageBox.y),
    pageBox.y + pageBox.height - height,
  );

  return { x, y, width, height };
}

/** Expresses a crop rectangle as fractions (0–1) of its page box, for reuse on other pages. */
export interface RelativeCrop {
  xFrac: number;
  yFrac: number;
  widthFrac: number;
  heightFrac: number;
}

export function relativeCropFromPageBox(
  crop: PageCrop,
  pageBox: PageBox,
): RelativeCrop {
  return {
    xFrac: (crop.x - pageBox.x) / pageBox.width,
    yFrac: (crop.y - pageBox.y) / pageBox.height,
    widthFrac: crop.width / pageBox.width,
    heightFrac: crop.height / pageBox.height,
  };
}

/** Reconstructs an absolute crop rectangle for a (possibly different) page from relative fractions. */
export function cropFromRelative(
  relative: RelativeCrop,
  pageBox: PageBox,
): PageCrop {
  return clampCropToPageBox(
    {
      x: pageBox.x + relative.xFrac * pageBox.width,
      y: pageBox.y + relative.yFrac * pageBox.height,
      width: relative.widthFrac * pageBox.width,
      height: relative.heightFrac * pageBox.height,
    },
    pageBox,
  );
}

/**
 * Maps a normalized pointer position from DISPLAY space (i.e. the page as
 * currently shown on screen, including any additional rotation applied via
 * CSS transform) back to normalized coordinates in the page's own unrotated
 * render space. `nx`/`ny` are each in [0, 1], measured against the element's
 * on-screen (post-transform) bounding box.
 *
 * Rotation here is intentionally just the display-only rotation (source
 * PDF's /Rotate plus the user's chosen delta) — it never touches the stored
 * crop, only how a pointer position over the rotated preview is interpreted.
 */
export function displayNormalizedToNative(
  nx: number,
  ny: number,
  rotation: PageRotation,
): { ux: number; uy: number } {
  switch (rotation) {
    case 90:
      return { ux: ny, uy: 1 - nx };
    case 180:
      return { ux: 1 - nx, uy: 1 - ny };
    case 270:
      return { ux: 1 - ny, uy: nx };
    case 0:
    default:
      return { ux: nx, uy: ny };
  }
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

    if (operation.crop) {
      const { width, height } = operation.crop;

      if (!(width > 0) || !(height > 0)) {
        throw new Error(
          `The crop for page ${sourcePageNumber} must have a positive width and height.`,
        );
      }
    }

    seen.add(sourcePageNumber);
  }
}

/**
 * Loads a PDF via pdf-lib, translating an encrypted source into a clear,
 * actionable message instead of pdf-lib's generic load error. Mirrors the
 * encryption-detection pattern already used by compress.ts / protect.ts /
 * unlock.ts / repairValidate.ts.
 */
async function loadOrganizeSourceOrThrow(file: File): Promise<PDFDocument> {
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
        `"${file.name}" is password protected. Use Unlock PDF first, then organize the unlocked file.`,
      );
    }

    throw new Error(
      `"${file.name}" could not be read as a PDF. It may be corrupted or not a valid PDF file.`,
    );
  }
}

/**
 * Probes a file with pdf-lib before pdf.js ever touches it for page
 * previews. Organize's preview step (`renderPageThumbnails`, PDF.js-based)
 * runs before any call to `organizePages` below, so without this check an
 * encrypted PDF would surface PDF.js's opaque password error at the
 * preview stage instead of a clear, actionable one.
 */
export async function assertOrganizablePdf(file: File): Promise<void> {
  await loadOrganizeSourceOrThrow(file);
}

/**
 * Applies deletions, rotations, crops, and reordering to the uploaded PDF in
 * a single pass over one document.
 *
 * Pages that survive are the original page objects, so their content is
 * carried over untouched; only /Rotate and, when a crop is requested, the
 * CropBox are updated. Cropping only adjusts CropBox — it never rasterizes,
 * resizes, or redraws page content, so the underlying vectors/text/links are
 * preserved and the crop remains fully reversible. The uploaded file is
 * never modified in place.
 */
export async function organizePages(
  file: File,
  operations: PageOperation[],
): Promise<OrganizeResult> {
  const startTime = performance.now();
  const pdf = await loadOrganizeSourceOrThrow(file);
  const originalPageCount = pdf.getPageCount();

  validateOperations(operations, originalPageCount);

  const sourcePages = pdf.getPages();
  const keptPages = operations.map(
    (operation) => sourcePages[operation.sourcePageNumber - 1],
  );

  for (const operation of operations) {
    const page = sourcePages[operation.sourcePageNumber - 1];

    if (operation.rotation !== 0) {
      page.setRotation(
        degrees(normalizeRotation(page.getRotation().angle + operation.rotation)),
      );
    }

    if (operation.crop) {
      const currentBox = page.getCropBox();
      const clamped = clampCropToPageBox(operation.crop, {
        x: currentBox.x,
        y: currentBox.y,
        width: currentBox.width,
        height: currentBox.height,
      });

      if (clamped.width <= 0 || clamped.height <= 0) {
        throw new Error(
          `The crop for page ${operation.sourcePageNumber} is outside the page bounds.`,
        );
      }

      page.setCropBox(clamped.x, clamped.y, clamped.width, clamped.height);
    }
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
    croppedPageCount: operations.filter((operation) => operation.crop).length,
    remainingPageCount: operations.length,
    reordered,
    processingTime: performance.now() - startTime,
  };
}
