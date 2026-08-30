import { describe, expect, it } from "vitest";
import { buildAiTextContext } from "./pipeline";
import {
  buildScannedImageOnlyPdfBytes,
  buildTextVectorPdfBytes,
  toFile,
} from "../pdf/__fixtures__/pdf";

describe("buildAiTextContext", () => {
  it("produces bounded, page-aware chunks for a normal text PDF", async () => {
    const bytes = await buildTextVectorPdfBytes(2);
    const result = await buildAiTextContext(toFile(bytes));

    expect(result.sourcePageCount).toBe(2);
    expect(result.chunks.length).toBeGreaterThan(0);
    expect(result.chunks[0].pageNumber).toBe(1);
    expect(result.pagesWithoutText).toEqual([]);
    expect(result.truncated).toBe(false);
  });

  it("respects a small maxChunkCharacters/maxChunks override", async () => {
    const bytes = await buildTextVectorPdfBytes(1);
    const result = await buildAiTextContext(toFile(bytes), {
      maxChunkCharacters: 20,
      maxChunks: 2,
    });

    expect(result.chunks.length).toBeLessThanOrEqual(2);
    expect(result.chunks.every((chunk) => chunk.text.length <= 20)).toBe(true);
  });

  it("respects an explicit page scope", async () => {
    const bytes = await buildTextVectorPdfBytes(3);
    const result = await buildAiTextContext(toFile(bytes), { pageNumbers: [2] });

    expect(result.chunks.every((chunk) => chunk.pageNumber === 2)).toBe(true);
  });

  it("reports pages without extractable text instead of fabricating content", async () => {
    const bytes = await buildScannedImageOnlyPdfBytes(1);
    const result = await buildAiTextContext(toFile(bytes));

    expect(result.chunks).toEqual([]);
    expect(result.pagesWithoutText).toEqual([1]);
  });

  it("enforces the total-character budget across chunks", async () => {
    const bytes = await buildTextVectorPdfBytes(3);
    const result = await buildAiTextContext(toFile(bytes), {
      maxTotalCharacters: 10,
    });

    expect(result.totalCharacters).toBeLessThanOrEqual(10);
    expect(result.truncated).toBe(true);
  });
});
