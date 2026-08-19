/**
 * Client-side image filtering, built entirely on the Canvas 2D API.
 *
 * This module is intentionally PDF-agnostic: it knows nothing about
 * pdf-lib, pages, or documents. It only turns an uploaded image `File`
 * plus a chosen `FilterPreset` into a processed image (bytes + pixel
 * dimensions). `services/pdf/imageToPdf.ts` is responsible for turning
 * that output into a PDF.
 *
 * `applyImageFilter` also backs the live filter preview in
 * `ImageToPdfCard`: callers pass an optional `maxDimension` to have the
 * image downscaled before the same pixel-level filter runs, so preview
 * generation stays cheap on large phone-camera photos. Final PDF
 * generation calls this with no `maxDimension`, so it always runs against
 * the full-resolution image. Both paths run the exact same filter
 * functions below — there is no separate "preview" algorithm.
 */

/** The four fixed filter presets. Not a general image editor — no sliders. */
export type FilterPreset =
  | "original"
  | "grayscale"
  | "document-bw"
  | "magic-colour";

export const FILTER_PRESETS: { value: FilterPreset; label: string; description: string }[] = [
  { value: "original", label: "Original", description: "Keep the image exactly as uploaded." },
  { value: "grayscale", label: "Grayscale", description: "Neutral black-and-white tones." },
  {
    value: "document-bw",
    label: "Document B&W",
    description: "Clean scan look — adapts to shadows and uneven lighting.",
  },
  {
    value: "magic-colour",
    label: "✨ Magic Colour",
    description: "Brighter, punchier colour without looking over-edited.",
  },
];

export interface ProcessedImage {
  /** Encoded image bytes ready to embed into a PDF. */
  bytes: Uint8Array;
  /** "jpg" for filtered output (JPEG) or the original's own format when untouched. */
  format: "jpg" | "png";
  /** Pixel width of the encoded image (may be downscaled — see `maxDimension`). */
  width: number;
  /** Pixel height of the encoded image (may be downscaled — see `maxDimension`). */
  height: number;
}

/** JPEG encode quality used for any filter that re-encodes via canvas. */
const ENCODE_QUALITY = 0.92;

/**
 * Longest-edge cap (in pixels) used for the live filter preview. Chosen to
 * comfortably fill both the small per-row thumbnail and the larger
 * "Filter preview" panel / lightbox without re-processing full-resolution
 * camera photos on every filter change.
 */
export const PREVIEW_MAX_DIMENSION = 960;

/** Returns true when the file is a JPG/JPEG or PNG image (by MIME type or extension). */
export function isImageFile(file: File): boolean {
  const mime = file.type.toLowerCase();
  const isImageMime = mime === "image/jpeg" || mime === "image/png";
  const name = file.name.toLowerCase();
  const isImageExtension =
    name.endsWith(".jpg") || name.endsWith(".jpeg") || name.endsWith(".png");

  return isImageMime || isImageExtension;
}

function formatFromMime(mimeType: string): "jpg" | "png" {
  return mimeType.toLowerCase() === "image/png" ? "png" : "jpg";
}

/** Decodes a File into a drawable image plus its natural pixel dimensions. */
async function decodeImage(
  file: File,
): Promise<{ image: ImageBitmap | HTMLImageElement; width: number; height: number }> {
  if (typeof createImageBitmap === "function") {
    let bitmap: ImageBitmap;

    try {
      bitmap = await createImageBitmap(file);
    } catch {
      throw new Error(`"${file.name}" could not be read as an image.`);
    }

    return { image: bitmap, width: bitmap.width, height: bitmap.height };
  }

  // Fallback for browsers without createImageBitmap support.
  const objectUrl = URL.createObjectURL(file);

  try {
    const element = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () =>
        reject(new Error(`"${file.name}" could not be read as an image.`));
      img.src = objectUrl;
    });

    return { image: element, width: element.naturalWidth, height: element.naturalHeight };
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function releaseDecodedImage(image: ImageBitmap | HTMLImageElement): void {
  if (typeof ImageBitmap !== "undefined" && image instanceof ImageBitmap) {
    image.close();
  }
}

