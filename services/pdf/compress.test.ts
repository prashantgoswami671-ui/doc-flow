import { describe, expect, it, vi, beforeEach } from "vitest";
import { PDFDocument } from "pdf-lib";
import { compressPDF } from "./compress";
import {
  buildEmptyPdfBytes,
  buildEncryptedPdfBytes,
  buildHighResScanPdfBytes,
  buildImageHeavyPdfBytes,
  buildMalformedPdfBytes,
  buildMixedOrientationPdfBytes,
  buildMixedPdfBytes,
  buildScannedImageOnlyPdfBytes,
  buildTextVectorPdfBytes,
  buildUnusualPageSizePdfBytes,
  ENCRYPTED_FIXTURE_PASSWORD,
  toFile,
} from "./__fixtures__/pdf";

/*
 * Phase 3.1 — compression baseline tests.
 *
 * These tests deliberately do NOT exercise the real browser rasterizer
 * (PDF.js + canvas). That path needs a real DOM/canvas and is verified
 * separately via the browser checklist in
 * docs/PHASE_3_1_COMPRESSION_BASELINE.md. Instead, the rasterization
 * boundary (rasterizePDF / rasterizePDFWithSettings) is mocked, and
 * everything compress.ts itself is responsible for — mode branching,
 * fallback-to-original thresholds, the custom-target binary search,
 * source-load/encryption/corruption error handling, and result-object
 * shape — is tested directly against real PDFs built with pdf-lib.
 *
 * IMPORTANT: per the Phase 3.1 rule, no test in this file modifies
 * compress.ts/rasterize.ts to make itself pass. Any surprising behavior
 * found here (e.g. zero-page handling, exact custom-target guarantees) is
 * recorded as a baseline finding in the report, not "fixed".
 */

vi.mock("./rasterize", () => ({
  rasterizePDF: vi.fn(),
  rasterizePDFWithSettings: vi.fn(),
}));

import { rasterizePDF, rasterizePDFWithSettings } from "./rasterize";

const mockRasterizePDF = vi.mocked(rasterizePDF);
const mockRasterizePDFWithSettings = vi.mocked(rasterizePDFWithSettings);

beforeEach(() => {
  mockRasterizePDF.mockReset();
  mockRasterizePDFWithSettings.mockReset();
});

/** A real, valid, small PDF with `pageCount` blank pages — stands in for
 * "rasterizer produced a smaller, valid PDF" without needing canvas/PDF.js.
 *
 * IMPORTANT: The output must fall strictly between 60% and 100% of the
 * source size to avoid triggering Light compression's fallback logic:
 * - output >= original → original bytes returned
 * - output < 60% of original → original bytes returned (suspiciously small)
 *
 * To land inside that window deterministically, this grows the PDF via
 * the real `setSubject()` pdf-lib API (never raw byte padding after
 * %%EOF) and measures the actual saved size at each step. It first
 * estimates the bytes-per-character cost from two real saves, jumps
 * near the target, then fine-tunes one character at a time — a coarse
 * fixed-size jump (the previous approach) can skip over a narrow
 * window entirely and land at or above the original size, which is
 * exactly what was causing this test's flakiness.
 */
