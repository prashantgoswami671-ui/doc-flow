import { describe, expect, it } from "vitest";
import { PDFDocument, PDFRef } from "pdf-lib";
import { applyPageRotations, rotatePDF } from "./rotate";
import { detectDuplicateGenerationObjects } from "./shared";

async function buildNormalPdfBytes(pageCount = 4): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();

  for (let index = 0; index < pageCount; index++) {
    const page = pdf.addPage([300, 400]);
    page.drawText(`Page ${index + 1}`, { x: 50, y: 350 });
  }

  return pdf.save();
}

/**
 * Same construction as services/pdf/shared.test.ts: duplicates one indirect
 * object at a bumped generation number to reproduce the real
 * same-object-number/different-generation-number corruption condition
 * (e.g. C2PA/Content-Credentials-style incremental updates), via pdf-lib's
 * own object graph rather than hand-crafted bytes.
 */
async function buildDuplicateGenerationPdfBytes(
  pageCount = 4,
): Promise<Uint8Array> {
  const baseBytes = await buildNormalPdfBytes(pageCount);
  const pdf = await PDFDocument.load(baseBytes);
  const context = pdf.context;

  const [[firstRef, firstObj]] = context.enumerateIndirectObjects();
  const duplicateRef = PDFRef.of(
    firstRef.objectNumber,
    firstRef.generationNumber + 1,
  );

  context.assign(duplicateRef, firstObj.clone(context));

  return pdf.save();
}

function toFile(bytes: Uint8Array, name = "test.pdf"): File {
  return new File([bytes as BlobPart], name, { type: "application/pdf" });
}

describe("rotatePDF — normal PDFs (existing direct path)", () => {
  it.each([90, 180, 270] as const)(
    "rotates every page by %s° and preserves page count",
    async (rotation) => {
      const bytes = await buildNormalPdfBytes(3);
      const file = toFile(bytes);

      const result = await rotatePDF(file, rotation);

      expect(result.pageCount).toBe(3);
      expect(result.requestedRotation).toBe(rotation);

      const saved = await PDFDocument.load(result.bytes);
      for (const page of saved.getPages()) {
        expect(page.getRotation().angle).toBe(rotation);
      }
    },
  );

  it("rejects unsupported rotation values", async () => {
    const bytes = await buildNormalPdfBytes(1);
    const file = toFile(bytes);

    // @ts-expect-error intentionally invalid at the runtime boundary
    await expect(rotatePDF(file, 45)).rejects.toThrow(
      "Rotation must be 90, 180, or 270 degrees.",
    );
  });

  it("applies mixed rotations to explicitly selected pages via applyPageRotations", async () => {
    const bytes = await buildNormalPdfBytes(3);
    const file = toFile(bytes);

    const result = await applyPageRotations(file, [
      { pageNumber: 1, rotation: 90 },
      { pageNumber: 3, rotation: 270 },
    ]);

    expect(result.pageCount).toBe(3);

    const saved = await PDFDocument.load(result.bytes);
    const pages = saved.getPages();
    expect(pages[0].getRotation().angle).toBe(90);
    expect(pages[1].getRotation().angle).toBe(0);
    expect(pages[2].getRotation().angle).toBe(270);
  });
});

describe("rotatePDF — PDFs with duplicate-generation objects (safe rebuild path)", () => {
  it("produces a valid, strictly-loadable PDF instead of corrupting /Root", async () => {
    const bytes = await buildDuplicateGenerationPdfBytes(3);
    const file = toFile(bytes);

    // Sanity: this fixture really does carry the corruption condition.
    const source = await PDFDocument.load(bytes);
    expect(detectDuplicateGenerationObjects(source).hasDuplicateGenerations).toBe(
      true,
    );

    const result = await rotatePDF(file, 90);

    expect(result.pageCount).toBe(3);

    // The output itself must not carry the corruption forward.
    const reloaded = await PDFDocument.load(result.bytes);
    expect(reloaded.getPageCount()).toBe(3);
    expect(
      detectDuplicateGenerationObjects(reloaded).hasDuplicateGenerations,
    ).toBe(false);

    for (const page of reloaded.getPages()) {
      expect(page.getRotation().angle).toBe(90);
    }
  });

  it("applies mixed per-page rotations correctly through the rebuild path", async () => {
    const bytes = await buildDuplicateGenerationPdfBytes(3);
    const file = toFile(bytes);

    const result = await applyPageRotations(file, [
      { pageNumber: 2, rotation: 180 },
    ]);

    expect(result.pageCount).toBe(3);

    const reloaded = await PDFDocument.load(result.bytes);
    const pages = reloaded.getPages();
    expect(pages[0].getRotation().angle).toBe(0);
    expect(pages[1].getRotation().angle).toBe(180);
    expect(pages[2].getRotation().angle).toBe(0);
  });
});

describe("rotatePDF — regression: functional parity for normal PDFs", () => {
  it("produces the same page count, order, and rotation behavior as before the fix", async () => {
    const bytes = await buildNormalPdfBytes(5);
    const file = toFile(bytes);

    const result = await rotatePDF(file, 180);
    const reloaded = await PDFDocument.load(result.bytes);

    expect(reloaded.getPageCount()).toBe(5);
    reloaded.getPages().forEach((page) => {
      expect(page.getRotation().angle).toBe(180);
    });
  });

  it("throws a clear error for unreadable/corrupted non-PDF input", async () => {
    // Existing error-handling path (loadRotateSourceOrThrow) must be
    // untouched by the duplicate-generation fix.
    const garbage = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const file = toFile(garbage);

    await expect(rotatePDF(file, 90)).rejects.toThrow(
      /could not be read as a PDF/,
    );
  });
});
