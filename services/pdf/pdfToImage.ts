/**
 * PDF → Image conversion.
 *
 * This module renders selected pages of a PDF onto Canvas via PDF.js and
 * encodes each rendered page as a JPG or PNG. It reuses the same PDF.js
 * loading/worker setup and render-then-cleanup pattern already used by
 * `services/pdf/thumbnails.ts` and `services/pdf/rasterize.ts` — no other
 * PDF rendering library is introduced.
 *
 * This module is framework-agnostic: it knows nothing about React state or
 * DocFlow's card UI conventions. `components/PdfToImageCard.tsx` is
 * responsible for selection UI, previews, and downloads.
 */

export type ImageOutputFormat = "jpg" | "png";

export interface PdfToImageProgress {
  currentPage: number;
  pageCount: number;
}

export interface PdfToImageOptions {
  /** One-based page numbers to render, in the order they should be returned. Defaults to every page. */
  pageNumbers?: number[];
  format: ImageOutputFormat;
  /** JPEG encode quality, 0–1. Ignored for PNG. */
  quality?: number;
  /** Render scale relative to the PDF's own 1pt = 1px baseline (72 DPI). E.g. 150 DPI = 150/72. */
  scale?: number;
  onProgress?: (progress: PdfToImageProgress) => void;
}

export interface PdfToImagePageResult {
  pageNumber: number;
  bytes: Uint8Array;
  format: ImageOutputFormat;
  /** Rendered pixel width (reflects the chosen scale). */
  width: number;
  /** Rendered pixel height (reflects the chosen scale). */
  height: number;
}

export interface PdfToImageResult {
  pages: PdfToImagePageResult[];
  sourcePageCount: number;
  processingTime: number;
}

const DEFAULT_SCALE = 150 / 72;
const DEFAULT_QUALITY = 0.92;

function mimeTypeForFormat(format: ImageOutputFormat): string {
  return format === "png" ? "image/png" : "image/jpeg";
}

/** Validates requested page numbers against the actual loaded document. */
function resolvePageNumbers(
  requested: number[] | undefined,
  sourcePageCount: number,
): number[] {
  if (!requested) {
    return Array.from({ length: sourcePageCount }, (_, index) => index + 1);
  }

  if (requested.length === 0) {
    throw new Error("Select at least one page to convert.");
  }

  const seen = new Set<number>();

  for (const pageNumber of requested) {
    if (
      !Number.isSafeInteger(pageNumber) ||
      pageNumber < 1 ||
      pageNumber > sourcePageCount
    ) {
      throw new Error(
        `Page ${pageNumber} is outside this PDF's ${sourcePageCount}-page range.`,
      );
    }

    if (seen.has(pageNumber)) {
      throw new Error(`Page ${pageNumber} was selected more than once.`);
    }

    seen.add(pageNumber);
  }

  return requested;
}

/**
 * Renders the requested pages of a PDF to JPG or PNG images.
 *
 * Pages are rendered sequentially, one canvas at a time, and every
 * PDF.js page proxy plus its canvas is released in a `finally` block
 * immediately after that page is encoded, so memory use stays bounded by
 * a single page even for large documents or high scales.
 */
export async function convertPdfToImages(
  file: File,
  options: PdfToImageOptions,
): Promise<PdfToImageResult> {
  const startTime = performance.now();
  const format = options.format;
  const quality = options.quality ?? DEFAULT_QUALITY;
  const scale = options.scale ?? DEFAULT_SCALE;

  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");

  if (typeof window !== "undefined") {
    pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
      "pdfjs-dist/legacy/build/pdf.worker.min.mjs",
      import.meta.url,
    ).toString();
  }

  const inputBytes = new Uint8Array(await file.arrayBuffer());
  const loadingTask = pdfjsLib.getDocument({ data: inputBytes });
  const pdf = await loadingTask.promise;

  try {
    const sourcePageCount = pdf.numPages;
    const pageNumbers = resolvePageNumbers(options.pageNumbers, sourcePageCount);
    const pages: PdfToImagePageResult[] = [];

    for (let index = 0; index < pageNumbers.length; index++) {
      const pageNumber = pageNumbers[index];

      options.onProgress?.({
        currentPage: index + 1,
        pageCount: pageNumbers.length,
      });

      const page = await pdf.getPage(pageNumber);
      const canvas = document.createElement("canvas");

      try {
        const viewport = page.getViewport({ scale });

        canvas.width = Math.max(1, Math.ceil(viewport.width));
        canvas.height = Math.max(1, Math.ceil(viewport.height));

        const context = canvas.getContext("2d");

        if (!context) {
          throw new Error("Unable to create canvas rendering context.");
        }

        if (format === "jpg") {
          // JPEG has no alpha channel — fill white first so that a
          // transparent PDF page background doesn't render as black.
          context.fillStyle = "#ffffff";
          context.fillRect(0, 0, canvas.width, canvas.height);
        }

        await page.render({ canvas, canvasContext: context, viewport }).promise;

        const blob = await new Promise<Blob>((resolve, reject) => {
          canvas.toBlob(
            (result) => {
              if (result) {
                resolve(result);
              } else {
                reject(
                  new Error(
                    `Page ${pageNumber} could not be encoded as ${format.toUpperCase()}.`,
                  ),
                );
              }
            },
            mimeTypeForFormat(format),
            format === "jpg" ? quality : undefined,
          );
        });

        const bytes = new Uint8Array(await blob.arrayBuffer());

        pages.push({
          pageNumber,
          bytes,
          format,
          width: canvas.width,
          height: canvas.height,
        });
      } finally {
        page.cleanup();
        canvas.width = 0;
        canvas.height = 0;
      }
    }

    return {
      pages,
      sourcePageCount,
      processingTime: performance.now() - startTime,
    };
  } finally {
    pdf.cleanup();
    await loadingTask.destroy();
  }
}
