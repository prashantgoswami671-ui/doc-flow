import { describe, expect, it } from "vitest";
import { extractDocumentText } from "./extraction";
import {
  buildEmptyPdfBytes,
  buildMalformedPdfBytes,
  buildScannedImageOnlyPdfBytes,
  buildTextVectorPdfBytes,
  toFile,
} from "../pdf/__fixtures__/pdf";

/**
 * AI-02 — Browser-side PDF text extraction.
 *
 * Reuses the existing Phase 3 PDF fixtures (`services/pdf/__fixtures__`)
 * rather than hand-building new ones. Only `getTextContent()` is
 * exercised here (no canvas/render), so — unlike the rasterizer tests —
 * this runs directly under this project's plain-Node vitest environment.
 */

describe("extractDocumentText", () => {
  it("extracts text from a normal single-page text PDF", async () => {
    const bytes = await buildTextVectorPdfBytes(1);
    const result = await extractDocumentText(toFile(bytes));

    expect(result.sourcePageCount).toBe(1);
    expect(result.pages).toHaveLength(1);
    expect(result.pages[0].pageNumber).toBe(1);
    expect(result.pages[0].hasExtractableText).toBe(true);
    expect(result.pages[0].text).toContain("Section 1 Heading");
    expect(result.pages[0].text).toContain("Phase 3.1 fixture");
  });

  it("extracts text from every page of a multi-page PDF, in page order", async () => {
    const bytes = await buildTextVectorPdfBytes(3);
    const result = await extractDocumentText(toFile(bytes));

    expect(result.sourcePageCount).toBe(3);
    expect(result.pages.map((p) => p.pageNumber)).toEqual([1, 2, 3]);
    expect(result.pages[0].text).toContain("Section 1 Heading");
    expect(result.pages[1].text).toContain("Section 2 Heading");
    expect(result.pages[2].text).toContain("Section 3 Heading");
  });

  it("honors an explicit page selection/scope, in the requested order", async () => {
    const bytes = await buildTextVectorPdfBytes(3);
    const result = await extractDocumentText(toFile(bytes), { pageNumbers: [3, 1] });

    expect(result.pages.map((p) => p.pageNumber)).toEqual([3, 1]);
    expect(result.pages[0].text).toContain("Section 3 Heading");
    expect(result.pages[1].text).toContain("Section 1 Heading");
  });

  it("rejects a page number outside the document's range", async () => {
    const bytes = await buildTextVectorPdfBytes(2);

    await expect(
      extractDocumentText(toFile(bytes), { pageNumbers: [5] }),
    ).rejects.toThrow(/outside this PDF's/);
  });

  it("rejects a duplicate page number in the selection", async () => {
    const bytes = await buildTextVectorPdfBytes(2);

    await expect(
      extractDocumentText(toFile(bytes), { pageNumbers: [1, 1] }),
    ).rejects.toThrow(/more than once/);
  });

  it("rejects an empty page-selection array", async () => {
    const bytes = await buildTextVectorPdfBytes(2);

    await expect(
      extractDocumentText(toFile(bytes), { pageNumbers: [] }),
    ).rejects.toThrow(/Select at least one page/);
  });

  it("reports a scanned/image-only page as having no extractable text, without fabricating content", async () => {
    const bytes = await buildScannedImageOnlyPdfBytes(1);
    const result = await extractDocumentText(toFile(bytes));

    expect(result.pages).toHaveLength(1);
    expect(result.pages[0].hasExtractableText).toBe(false);
    expect(result.pages[0].text).toBe("");
  });

  it("treats pdf-lib's zero-page fixture as a single page with no extractable text", async () => {
    // buildEmptyPdfBytes() calls PDFDocument.create() with no addPage()
    // calls, but pdf-lib's save() itself adds a blank page when none
    // exist (a Pages tree with zero kids isn't something it will emit) —
    // this is the same baseline finding already measured and documented
    // in services/pdf/compress.test.ts ("compressPDF — empty PDF (zero
    // pages)": pdf-lib reports 1 page for this fixture, not 0). So this
    // fixture never actually reaches extractDocumentText's
    // `sourcePageCount < 1` guard — PDF.js sees a real, valid single blank
    // page, and that page correctly reports no extractable text rather
    // than fabricating any, exactly like the scanned/image-only case
    // above.
    const bytes = await buildEmptyPdfBytes();
    const result = await extractDocumentText(toFile(bytes));

    expect(result.sourcePageCount).toBe(1);
    expect(result.pages).toHaveLength(1);
    expect(result.pages[0].hasExtractableText).toBe(false);
    expect(result.pages[0].text).toBe("");
  });

  it("gives a clear, non-internal error for a malformed/corrupt PDF", async () => {
    const bytes = await buildMalformedPdfBytes();

    await expect(extractDocumentText(toFile(bytes))).rejects.toThrow(
      /could not be read as a PDF/,
    );
  });

  it("does not invoke or depend on any AI provider (no network primitives used)", async () => {
    const bytes = await buildTextVectorPdfBytes(1);
    const originalFetch = globalThis.fetch;
    let fetchCalled = false;

    globalThis.fetch = (...args: Parameters<typeof fetch>) => {
      fetchCalled = true;
      return originalFetch(...args);
    };

    try {
      await extractDocumentText(toFile(bytes));
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(fetchCalled).toBe(false);
  });
});
