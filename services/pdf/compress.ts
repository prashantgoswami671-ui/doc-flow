import { PDFDocument } from "pdf-lib";
import {
  rasterizePDF,
  rasterizePDFWithSettings,
  type RasterSettings,
} from "./rasterize";

/** Supported compression presets. */
export type CompressionMode = "light" | "heavy" | "custom";

/** Information returned after processing a PDF. */
export interface CompressionResult {
  bytes: Uint8Array;
  originalSize: number;
  processedSize: number;
  reductionPercent: number;
  processingTime: number;
  pageCount: number;
  mode: CompressionMode;
}

const CUSTOM_MIN_SCALE = 0.75;
const CUSTOM_MAX_SCALE = 2.0;
const CUSTOM_MIN_QUALITY = 0.45;
const CUSTOM_MAX_QUALITY = 0.92;
const CUSTOM_BINARY_SEARCH_ATTEMPTS = 5;

function getCustomSettings(level: number): RasterSettings {
  return {
    scale: CUSTOM_MIN_SCALE + (CUSTOM_MAX_SCALE - CUSTOM_MIN_SCALE) * level,
    quality:
      CUSTOM_MIN_QUALITY +
      (CUSTOM_MAX_QUALITY - CUSTOM_MIN_QUALITY) * level,
  };
}

async function compressToCustomTarget(
  file: File,
  originalBytes: Uint8Array,
  originalSize: number,
  targetBytes: number,
): Promise<Uint8Array> {
  let bestWithinTarget: Uint8Array | undefined;
  let smallestPractical: Uint8Array | undefined;

  const measureCandidate = async (level: number) => {
    const bytes = await rasterizePDFWithSettings(
      file,
      getCustomSettings(level),
      true,
    );
    const size = bytes.length;

    if (size < originalSize) {
      if (size <= targetBytes) {
        if (!bestWithinTarget || size > bestWithinTarget.length) {
          bestWithinTarget = bytes;
        }
      } else if (
        !bestWithinTarget &&
        (!smallestPractical || size < smallestPractical.length)
      ) {
        smallestPractical = bytes;
      }
    }

    return size;
  };

  const highestQualitySize = await measureCandidate(1);

  if (highestQualitySize <= targetBytes && bestWithinTarget) {
    return bestWithinTarget;
  }

  const lowestPracticalSize = await measureCandidate(0);

  if (lowestPracticalSize <= targetBytes) {
    smallestPractical = undefined;
    let lowerLevel = 0;
    let upperLevel = 1;

    for (let attempt = 0; attempt < CUSTOM_BINARY_SEARCH_ATTEMPTS; attempt++) {
      const level = (lowerLevel + upperLevel) / 2;
      const size = await measureCandidate(level);

      if (size <= targetBytes) {
        lowerLevel = level;
      } else {
        upperLevel = level;
      }
    }
  }

  return bestWithinTarget ?? smallestPractical ?? originalBytes;
}

export async function compressPDF(
  file: File,
  mode: CompressionMode,
  customTargetSizeMb?: number,
): Promise<CompressionResult> {
  const startTime = performance.now();

  const originalSize = file.size;

  let savedPdfBytes: Uint8Array;
  let pageCount: number;

  /*
   * Light and Heavy compression:
   * Render every PDF page as a JPEG image and
   * rebuild the PDF using the compressed images.
   */
  if (mode === "light" || mode === "heavy") {
    const rasterMode = mode === "light" ? "light" : "heavy";

    savedPdfBytes = await rasterizePDF(file, rasterMode);

    // Get the original page count.
    const originalPdfBytes = await file.arrayBuffer();
    const originalPdf = await PDFDocument.load(originalPdfBytes);

    pageCount = originalPdf.getPageCount();

    if (
      mode === "light" &&
      (savedPdfBytes.length >= originalSize ||
        savedPdfBytes.length < originalSize * 0.6)
    ) {
      savedPdfBytes = new Uint8Array(originalPdfBytes);
    }
  } else {
    if (
      !Number.isFinite(customTargetSizeMb) ||
      customTargetSizeMb === undefined ||
      customTargetSizeMb <= 0
    ) {
      throw new Error("A positive custom target size is required.");
    }

    const originalPdfBytes = await file.arrayBuffer();
    const originalPdf = await PDFDocument.load(originalPdfBytes);
    const originalBytes = new Uint8Array(originalPdfBytes);
    const targetBytes = customTargetSizeMb * 1024 * 1024;

    pageCount = originalPdf.getPageCount();
    savedPdfBytes =
      originalSize <= targetBytes
        ? originalBytes
        : await compressToCustomTarget(
            file,
            originalBytes,
            originalSize,
            targetBytes,
          );
  }

  const processedSize = savedPdfBytes.length;

  const reductionPercent =
    originalSize === 0
      ? 0
      : ((originalSize - processedSize) / originalSize) * 100;

  const processingTime = performance.now() - startTime;

  return {
    bytes: savedPdfBytes,
    originalSize,
    processedSize,
    reductionPercent,
    processingTime,
    pageCount,
    mode,
  };
}