function clampChannel(value: number): number {
  return Math.min(255, Math.max(0, value));
}

/**
 * Given an image's natural size and an optional longest-edge cap, returns
 * the size to actually draw/process at. Never upscales — a cap larger than
 * the image is a no-op.
 */
function resolveTargetSize(
  width: number,
  height: number,
  maxDimension: number | undefined,
): { width: number; height: number } {
  if (!maxDimension || (width <= maxDimension && height <= maxDimension)) {
    return { width, height };
  }

  const scale = maxDimension / Math.max(width, height);

  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** Grayscale via the standard luminance weights, applied in place. */
function applyGrayscale(data: Uint8ClampedArray): void {
  for (let i = 0; i < data.length; i += 4) {
    const gray = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];

    data[i] = gray;
    data[i + 1] = gray;
    data[i + 2] = gray;
  }
}

/**
 * "Document B&W" — a local-mean (Bradley/Roth-style) adaptive threshold.
 *
 * A single global threshold turns any shadow, uneven scan lighting, or
 * off-white paper into either a solid black smear or a washed-out page.
 * Adaptive thresholding instead compares each pixel to the average
 * brightness of its own neighbourhood, so it tracks gradual lighting
 * changes across the page while still snapping text/diagrams to clean
 * black/white. It's computed with a summed-area (integral) image so the
 * whole pass stays O(width * height) — no per-pixel window loop — which
 * keeps it practical to run in the browser at full photo resolution.
 */
function applyDocumentBW(data: Uint8ClampedArray, width: number, height: number): void {
  const pixelCount = width * height;

  // Per-pixel luminance, kept as a single byte each (not Float64) so a
  // large photo doesn't balloon memory just for this pass.
  const gray = new Uint8ClampedArray(pixelCount);

  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    gray[p] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  }

  // Summed-area table with a 1px zero border, so any rectangle's sum is
  // four array reads regardless of its size.
  const integralWidth = width + 1;
  const integral = new Float64Array(integralWidth * (height + 1));

  for (let y = 0; y < height; y++) {
    let rowSum = 0;
    const integralRow = (y + 1) * integralWidth;
    const prevIntegralRow = y * integralWidth;

    for (let x = 0; x < width; x++) {
      rowSum += gray[y * width + x];
      // Standard 2D prefix sum: this row's running sum plus whatever was
      // already accumulated above this column.
      integral[integralRow + x + 1] = integral[prevIntegralRow + x + 1] + rowSum;
    }
  }

  // Local window ~1/8 of the shorter dimension (the standard Bradley
  // choice) — big enough to average out noise/shadow gradients, small
  // enough to still react to real page-scale lighting changes.
  const windowSize = Math.max(15, Math.floor(Math.min(width, height) / 8));
  const half = Math.floor(windowSize / 2);
  // A pixel counts as "ink" when it's at least 15% darker than its local
  // neighbourhood average — dark enough to be reliably text/lines, not
  // JPEG noise or a faint shadow edge.
  const sensitivity = 0.15;

  for (let y = 0; y < height; y++) {
    const y1 = Math.max(0, y - half);
    const y2 = Math.min(height - 1, y + half);

    for (let x = 0; x < width; x++) {
      const x1 = Math.max(0, x - half);
      const x2 = Math.min(width - 1, x + half);

      const count = (x2 - x1 + 1) * (y2 - y1 + 1);
      const sum =
        integral[(y2 + 1) * integralWidth + (x2 + 1)] -
        integral[y1 * integralWidth + (x2 + 1)] -
        integral[(y2 + 1) * integralWidth + x1] +
        integral[y1 * integralWidth + x1];

      const localMean = sum / count;
      const pixelValue = gray[y * width + x];
      const isInk = pixelValue < localMean * (1 - sensitivity);
      const value = isInk ? 0 : 255;
      const idx = (y * width + x) * 4;

      data[idx] = value;
      data[idx + 1] = value;
      data[idx + 2] = value;
    }
  }
}

