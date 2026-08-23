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

      // Yield to the browser once per page so it can paint (progress UI,
      // input, etc.) between page renders instead of blocking the main
      // thread for the whole document — same approach used for the
      // Compress PDF rasterization fix.
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve());
      });

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

export interface SinglePagePreview {
  /** PNG data URL of the rendered page. */
  dataUrl: string;
  /** Page width at scale 1, in the PDF page's own coordinate space (points). */
  pageWidth: number;
  /** Page height at scale 1, in the PDF page's own coordinate space (points). */
  pageHeight: number;
}

const DEFAULT_PREVIEW_MAX_DIMENSION = 700;

/**
 * Renders a single PDF page at a larger resolution than
 * `renderPageThumbnails`, along with its native page dimensions, for use in
 * a full-size live preview (e.g. watermark/page-number placement UIs).
 * Reuses the same pdf.js loading/rendering approach as
 * `renderPageThumbnails` above.
 */
export async function renderSinglePagePreview(
  file: File,
  pageNumber = 1,
  maxDimension: number = DEFAULT_PREVIEW_MAX_DIMENSION,
): Promise<SinglePagePreview> {
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
    if (pageNumber < 1 || pageNumber > pdf.numPages) {
      throw new Error(`Page ${pageNumber} does not exist in this PDF.`);
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

      return {
        dataUrl: canvas.toDataURL("image/png"),
        pageWidth: baseViewport.width,
        pageHeight: baseViewport.height,
      };
    } finally {
      page.cleanup();
      canvas.width = 0;
      canvas.height = 0;
    }
  } finally {
    pdf.cleanup();
    await loadingTask.destroy();
  }
}

/**
 * A page's current visible box (its CropBox, or MediaBox if no CropBox is
 * set) in the PDF's own default user-space coordinate system: origin at the
 * page's lower-left corner, x increasing right, y increasing up. This is the
 * same box pdf-lib reads/writes via `PDFPage.getCropBox()`/`setCropBox()`,
 * and the same box pdf.js reports as `PDFPageProxy.view`.
 */
export interface PageBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CropEditorPreview {
  /** PNG data URL of the page, rendered WITHOUT any /Rotate applied. */
  dataUrl: string;
  /**
   * Pixel width/height of `dataUrl`. Because the render is unrotated, these
   * are proportional to `pageBox.width`/`pageBox.height` by a single
   * `renderScale` factor (pixels per PDF point) — the exact factor needed to
   * convert crop-box drags back into PDF point space.
   */
  renderWidth: number;
  renderHeight: number;
  /** Pixels per PDF point: renderWidth / pageBox.width (== renderHeight / pageBox.height). */
  renderScale: number;
  /** The page's current CropBox/MediaBox, in PDF point space. */
  pageBox: PageBox;
  /**
   * The rotation (degrees clockwise, one of 0/90/180/270) already baked into
   * the source PDF's /Rotate entry for this page. This is NOT reflected in
   * `dataUrl` (which is always rendered unrotated) — it's returned so the
   * caller can combine it with any additional user-chosen rotation and apply
   * the total as a display-only CSS transform.
   */
  pageRotation: number;
}

/**
 * Renders a single PDF page for the crop/rotate editor.
 *
 * Unlike `renderSinglePagePreview`, this ALWAYS renders the page's raw,
 * unrotated content (`rotation: 0` is passed explicitly to pdf.js, which
 * overrides — not adds to — the page's own /Rotate value). That keeps the
 * rendered pixel space perfectly aligned with the page's CropBox/MediaBox
 * coordinate space that pdf-lib's `setCropBox` expects, regardless of
 * whatever /Rotate value the source PDF already has. Any rotation the user
 * sees is applied purely as a CSS transform by the caller, on top of this
 * unrotated render — it never affects the coordinates stored for the crop.
 */
export async function renderCropEditorPreview(
  file: File,
  pageNumber: number,
  maxDimension: number = DEFAULT_PREVIEW_MAX_DIMENSION,
): Promise<CropEditorPreview> {
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
    if (pageNumber < 1 || pageNumber > pdf.numPages) {
      throw new Error(`Page ${pageNumber} does not exist in this PDF.`);
    }

    const page = await pdf.getPage(pageNumber);
    const canvas = document.createElement("canvas");

    try {
      const pageRotation = page.rotate;
      const [x0, y0, x1, y1] = page.view;
      const pageBox: PageBox = {
        x: x0,
        y: y0,
        width: x1 - x0,
        height: y1 - y0,
      };

      // rotation: 0 overrides the page's own /Rotate for this render, so the
      // resulting pixels line up 1:1 with pageBox (unrotated PDF space).
      const baseViewport = page.getViewport({ scale: 1, rotation: 0 });
      const scale = Math.min(
        1,
        maxDimension / Math.max(baseViewport.width, baseViewport.height),
      );
      const viewport = page.getViewport({ scale, rotation: 0 });

      canvas.width = Math.max(1, Math.ceil(viewport.width));
      canvas.height = Math.max(1, Math.ceil(viewport.height));

      const context = canvas.getContext("2d");

      if (!context) {
        throw new Error("Unable to create canvas rendering context.");
      }

      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);

      await page.render({ canvas, canvasContext: context, viewport }).promise;

      return {
        dataUrl: canvas.toDataURL("image/png"),
        renderWidth: canvas.width,
        renderHeight: canvas.height,
        renderScale: canvas.width / pageBox.width,
        pageBox,
        pageRotation,
      };
    } finally {
      page.cleanup();
      canvas.width = 0;
      canvas.height = 0;
    }
  } finally {
    pdf.cleanup();
    await loadingTask.destroy();
  }
}

/**
 * Looks up the current CropBox/MediaBox (`PageBox`) for a set of pages
 * without rendering them, so callers can map a relative crop rectangle onto
 * pages other than the one currently shown in the editor. Opens the document
 * once and reuses it for every requested page.
 */
export async function getPageBoxes(
  file: File,
  pageNumbers: number[],
): Promise<Map<number, PageBox>> {
  const result = new Map<number, PageBox>();

  if (pageNumbers.length === 0) {
    return result;
  }

  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const inputBytes = new Uint8Array(await file.arrayBuffer());
  const loadingTask = pdfjsLib.getDocument({ data: inputBytes });
  const pdf = await loadingTask.promise;

  try {
    for (const pageNumber of pageNumbers) {
      if (pageNumber < 1 || pageNumber > pdf.numPages) continue;

      const page = await pdf.getPage(pageNumber);

      try {
        const [x0, y0, x1, y1] = page.view;

        result.set(pageNumber, {
          x: x0,
          y: y0,
          width: x1 - x0,
          height: y1 - y0,
        });
      } finally {
        page.cleanup();
      }
    }

    return result;
  } finally {
    pdf.cleanup();
    await loadingTask.destroy();
  }
}
