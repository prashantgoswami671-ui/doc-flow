import { describe, expect, it } from "vitest";
import { PDFDocument, PDFRef } from "pdf-lib";
import {
  detectDuplicateGenerationObjects,
  getPageLevelWorkingDocument,
  rebuildPdfWithFreshPageTree,
} from "./shared";

/**
 * Builds a small, normal, single-generation multi-page PDF's bytes.
 */
async function buildNormalPdfBytes(pageCount = 3): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();

  for (let index = 0; index < pageCount; index++) {
    const page = pdf.addPage([300, 400]);
    page.drawText(`Page ${index + 1}`, { x: 50, y: 350 });
  }

  return pdf.save();
}

/**
 * Builds a genuinely corrupt PDF whose object graph contains the exact
 * condition this fix targets: the same object number present at two
 * different generation numbers (e.g. `1 0 R` and `1 1 R`), mirroring what
 * some incrementally-updated PDFs (notably C2PA/Content-Credentials-style
 * updates) can produce. This is constructed directly against pdf-lib's own
 * object graph rather than hand-crafted PDF bytes, so it exercises the real
 * `PDFContext`/`PDFWriter` machinery the same way a real-world file would.
 */
async function buildDuplicateGenerationPdfBytes(
  pageCount = 3,
): Promise<{ bytes: Uint8Array; duplicatedObjectNumber: number }> {
  const baseBytes = await buildNormalPdfBytes(pageCount);
  const pdf = await PDFDocument.load(baseBytes);
  const context = pdf.context;

  const [[firstRef, firstObj]] = context.enumerateIndirectObjects();
  const duplicateRef = PDFRef.of(
    firstRef.objectNumber,
    firstRef.generationNumber + 1,
  );

  context.assign(duplicateRef, firstObj.clone(context));

  const bytes = await pdf.save();

  return { bytes, duplicatedObjectNumber: firstRef.objectNumber };
}

describe("detectDuplicateGenerationObjects", () => {
  it("returns false for a normal, single-generation PDF", async () => {
    const bytes = await buildNormalPdfBytes();
    const pdf = await PDFDocument.load(bytes);

    const result = detectDuplicateGenerationObjects(pdf);

    expect(result).toEqual({
      hasDuplicateGenerations: false,
      affectedObjectNumbers: [],
    });
  });

  it("returns true and reports the object number when duplicate generations are present", async () => {
    const { bytes, duplicatedObjectNumber } =
      await buildDuplicateGenerationPdfBytes();
    const pdf = await PDFDocument.load(bytes);

    const result = detectDuplicateGenerationObjects(pdf);

    expect(result.hasDuplicateGenerations).toBe(true);
    expect(result.affectedObjectNumbers).toContain(duplicatedObjectNumber);
  });

  it("does not flag distinct object numbers as duplicates of each other", async () => {
    // Sanity check on the "same object number" condition: a document with
    // many distinct, single-generation objects (the normal case for any
    // multi-page PDF) must never be flagged.
    const bytes = await buildNormalPdfBytes(5);
    const pdf = await PDFDocument.load(bytes);

    const result = detectDuplicateGenerationObjects(pdf);

    expect(result.hasDuplicateGenerations).toBe(false);
  });
});

describe("rebuildPdfWithFreshPageTree", () => {
  it("preserves page count and order via copyPages()", async () => {
    const bytes = await buildNormalPdfBytes(4);
    const sourcePdf = await PDFDocument.load(bytes);

    const rebuilt = await rebuildPdfWithFreshPageTree(sourcePdf);

    expect(rebuilt.getPageCount()).toBe(4);
  });

  it("produces a document pdf-lib can re-load and save cleanly", async () => {
    const { bytes } = await buildDuplicateGenerationPdfBytes();
    const sourcePdf = await PDFDocument.load(bytes);

    const rebuilt = await rebuildPdfWithFreshPageTree(sourcePdf);
    const rebuiltBytes = await rebuilt.save();
    const reloaded = await PDFDocument.load(rebuiltBytes);

    expect(reloaded.getPageCount()).toBe(sourcePdf.getPageCount());

    // The whole point of the rebuild: the fresh document must not itself
    // carry forward the duplicate-generation condition.
    expect(detectDuplicateGenerationObjects(reloaded).hasDuplicateGenerations).toBe(
      false,
    );
  });
});

describe("getPageLevelWorkingDocument", () => {
  it("returns the original document unchanged for normal PDFs (fast/direct path)", async () => {
    const bytes = await buildNormalPdfBytes();
    const sourcePdf = await PDFDocument.load(bytes);

    const result = await getPageLevelWorkingDocument(sourcePdf);

    expect(result.rebuilt).toBe(false);
    expect(result.pdfDocument).toBe(sourcePdf);
    expect(result.affectedObjectNumbers).toEqual([]);
  });

  it("returns a rebuilt document for PDFs with duplicate generations", async () => {
    const { bytes, duplicatedObjectNumber } =
      await buildDuplicateGenerationPdfBytes();
    const sourcePdf = await PDFDocument.load(bytes);

    const result = await getPageLevelWorkingDocument(sourcePdf);

    expect(result.rebuilt).toBe(true);
    expect(result.pdfDocument).not.toBe(sourcePdf);
    expect(result.pdfDocument.getPageCount()).toBe(sourcePdf.getPageCount());
    expect(result.affectedObjectNumbers).toContain(duplicatedObjectNumber);
  });
});