/**
 * "Magic Colour" — a deterministic auto-enhance: a contrast, saturation,
 * and brightness lift computed directly on pixel data (not the CSS
 * `filter` property, which can render differently across browsers/
 * engines). Tuned to be clearly visible next to "Original" — noticeably
 * punchier and less washed-out — without sliding into an oversaturated
 * "Instagram filter" look or shifting skin tones.
 */
function applyMagicColour(data: Uint8ClampedArray): void {
  const contrast = 1.18;
  const saturation = 1.25;
  const brightness = 6;
  const contrastOffset = 128 * (1 - contrast);

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const gray = 0.299 * r + 0.587 * g + 0.114 * b;

    // Saturation: push each channel away from (or toward) gray.
    let nr = gray + (r - gray) * saturation;
    let ng = gray + (g - gray) * saturation;
    let nb = gray + (b - gray) * saturation;

    // Contrast, then brightness.
    nr = nr * contrast + contrastOffset + brightness;
    ng = ng * contrast + contrastOffset + brightness;
    nb = nb * contrast + contrastOffset + brightness;

    data[i] = clampChannel(nr);
    data[i + 1] = clampChannel(ng);
    data[i + 2] = clampChannel(nb);
  }
}

/**
 * Applies the chosen preset to one image and returns encoded bytes.
 *
 * Without `maxDimension`, this processes the image at its full natural
 * resolution — this is what final PDF generation uses, and callers should
 * invoke it that way only when generating the PDF, not on every settings
 * change. With `maxDimension`, the image is downscaled (never upscaled)
 * to that longest edge before the same filter runs — this is what the
 * live preview uses, so switching filters stays cheap even for large
 * camera photos. The filter functions themselves are identical either
 * way, so the preview is representative of the final PDF.
 */
export async function applyImageFilter(
  file: File,
  preset: FilterPreset,
  maxDimension?: number,
): Promise<ProcessedImage> {
  const { image, width, height } = await decodeImage(file);

  try {
    if (preset === "original") {
      // Pass the original bytes through untouched — no canvas re-encode,
      // no quality loss. ("Original" has nothing to downscale for
      // preview purposes either; callers display it via the source file
      // directly and never reach this branch with a maxDimension.)
      const bytes = new Uint8Array(await file.arrayBuffer());

      return { bytes, format: formatFromMime(file.type), width, height };
    }

    const target = resolveTargetSize(width, height, maxDimension);

    const canvas = document.createElement("canvas");
    canvas.width = target.width;
    canvas.height = target.height;

    const context = canvas.getContext("2d");

    if (!context) {
      throw new Error("Unable to create canvas rendering context.");
    }

    try {
      context.drawImage(image, 0, 0, target.width, target.height);

      const imageData = context.getImageData(0, 0, target.width, target.height);

      switch (preset) {
        case "grayscale":
          applyGrayscale(imageData.data);
          break;
        case "document-bw":
          applyDocumentBW(imageData.data, target.width, target.height);
          break;
        case "magic-colour":
          applyMagicColour(imageData.data);
          break;
      }

      context.putImageData(imageData, 0, 0);

      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(
          (result) => {
            if (result) {
              resolve(result);
            } else {
              reject(new Error(`"${file.name}" could not be processed.`));
            }
          },
          "image/jpeg",
          ENCODE_QUALITY,
        );
      });

      const bytes = new Uint8Array(await blob.arrayBuffer());

      return { bytes, format: "jpg", width: target.width, height: target.height };
    } finally {
      canvas.width = 0;
      canvas.height = 0;
    }
  } finally {
    releaseDecodedImage(image);
  }
}