async function buildSmallerValidPdf(pageCount: number, sourceBytes?: Uint8Array): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();

  for (let index = 0; index < Math.max(pageCount, 0); index++) {
    pdf.addPage([200, 260]);
  }

  // Save without compressed object streams: this keeps the Subject
  // metadata used for padding below as literal, uncompressed bytes in
  // the file, so growing it by N characters reliably grows the output
  // by ~N bytes. pdf-lib's default (useObjectStreams: true) stores the
  // Subject string inside a *compressed* object stream, and a string of
  // a single repeated character ('x') compresses extremely well under
  // deflate — so the compressed size barely moves as the character
  // count grows, or jumps unpredictably at compression-block boundaries.
  // That was the actual cause of this test's flakiness (a predicted
  // character count that should have landed in the 60%-to-100% window
  // instead produced output at/above the original size) and of the
  // multi-second/timeout slowness (saving very long strings still costs
  // real compression time even when the compressed output barely grows).
  const saveOptions = { useObjectStreams: false } as const;

  const output = await pdf.save(saveOptions);

  if (!sourceBytes) {
    return output;
  }

  const targetMin = Math.ceil(sourceBytes.length * 0.6);
  const targetMax = sourceBytes.length - 1;

  if (output.length >= targetMin && output.length <= targetMax) {
    return output;
  }

  if (targetMin > targetMax) {
    // Source is too small for a valid 60%-to-100% window to exist at
    // all; return the best-effort output and let compressPDF's own
    // fallback thresholds decide the outcome.
    return output;
  }

  const sizeWithSubjectLength = async (n: number): Promise<Uint8Array> => {
    pdf.setSubject(n > 0 ? "x".repeat(n) : "");

    return pdf.save(saveOptions);
  };

  // With object streams disabled, growth is ~1 byte per character, so a
  // small probe is enough to estimate it precisely.
  const baseLength = output.length;
  const probeChars = 64;
  const probeLength = (await sizeWithSubjectLength(probeChars)).length;
  const bytesPerChar = (probeLength - baseLength) / probeChars || 1;

  let n = Math.max(0, Math.round((targetMin - baseLength) / bytesPerChar));
  let candidate = await sizeWithSubjectLength(n);

  // Fine-tune one character at a time until the actual measured size
  // falls inside the window. Bounded low (50) since growth is now
  // reliably ~1:1 — if this doesn't converge quickly, something else
  // is wrong and we want a fast failure, not a multi-second stall.
  let guard = 0;

  while (
    (candidate.length < targetMin || candidate.length > targetMax) &&
    guard < 50
  ) {
    if (candidate.length < targetMin) {
      n += 1;
    } else if (n > 0) {
      n -= 1;
    } else {
      break;
    }

    candidate = await sizeWithSubjectLength(n);
    guard += 1;
  }

  return candidate;
}

async function loadPageCount(bytes: Uint8Array): Promise<number> {
  const pdf = await PDFDocument.load(bytes);

  return pdf.getPageCount();
}

describe("compressPDF — light compression", () => {
  it("returns smaller, valid output and preserves original page count", async () => {
    const sourceBytes = await buildTextVectorPdfBytes(3);
    const smallerOutput = await buildSmallerValidPdf(3, sourceBytes);

    mockRasterizePDF.mockResolvedValue(smallerOutput);

    const file = toFile(sourceBytes);
    const result = await compressPDF(file, "light");

    expect(mockRasterizePDF).toHaveBeenCalledWith(file, "light");
    expect(result.mode).toBe("light");
    expect(result.pageCount).toBe(3);
    expect(result.processedSize).toBeLessThan(result.originalSize);
    expect(result.reductionPercent).toBeGreaterThan(0);

    // Output must itself be a valid, loadable PDF.
    await expect(loadPageCount(result.bytes)).resolves.toBe(3);
  });

  it("falls back to the original bytes when raster output is not smaller than the original", async () => {
    const sourceBytes = await buildTextVectorPdfBytes(2);
    // Deliberately at-or-above original size.
    mockRasterizePDF.mockResolvedValue(
      new Uint8Array(sourceBytes.length + 500),
    );

    const result = await compressPDF(toFile(sourceBytes), "light");

    expect(result.processedSize).toBe(result.originalSize);
    expect(result.reductionPercent).toBe(0);
    expect(result.bytes).toEqual(sourceBytes);
  });

  it("falls back to the original bytes when raster output is suspiciously small (<60% of original)", async () => {
    const sourceBytes = await buildTextVectorPdfBytes(2);
    const tooSmall = new Uint8Array(Math.floor(sourceBytes.length * 0.5));
    mockRasterizePDF.mockResolvedValue(tooSmall);

    const result = await compressPDF(toFile(sourceBytes), "light");

    expect(result.processedSize).toBe(result.originalSize);
    expect(result.bytes).toEqual(sourceBytes);
  });
});

