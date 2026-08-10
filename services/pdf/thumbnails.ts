export interface PageThumbnail {
  pageNumber: number;
  /** JPEG data URL, or null when the page preview was skipped. */
  dataUrl: string | null;
}

export interface ThumbnailProgress {
  currentPage: number;
  pageCount: number;
}

export interface ThumbnailOptions {
  /** Longest thumbnail edge in CSS pixels. */
  maxDimension?: number;
  /** Pages beyond this count are listed without a rendered preview. */
  maxRenderedPages?: number;
  onProgress?: (progress: ThumbnailProgress) => void;
}

const DEFAULT_MAX_DIMENSION = 160;
const DEFAULT_MAX_RENDERED_PAGES = 200;
const THUMBNAIL_QUALITY = 0.7;

/**
 * Renders small page previews for selection UIs.
 *
 * Pages are rendered one at a time at a low resolution and each canvas is
 * released afterwards so large documents stay within reasonable memory use.
 */
export async function renderPageThumbnails(
  file: File,
  options: ThumbnailOptions = {},
): Promise<PageThumbnail[]> {
  const maxDimension = options.maxDimension ?? DEFAULT_MAX_DIMENSION;
  const maxRenderedPages = options.maxRenderedPages ?? DEFAULT_MAX_RENDERED_PAGES;
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
    const thumbnails: PageThumbnail[] = [];

    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      options.onProgress?.({ currentPage: pageNumber, pageCount: pdf.numPages });

      if (pageNumber > maxRenderedPages) {
        thumbnails.push({ pageNumber, dataUrl: null });
        continue;
      }

      const page = await pdf.getPage(pageNumber);
      const canvas = document.createElement("canvas");

      try {
        const baseViewport = page.getViewport({ scale: 1 });
        const scale = Math.min(
          1,
          maxDimension / Math.max(baseViewport.width, baseViewport.height),
        );
        const viewport = page.getViewport({ scale });

        canvas.width = Math.max(1, Math.ceil(viewport.width));
        canvas.height = Math.max(1, Math.ceil(viewport.height));

        const context = canvas.getContext("2d");

        if (!context) {
          throw new Error("Unable to create canvas rendering context.");
        }

        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, canvas.width, canvas.height);

        await page.render({ canvas, canvasContext: context, viewport }).promise;

        thumbnails.push({
          pageNumber,
          dataUrl: canvas.toDataURL("image/jpeg", THUMBNAIL_QUALITY),
        });
      } finally {
        page.cleanup();
        canvas.width = 0;
        canvas.height = 0;
      }
    }

    return thumbnails;
  } finally {
    pdf.cleanup();
    await loadingTask.destroy();
  }
}
