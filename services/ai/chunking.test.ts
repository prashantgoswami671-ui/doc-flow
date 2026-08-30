import { describe, expect, it } from "vitest";
import { applyTotalCharacterBudget, chunkPageTexts } from "./chunking";
import type { PageTextResult } from "./extraction";

function page(pageNumber: number, text: string): PageTextResult {
  return { pageNumber, text, hasExtractableText: text.length > 0 };
}

describe("chunkPageTexts", () => {
  it("produces one chunk per page when text fits within the chunk size", () => {
    const result = chunkPageTexts([page(1, "hello"), page(2, "world")], {
      maxChunkCharacters: 100,
    });

    expect(result.chunks).toHaveLength(2);
    expect(result.chunks[0]).toMatchObject({
      chunkIndex: 0,
      pageNumber: 1,
      text: "hello",
      startOffset: 0,
      endOffset: 5,
    });
    expect(result.chunks[1]).toMatchObject({
      chunkIndex: 1,
      pageNumber: 2,
      text: "world",
      startOffset: 0,
      endOffset: 5,
    });
    expect(result.truncated).toBe(false);
    expect(result.totalCharacters).toBe(10);
  });

  it("splits a single page's text across multiple bounded chunks, preserving order and offsets", () => {
    const text = "a".repeat(25);
    const result = chunkPageTexts([page(1, text)], { maxChunkCharacters: 10 });

    expect(result.chunks).toHaveLength(3);
    expect(result.chunks.map((c) => c.text.length)).toEqual([10, 10, 5]);
    expect(result.chunks.map((c) => c.chunkIndex)).toEqual([0, 1, 2]);
    expect(result.chunks.map((c) => c.pageNumber)).toEqual([1, 1, 1]);
    expect(result.chunks[1].startOffset).toBe(10);
    expect(result.chunks[1].endOffset).toBe(20);
  });

  it("skips pages with no extractable text without producing empty chunks", () => {
    const result = chunkPageTexts([page(1, ""), page(2, "content")]);

    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0].pageNumber).toBe(2);
  });

  it("enforces the chunk-count limit and reports truncation", () => {
    const pages = [page(1, "a".repeat(30)), page(2, "b".repeat(30))];
    const result = chunkPageTexts(pages, { maxChunkCharacters: 10, maxChunks: 4 });

    expect(result.chunks).toHaveLength(4);
    expect(result.truncated).toBe(true);
    // Truncation happens mid page 2 — page 1 is fully represented first.
    expect(result.chunks.filter((c) => c.pageNumber === 1)).toHaveLength(3);
  });

  it("returns no chunks and is not truncated for an all-empty document", () => {
    const result = chunkPageTexts([page(1, ""), page(2, "")]);

    expect(result.chunks).toEqual([]);
    expect(result.truncated).toBe(false);
    expect(result.totalCharacters).toBe(0);
  });

  it("rejects a non-positive maxChunkCharacters or maxChunks", () => {
    expect(() => chunkPageTexts([], { maxChunkCharacters: 0 })).toThrow();
    expect(() => chunkPageTexts([], { maxChunks: -1 })).toThrow();
  });
});

describe("applyTotalCharacterBudget", () => {
  it("keeps every chunk when under budget", () => {
    const chunks = chunkPageTexts([page(1, "hello"), page(2, "world")]).chunks;
    const result = applyTotalCharacterBudget(chunks, 1000);

    expect(result.chunks).toHaveLength(2);
    expect(result.truncated).toBe(false);
    expect(result.totalCharacters).toBe(10);
  });

  it("drops trailing chunks once the budget would be exceeded, without splitting a chunk", () => {
    const chunks = chunkPageTexts([page(1, "aaaaa"), page(2, "bbbbb"), page(3, "ccccc")]).chunks;
    const result = applyTotalCharacterBudget(chunks, 8);

    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0].text).toBe("aaaaa");
    expect(result.truncated).toBe(true);
    expect(result.totalCharacters).toBe(5);
  });

  it("rejects a non-positive maxTotalCharacters", () => {
    expect(() => applyTotalCharacterBudget([], 0)).toThrow();
  });
});