describe("compressPDF — heavy compression", () => {
  it("returns smaller, valid output and preserves original page count", async () => {
    const sourceBytes = await buildImageHeavyPdfBytes(2);
    const smallerOutput = await buildSmallerValidPdf(2, sourceBytes);
    mockRasterizePDF.mockResolvedValue(smallerOutput);

    const file = toFile(sourceBytes);
    const result = await compressPDF(file, "heavy");

    expect(mockRasterizePDF).toHaveBeenCalledWith(file, "heavy");
    expect(result.mode).toBe("heavy");
    expect(result.pageCount).toBe(2);
    expect(result.processedSize).toBeLessThan(result.originalSize);
  });

  it("accepts raster output below the 60% floor that Light rejects (no floor check for Heavy)", async () => {
    const sourceBytes = await buildImageHeavyPdfBytes(2);
    const veryCompressed = new Uint8Array(
      Math.floor(sourceBytes.length * 0.1),
    );
    mockRasterizePDF.mockResolvedValue(veryCompressed);

    const result = await compressPDF(toFile(sourceBytes), "heavy");

    // Baseline finding: Heavy has no lower-bound sanity check like Light's.
    expect(result.processedSize).toBe(veryCompressed.length);
    expect(result.processedSize).toBeLessThan(result.originalSize);
  });

  it("falls back to the original bytes when raster output is not smaller than the original", async () => {
    const sourceBytes = await buildImageHeavyPdfBytes(1);
    mockRasterizePDF.mockResolvedValue(
      new Uint8Array(sourceBytes.length + 100),
    );

    const result = await compressPDF(toFile(sourceBytes), "heavy");

    expect(result.bytes).toEqual(sourceBytes);
    expect(result.reductionPercent).toBe(0);
  });
});

describe("compressPDF — custom compression: target above/at original size", () => {
  it("returns the original bytes unchanged and never calls the rasterizer when target > original size", async () => {
    const sourceBytes = await buildTextVectorPdfBytes(2);
    const file = toFile(sourceBytes);
    const hugeTargetMb = (sourceBytes.length * 10) / (1024 * 1024);

    const result = await compressPDF(file, "custom", hugeTargetMb);

    expect(mockRasterizePDFWithSettings).not.toHaveBeenCalled();
    expect(result.bytes).toEqual(sourceBytes);
    expect(result.reductionPercent).toBe(0);
  });

  it("returns the original bytes unchanged when target size == original size", async () => {
    const sourceBytes = await buildTextVectorPdfBytes(1);
    const file = toFile(sourceBytes);
    const exactTargetMb = sourceBytes.length / (1024 * 1024);

    const result = await compressPDF(file, "custom", exactTargetMb);

    expect(mockRasterizePDFWithSettings).not.toHaveBeenCalled();
    expect(result.bytes).toEqual(sourceBytes);
  });

  it("preserves exact original page dimensions and rotation on the target>=original identity path", async () => {
    const sourceBytes = await buildMixedOrientationPdfBytes();
    const file = toFile(sourceBytes);
    const hugeTargetMb = (sourceBytes.length * 10) / (1024 * 1024);

    const result = await compressPDF(file, "custom", hugeTargetMb);

    const original = await PDFDocument.load(sourceBytes);
    const output = await PDFDocument.load(result.bytes);

    expect(output.getPageCount()).toBe(original.getPageCount());

    original.getPages().forEach((originalPage, index) => {
      const outputPage = output.getPages()[index];
      expect(outputPage.getRotation().angle).toBe(
        originalPage.getRotation().angle,
      );
      expect(outputPage.getSize()).toEqual(originalPage.getSize());
    });
  });
});

