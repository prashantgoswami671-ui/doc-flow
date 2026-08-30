/**
 * AI-02 — Browser-side PDF text extraction.
 *
 * `services/pdf/extract.ts` ("Extract Pages") copies selected *pages* out
 * of a PDF into a new PDF via pdf-lib — it does not extract text and its
 * logic does not apply here. This module is separate, AI-specific logic:
 * it reads each page's *text content* via PDF.js, the same loading/
 * worker/cleanup pattern already used by `services/pdf/pdfToImage.ts`,
 * `services/pdf/thumbnails.ts`, and `services/pdf/rasterize.ts`, but using
 * `page.getTextContent()` instead of `page.render()` — so, unlike those
 * modules, this one needs no canvas/DOM and produces no image output.
 *
 * This module performs no chunking (see `./chunking.ts`) and calls no AI
 * provider — it only turns a PDF into page-aware plain text.
 */

export interface PageTextResult {
  /** One-based page number. */
  pageNumber: number;
  /** Extracted plain text for this page. Empty string when the page has no extractable text. */
  text: string;
  /** False for a scanned/image-only page (or any page PDF.js could not extract text from) — never fabricated. */
  hasExtractableText: boolean;
  /** Present only when text extraction failed for this specific page; the page is still reported (not fatal to the whole request). */
  extractionError?: string;
}

export interface ExtractDocumentTextOptions {
  /**
   * One-based page numbers to extract, in the order they should be
   * returned. Omit to extract every page. An empty array is rejected —
   * pass `undefined` for "all pages" instead.
   */
  pageNumbers?: number[];
}

export interface ExtractDocumentTextResult {
  pages: PageTextResult[];
  sourcePageCount: number;
  processingTime: number;
}

/** Validates and normalizes the requested page scope against the loaded document. Mirrors the page-bounds validation already used by pdfToImage.ts/thumbnails.ts (kept local — this is a small pure check, not shared extraction logic). */
function resolvePageNumbers(
  requested: number[] | undefined,
  sourcePageCount: number,
): number[] {
  if (!requested) {
    return Array.from({ length: sourcePageCount }, (_, index) => index + 1);
  }

  if (requested.length === 0) {
    throw new Error("Select at least one page to extract text from.");
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

/** A loose structural type for a PDF.js text-content item, avoiding a hard dependency on pdfjs-dist's internal type names. */
interface TextItemLike {
  str?: string;
}

function joinTextItems(items: TextItemLike[]): string {
  return items
    .map((item) => (typeof item.str === "string" ? item.str : ""))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Loads a PDF via PDF.js, translating its load failures into clear,
 * actionable messages instead of raw internal exceptions — mirrors the
 * encryption-detection pattern in `services/pdf/extract.ts`.
 */
async function loadPdfjsDocumentOrThrow(
  pdfjsLib: typeof import("pdfjs-dist/legacy/build/pdf.mjs"),
  file: File,
) {
  let inputBytes: Uint8Array;

  try {
    inputBytes = new Uint8Array(await file.arrayBuffer());
  } catch {
    throw new Error(`"${file.name}" could not be read.`);
  }

  const loadingTask = pdfjsLib.getDocument({ data: inputBytes });

  try {
    const pdf = await loadingTask.promise;
    return { pdf, loadingTask };
  } catch (loadError) {
    const errorName =
      loadError && typeof loadError === "object" && "name" in loadError
        ? String((loadError as { name?: unknown }).name)
        : "";

    if (errorName === "PasswordException") {
      throw new Error(
        `"${file.name}" is password protected. Use Unlock PDF first, then extract text from the unlocked file.`,
      );
    }

    throw new Error(
      `"${file.name}" could not be read as a PDF. It may be corrupted or not a valid PDF file.`,
    );
  }
}

/**
 * Extracts page-aware plain text from a PDF, entirely in the browser.
 *
 * Does not send anything to an AI provider and does not invoke OCR — a
 * page with no extractable text (e.g. a scanned/image-only page) is
 * reported with `hasExtractableText: false` and empty text rather than
 * fabricated or silently dropped. The existing Tesseract orientation
 * path (`services/pdf/orientation.ts`) is not touched or reused here.
 */
export async function extractDocumentText(
  file: File,
  options: ExtractDocumentTextOptions = {},
): Promise<ExtractDocumentTextResult> {
  const startTime = performance.now();
  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");

  if (typeof window !== "undefined") {
    pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
      "pdfjs-dist/legacy/build/pdf.worker.min.mjs",
      import.meta.url,
    ).toString();
  }

  const { pdf, loadingTask } = await loadPdfjsDocumentOrThrow(pdfjsLib, file);

  try {
    const sourcePageCount = pdf.numPages;

    if (sourcePageCount < 1) {
      throw new Error(`"${file.name}" has no pages to extract text from.`);
    }

    const pageNumbers = resolvePageNumbers(options.pageNumbers, sourcePageCount);
    const pages: PageTextResult[] = [];

    for (const pageNumber of pageNumbers) {
      const page = await pdf.getPage(pageNumber);

      try {
        const textContent = await page.getTextContent();
        const text = joinTextItems(textContent.items as TextItemLike[]);

        pages.push({
          pageNumber,
          text,
          hasExtractableText: text.length > 0,
        });
      } catch (pageError) {
        pages.push({
          pageNumber,
          text: "",
          hasExtractableText: false,
          extractionError:
            pageError instanceof Error
              ? pageError.message
              : `Page ${pageNumber} text extraction failed.`,
        });
      } finally {
        page.cleanup();
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
