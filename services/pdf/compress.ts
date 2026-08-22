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

/**
 * Loads the source PDF once up front so every mode shares the same page
 * count and can detect an encrypted/malformed source before any
 * rasterization work starts. Mirrors the encryption-detection pattern
 * already used by protect.ts / unlock.ts / repairValidate.ts, since plain
 * pdf-lib throws a generic error on an encrypted PDF otherwise.
 */
async function loadCompressibleSourceOrThrow(
  file: File,
): Promise<{ originalPdfBytes: ArrayBuffer; pageCount: number }> {
  let originalPdfBytes: ArrayBuffer;

  try {
    originalPdfBytes = await file.arrayBuffer();
  } catch {
    throw new Error(`"${file.name}" could not be read.`);
  }

  try {
    const originalPdf = await PDFDocument.load(originalPdfBytes);

    return { originalPdfBytes, pageCount: originalPdf.getPageCount() };
  } catch (loadError) {
    const message = loadError instanceof Error ? loadError.message : "";

    if (/encrypt/i.test(message)) {
      throw new Error(
        `"${file.name}" is password protected. Use Unlock PDF first, then compress the unlocked file.`,
      );
    }

    throw new Error(
      `"${file.name}" could not be read as a PDF. It may be corrupted or not a valid PDF file.`,
    );
  }
}

export async function compressPDF(
  file: File,
  mode: CompressionMode,
  customTargetSizeMb?: number,
): Promise<CompressionResult> {
  const startTime = performance.now();

  const originalSize = file.size;
  const { originalPdfBytes, pageCount } =
    await loadCompressibleSourceOrThrow(file);

  let savedPdfBytes: Uint8Array;

  /*
   * Light and Heavy compression:
   * Render every PDF page as a JPEG image and
   * rebuild the PDF using the compressed images.
   */
  if (mode === "light" || mode === "heavy") {
    const rasterMode = mode === "light" ? "light" : "heavy";

    savedPdfBytes = await rasterizePDF(file, rasterMode);

    // Never hand back a file that's larger than (or barely smaller than)
    // the original — Light and Heavy both fall back to the original bytes
    // in that case. Light additionally rejects suspiciously small output
    // (< 60% of original), since that range is outside what Light's
    // gentler settings should ever produce and more likely indicates a
    // degraded render than a genuine reduction.
    if (savedPdfBytes.length >= originalSize) {
      savedPdfBytes = new Uint8Array(originalPdfBytes);
    } else if (mode === "light" && savedPdfBytes.length < originalSize * 0.6) {
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

    const originalBytes = new Uint8Array(originalPdfBytes);
    const targetBytes = customTargetSizeMb * 1024 * 1024;

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