describe("compressPDF — custom compression: target below original size", () => {
  it("converges via binary search to output at or under the target when reachable", async () => {
    const sourceBytes = await buildImageHeavyPdfBytes(2);
    const file = toFile(sourceBytes);
    const targetBytes = Math.floor(sourceBytes.length * 0.4);
    const targetMb = targetBytes / (1024 * 1024);

    // Simulated raster output: size shrinks monotonically as quality level
    // (0..1) decreases, same shape as the real scale/quality search space.
    mockRasterizePDFWithSettings.mockImplementation(async (_file, settings) => {
      const level =
        (settings.scale - 0.75) / (2.0 - 0.75); // invert getCustomSettings' scale formula
      const size = Math.round(
        sourceBytes.length * 0.15 + sourceBytes.length * 0.7 * level,
      );

      return new Uint8Array(size);
    });

    const result = await compressPDF(file, "custom", targetMb);

    expect(mockRasterizePDFWithSettings).toHaveBeenCalled();
    expect(result.processedSize).toBeLessThanOrEqual(targetBytes);
    expect(result.processedSize).toBeLessThan(result.originalSize);
  });

  it("falls back to the smallest practical output when the target cannot be reached at any quality level", async () => {
    const sourceBytes = await buildImageHeavyPdfBytes(2);
    const file = toFile(sourceBytes);
    const unreachableTargetMb =
      Math.floor(sourceBytes.length * 0.05) / (1024 * 1024);

    // Even the lowest-quality candidate stays above target, but still
    // below the original size — this is the "target not reached" /
    // "fallback behavior" path, not the "no reduction possible" path.
    const smallestPractical = new Uint8Array(
      Math.floor(sourceBytes.length * 0.3),
    );
    mockRasterizePDFWithSettings.mockResolvedValue(smallestPractical);

    const result = await compressPDF(file, "custom", unreachableTargetMb);

    expect(result.processedSize).toBe(smallestPractical.length);
    expect(result.processedSize).toBeGreaterThan(
      Math.floor(sourceBytes.length * 0.05),
    );
    // Baseline finding: Custom does NOT guarantee hitting the requested
    // target — it falls back to the smallest size it found.
  });

  it("falls back to the original bytes when no candidate ever beats the original size", async () => {
    const sourceBytes = await buildImageHeavyPdfBytes(1);
    const file = toFile(sourceBytes);
    const targetMb = Math.floor(sourceBytes.length * 0.5) / (1024 * 1024);

    // Every candidate — including the "highest quality" one — is larger
    // than the original, so compress.ts has nothing to prefer over it.
    mockRasterizePDFWithSettings.mockResolvedValue(
      new Uint8Array(sourceBytes.length + 1000),
    );

    const result = await compressPDF(file, "custom", targetMb);

    expect(result.bytes).toEqual(sourceBytes);
  });

  it("returns output larger than target but still smaller than original as a documented fallback, not an error", async () => {
    const sourceBytes = await buildImageHeavyPdfBytes(1);
    const file = toFile(sourceBytes);
    const targetMb = Math.floor(sourceBytes.length * 0.1) / (1024 * 1024);

    mockRasterizePDFWithSettings.mockResolvedValue(
      new Uint8Array(Math.floor(sourceBytes.length * 0.6)),
    );

    const result = await compressPDF(file, "custom", targetMb);

    expect(result.processedSize).toBeGreaterThan(
      Math.floor(sourceBytes.length * 0.1),
    );
    expect(result.processedSize).toBeLessThan(result.originalSize);
  });
});

describe("compressPDF — custom compression: invalid targets", () => {
  it.each([
    ["undefined", undefined],
    ["zero", 0],
    ["negative", -5],
    ["NaN", Number.NaN],
  ])("rejects a %s target size", async (_label, target) => {
    const sourceBytes = await buildTextVectorPdfBytes(1);
    const file = toFile(sourceBytes);

    await expect(compressPDF(file, "custom", target)).rejects.toThrow(
      "A positive custom target size is required.",
    );
    expect(mockRasterizePDFWithSettings).not.toHaveBeenCalled();
  });
});

describe("compressPDF — malformed/corrupt PDF", () => {
  it("rejects with a clear, user-facing error and never calls the rasterizer", async () => {
    const malformedBytes = await buildMalformedPdfBytes();
    const file = toFile(malformedBytes);

    await expect(compressPDF(file, "light")).rejects.toThrow(
      /could not be read as a PDF/,
    );
    expect(mockRasterizePDF).not.toHaveBeenCalled();
  });
});

