/**
 * Client-side image filtering, built entirely on the Canvas 2D API.
 *
 * This module is intentionally PDF-agnostic: it knows nothing about
 * pdf-lib, pages, or documents. It only turns an uploaded image `File`
 * plus a chosen `FilterPreset` into a processed image (bytes + pixel
 * dimensions). `services/pdf/imageToPdf.ts` is responsible for turning
 * that output into a PDF.
 */

/** The four fixed filter presets. Not a general image editor — no sliders. */
export type FilterPreset =
  | "original"
  | "grayscale"
  | "document-bw"
  | "magic-colour";

export const FILTER_PRESETS: { value: FilterPreset; label: string }[] = [
  { value: "original", label: "Original" },
  { value: "grayscale", label: "Grayscale" },
  { value: "document-bw", label: "Document B&W" },
  { value: "magic-colour", label: "✨ Magic Colour" },
];

export interface ProcessedImage {
  /** Encoded image bytes ready to embed into a PDF. */
  bytes: Uint8Array;
  /** "jpg" for filtered output (JPEG) or the original's own format when untouched. */
  format: "jpg" | "png";
  /** Pixel width of the source image (unaffected by any PDF page size). */
  width: number;
  /** Pixel height of the source image. */
  height: number;
}

/** Fixed threshold for "Document B&W" — internal constant, not user-configurable. */
const DOCUMENT_BW_THRESHOLD = 150;

/** JPEG encode quality used for any filter that re-encodes via canvas. */
const ENCODE_QUALITY = 0.92;

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

/** Grayscale via the standard luminance weights, applied in place. */
function applyGrayscale(data: Uint8ClampedArray): void {
  for (let i = 0; i < data.length; i += 4) {
    const gray = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];

    data[i] = gray;
    data[i + 1] = gray;
    data[i + 2] = gray;
  }
}

/** Grayscale, then a fixed-threshold black/white cutoff — a "scanned document" look. */
function applyDocumentBW(data: Uint8ClampedArray): void {
  for (let i = 0; i < data.length; i += 4) {
    const gray = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    const value = gray >= DOCUMENT_BW_THRESHOLD ? 255 : 0;

    data[i] = value;
    data[i + 1] = value;
    data[i + 2] = value;
  }
}

/**
 * A subtle, deterministic auto-enhance: a small contrast, saturation, and
 * brightness lift, computed directly on pixel data (not the CSS `filter`
 * property, which can render differently across browsers/engines).
 */
function applyMagicColour(data: Uint8ClampedArray): void {
  const contrast = 1.12;
  const saturation = 1.15;
  const brightness = 8;
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
 * Applies the chosen preset to one image and returns encoded bytes ready
 * for PDF embedding. Filtering happens once, on demand — callers should
 * invoke this only when generating the PDF, not on every settings change.
 */
export async function applyImageFilter(
  file: File,
  preset: FilterPreset,
): Promise<ProcessedImage> {
  const { image, width, height } = await decodeImage(file);

  try {
    if (preset === "original") {
      // Pass the original bytes through untouched — no canvas re-encode,
      // no quality loss.
      const bytes = new Uint8Array(await file.arrayBuffer());

      return { bytes, format: formatFromMime(file.type), width, height };
    }

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;

    const context = canvas.getContext("2d");

    if (!context) {
      throw new Error("Unable to create canvas rendering context.");
    }

    try {
      context.drawImage(image, 0, 0, width, height);

      const imageData = context.getImageData(0, 0, width, height);

      switch (preset) {
        case "grayscale":
          applyGrayscale(imageData.data);
          break;
        case "document-bw":
          applyDocumentBW(imageData.data);
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

      return { bytes, format: "jpg", width, height };
    } finally {
      canvas.width = 0;
      canvas.height = 0;
    }
  } finally {
    releaseDecodedImage(image);
  }
}
