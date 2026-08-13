import { PDFDocument } from "pdf-lib";
import type { ProcessedImage } from "../imageFilters";

/**
 * PDF generation for the Image → PDF tool.
 *
 * This module only turns already-processed image bytes into a PDF via
 * pdf-lib. It contains no Canvas or filtering logic — filtering happens
 * upstream in `services/imageFilters.ts`. One page is created per image,
 * in the order the images are given.
 */

export type PageSizeOption = "a4" | "letter" | "original";
export type OrientationOption = "auto" | "portrait" | "landscape";
export type FitModeOption = "fit" | "fill" | "original";

export interface ImageToPdfOptions {
  pageSize: PageSizeOption;
  orientation: OrientationOption;
  fitMode: FitModeOption;
}

export interface ImageToPdfResult {
  bytes: Uint8Array;
  imageCount: number;
  processingTime: number;
}

/** A4 in points (portrait baseline), per the PDF point convention (1pt = 1/72in). */
const A4_SIZE = { width: 595.28, height: 841.89 };

/** US Letter in points (portrait baseline). */
const LETTER_SIZE = { width: 612, height: 792 };

interface PageDimensions {
  width: number;
  height: number;
}

interface DrawRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Resolves the PDF page size (in points) for one image, given the chosen
 * page size and orientation. "Original" page size follows the project's
 * 1px = 1pt convention, using the image's own pixel dimensions — in that
 * case the page is inherently the image's own orientation.
 */
function resolvePageDimensions(
  image: ProcessedImage,
  options: ImageToPdfOptions,
): PageDimensions {
  if (options.pageSize === "original") {
    return { width: image.width, height: image.height };
  }

  const baseSize = options.pageSize === "a4" ? A4_SIZE : LETTER_SIZE;
  const longEdge = Math.max(baseSize.width, baseSize.height);
  const shortEdge = Math.min(baseSize.width, baseSize.height);

  let useLandscape: boolean;

  if (options.orientation === "portrait") {
    useLandscape = false;
  } else if (options.orientation === "landscape") {
    useLandscape = true;
  } else {
    // Auto: match whichever orientation best fits this image's own shape.
    useLandscape = image.width > image.height;
  }

  return useLandscape
    ? { width: longEdge, height: shortEdge }
    : { width: shortEdge, height: longEdge };
}

/**
 * Resolves where and at what size to draw the image on its page, given the
 * chosen fit mode. Aspect ratio is always preserved for "Fit to page" and
 * "Fill page"; only "Original" can distort the page/image relationship (it
 * draws at native pixel size, which may exceed the page bounds).
 */
function resolveDrawRect(
  image: ProcessedImage,
  page: PageDimensions,
  fitMode: FitModeOption,
): DrawRect {
  if (fitMode === "original") {
    return {
      x: (page.width - image.width) / 2,
      y: (page.height - image.height) / 2,
      width: image.width,
      height: image.height,
    };
  }

  const fitScale = Math.min(page.width / image.width, page.height / image.height);
  const fillScale = Math.max(page.width / image.width, page.height / image.height);
  const scale = fitMode === "fill" ? fillScale : fitScale;

  const width = image.width * scale;
  const height = image.height * scale;

  return {
    x: (page.width - width) / 2,
    y: (page.height - height) / 2,
    width,
    height,
  };
}

/**
 * Builds one PDF containing the given images in order, one image per page.
 * Page content beyond a page's own boundary (possible with "Fill page") is
 * simply outside that page's MediaBox and is not rendered by PDF viewers,
 * so no explicit clip path is needed to keep the image centered and
 * covering the page.
 */
export async function imagesToPdf(
  images: ProcessedImage[],
  options: ImageToPdfOptions,
): Promise<ImageToPdfResult> {
  const startTime = performance.now();

  if (images.length === 0) {
    throw new Error("Add at least one image to generate a PDF.");
  }

  const pdf = await PDFDocument.create();

  for (const image of images) {
    let embeddedImage;

    try {
      embeddedImage =
        image.format === "png"
          ? await pdf.embedPng(image.bytes)
          : await pdf.embedJpg(image.bytes);
    } catch {
      throw new Error("One of the images could not be embedded into the PDF.");
    }

    const pageDimensions = resolvePageDimensions(image, options);
    const page = pdf.addPage([pageDimensions.width, pageDimensions.height]);
    const drawRect = resolveDrawRect(image, pageDimensions, options.fitMode);

    page.drawImage(embeddedImage, drawRect);
  }

  let bytes: Uint8Array;

  try {
    bytes = await pdf.save();
  } catch {
    throw new Error("Failed to generate the PDF from the selected images.");
  }

  return {
    bytes,
    imageCount: images.length,
    processingTime: performance.now() - startTime,
  };
}