describe("compressPDF — encrypted/password-protected PDF", () => {
  it("rejects with a password-protected-specific error via plain pdf-lib's load failure", async () => {
    const encryptedBytes = await buildEncryptedPdfBytes();
    const file = toFile(encryptedBytes);

    // Sanity check on the fixture itself: plain pdf-lib (what compress.ts
    // loads with) cannot read this without a password.
    await expect(PDFDocument.load(encryptedBytes)).rejects.toThrow();

    await expect(compressPDF(file, "light")).rejects.toThrow(
      /password protected/i,
    );
    expect(mockRasterizePDF).not.toHaveBeenCalled();
  });

  it("documents the fixture's password for anyone extending this test (not asserted, just recorded)", () => {
    expect(ENCRYPTED_FIXTURE_PASSWORD).toBe("phase3-fixture-pass");
  });
});

describe("compressPDF — empty PDF (zero pages)", () => {
  it("measures actual light-compression behavior on a zero-page source", async () => {
    const emptyBytes = await buildEmptyPdfBytes();
    const file = toFile(emptyBytes);
    const emptyRasterOutput = await buildSmallerValidPdf(0, emptyBytes);
    mockRasterizePDF.mockResolvedValue(emptyRasterOutput);

    // Baseline finding, measured rather than assumed: pdf-lib reports 1 page
    // for an "empty" PDF (PDFDocument.create() with no addPage() calls),
    // so compressPDF reports 1 page regardless of the intent.
    const result = await compressPDF(file, "light");

    expect(result.pageCount).toBe(1);
  });

  it("measures actual custom-compression behavior on a zero-page source (target above the tiny original size)", async () => {
    const emptyBytes = await buildEmptyPdfBytes();
    const file = toFile(emptyBytes);
    const targetMb = (emptyBytes.length + 1) / (1024 * 1024);

    const result = await compressPDF(file, "custom", targetMb);

    // Baseline finding: pdf-lib reports 1 page for an "empty" PDF
    expect(result.pageCount).toBe(1);
    expect(mockRasterizePDFWithSettings).not.toHaveBeenCalled();
    expect(result.bytes).toEqual(emptyBytes);
  });
});

describe("compressPDF — fixture coverage: mixed, scan, unusual page sizes, high-res", () => {
  it.each([
    ["mixed content", buildMixedPdfBytes, 3],
    ["scanned/image-only", () => buildScannedImageOnlyPdfBytes(2), 2],
    ["unusual page sizes", buildUnusualPageSizePdfBytes, 3],
    ["high-resolution scan", buildHighResScanPdfBytes, 1],
  ] as const)(
    "light mode preserves page count and produces a valid PDF for a %s fixture",
    async (_label, buildFixture, expectedPageCount) => {
      const sourceBytes = await buildFixture();
      const smallerOutput = await buildSmallerValidPdf(expectedPageCount, sourceBytes);
      mockRasterizePDF.mockResolvedValue(smallerOutput);

      const result = await compressPDF(toFile(sourceBytes), "light");

      expect(result.pageCount).toBe(expectedPageCount);
      await expect(loadPageCount(result.bytes)).resolves.toBe(
        expectedPageCount,
      );
    },
  );
});

describe("compressPDF — result shape / measurement fields", () => {
  it("reports originalSize from file.size and a non-negative processingTime for every mode", async () => {
    const sourceBytes = await buildTextVectorPdfBytes(1);
    mockRasterizePDF.mockResolvedValue(await buildSmallerValidPdf(1, sourceBytes));

    const result = await compressPDF(toFile(sourceBytes), "light");

    expect(result.originalSize).toBe(sourceBytes.length);
    expect(result.processingTime).toBeGreaterThanOrEqual(0);
  });

  it("computes reductionPercent as (original - processed) / original * 100", async () => {
    const sourceBytes = await buildTextVectorPdfBytes(1);
    const smaller = new Uint8Array(Math.floor(sourceBytes.length * 0.5));
    mockRasterizePDF.mockResolvedValue(smaller);

    const result = await compressPDF(toFile(sourceBytes), "heavy");

    const expected =
      ((result.originalSize - result.processedSize) / result.originalSize) *
      100;
    expect(result.reductionPercent).toBeCloseTo(expected, 5);
  });
});
