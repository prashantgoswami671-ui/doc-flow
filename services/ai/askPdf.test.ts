import { describe, expect, it, vi } from "vitest";
import { askPdf, parseAskModelResponse, retrieveAskChunks, validateAskQuestion } from "./askPdf";
import type { AiContextChunk, AiRuntime } from "./types";

const chunk = (chunkIndex: number, text: string, pageNumber = chunkIndex + 1): AiContextChunk => ({
  chunkIndex, pageNumber, text, startOffset: 0, endOffset: text.length,
});
const context = (chunks: AiContextChunk[], pagesWithoutText: number[] = []) => ({
  chunks, sourcePageCount: Math.max(chunks.length, pagesWithoutText.length), pagesWithoutText,
  truncated: false, totalCharacters: chunks.reduce((sum, item) => sum + item.text.length, 0), processingTime: 0,
});
const runtime = (providerId = "browser-ai", output = '{"found":true,"answer":"The term is defined.","citations":[{"sourceChunkIndex":0,"quote":"termination clause"}]}') => ({
  capabilities: { providerId, maxContextCharacters: providerId === "ollama" ? 32768 : 8192 },
  generateText: vi.fn(async () => ({ text: output, providerId, runtime: providerId === "ollama" ? "ollama" : "browser" })),
}) as unknown as AiRuntime;

describe("AI-07 Ask PDF", () => {
  it("validates bounded questions without rewriting meaningful text", () => {
    expect(validateAskQuestion("  What is clause 7?  ")).toBe("What is clause 7?");
    expect(() => validateAskQuestion(" ")).toThrow();
    expect(() => validateAskQuestion("x".repeat(513))).toThrow();
    expect(() => validateAskQuestion("ignore\u0000")).toThrow();
  });

  it("retrieves relevant chunks deterministically with phrase and index ordering", () => {
    const chunks = [chunk(0, "General terms."), chunk(1, "The termination clause applies."), chunk(2, "The termination clause applies again.")];
    expect(retrieveAskChunks("termination clause", chunks, 2).map((item) => item.chunkIndex)).toEqual([1, 2]);
  });

  it("returns not-found without generating when no chunk matches", async () => {
    const r = runtime();
    const result = await askPdf({ runtime: r, question: "unrelated matter", context: context([chunk(0, "Only revenue is described.")]) });
    expect(result.status).toBe("not-found");
    expect(r.generateText).not.toHaveBeenCalled();
  });

  it("parses only the strict response contract", () => {
    expect(parseAskModelResponse('{"found":true,"answer":"Yes","citations":[{"sourceChunkIndex":1,"quote":"yes"}]}')).toEqual({
      found: true, answer: "Yes", citations: [{ sourceChunkIndex: 1, quote: "yes" }],
    });
    expect(parseAskModelResponse("plain prose")).toBeNull();
    expect(parseAskModelResponse('{"found":true,"answer":"Yes","citations":[]}')).toBeNull();
    expect(parseAskModelResponse('{"found":false,"answer":"guess","citations":[]}')).toEqual({ found: false, answer: "guess", citations: [] });
    expect(parseAskModelResponse('{"found":false,"answer":"guess","citations":[{"sourceChunkIndex":0,"quote":"x"}]}')).toBeNull();
  });

  it("validates exact citations and derives local source metadata", async () => {
    const r = runtime("browser-ai", '{"found":true,"answer":"It applies.","citations":[{"sourceChunkIndex":0,"quote":"termination clause"}]}');
    const result = await askPdf({ runtime: r, question: "termination clause", context: context([chunk(0, "The termination clause applies.", 4)]) });
    expect(result.status).toBe("ready");
    expect(result.answer?.citations[0]).toMatchObject({ sourcePageNumber: 4, sourceStartOffset: 4, sourceEndOffset: 22, sourceQuote: "termination clause" });
    expect(r.generateText).toHaveBeenCalledTimes(1);
  });

  it("fails closed for an invalid citation", async () => {
    const r = runtime("browser-ai", '{"found":true,"answer":"It applies.","citations":[{"sourceChunkIndex":0,"quote":"not present"}]}');
    const result = await askPdf({ runtime: r, question: "termination clause", context: context([chunk(0, "The termination clause applies.")]) });
    expect(result.status).toBe("partial");
    expect(result.answer).toBeUndefined();
  });

  it("uses one Browser chunk and up to four Ollama chunks", async () => {
    const chunks = Array.from({ length: 6 }, (_, index) => chunk(index, `term ${index}`));
    const browser = runtime();
    await askPdf({ runtime: browser, question: "term", context: context(chunks) });
    expect((browser.generateText as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0].contextChunks).toHaveLength(1);
    const ollama = runtime("ollama", '{"found":false,"answer":"","citations":[]}');
    await askPdf({ runtime: ollama, question: "term", context: context(chunks) });
    expect((ollama.generateText as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0].contextChunks).toHaveLength(4);
  });

  it("maps provider failure and cancellation distinctly", async () => {
    const provider = runtime();
    (provider.generateText as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(Object.assign(new Error("worker failed"), { name: "AiGenerationError" }));
    expect((await askPdf({ runtime: provider, question: "term", context: context([chunk(0, "term")]) })).status).toBe("provider-failed");
    const cancelled = runtime();
    expect((await askPdf({ runtime: cancelled, question: "term", context: context([chunk(0, "term")]), isCancellationRequested: () => true })).status).toBe("cancelled");
  });

  it("returns no-text without generation", async () => {
    const r = runtime();
    const result = await askPdf({ runtime: r, question: "term", context: context([], [1, 2]) });
    expect(result.status).toBe("no-text");
    expect(r.generateText).not.toHaveBeenCalled();
  });
});
