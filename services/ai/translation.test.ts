import { describe, expect, it, vi } from "vitest";
import {
  SUPPORTED_TRANSLATION_LANGUAGES,
  assertTranslationLanguage,
  isTranslationLanguage,
  translatePdf,
} from "./translation";
import { buildAiTextContext } from "./pipeline";

vi.mock("./pipeline", () => ({
  buildAiTextContext: vi.fn(async () => ({
    chunks: [
      { chunkIndex: 0, pageNumber: 1, startOffset: 0, endOffset: 5, text: "hello" },
      { chunkIndex: 1, pageNumber: 2, startOffset: 0, endOffset: 5, text: "world" },
    ],
    sourcePageCount: 3,
    pagesWithoutText: [3],
    truncated: false,
  })),
}));

function runtime(response = "translated") {
  return {
    capabilities: {
      providerId: "test",
      displayName: "Test",
      runtime: "browser" as const,
      isLocal: true,
      requiresConsent: false,
      supportsStreaming: false,
      supportsToolCalling: false,
      supportsTextGeneration: true,
      maxContextCharacters: 8192,
      maxOutputCharacters: 1024,
    },
    checkAvailability: vi.fn(),
    generateText: vi.fn(async ({ contextChunks }: { contextChunks?: { text: string }[] }) => ({
      text: `${response}:${contextChunks?.[0]?.text}`,
      providerId: "test",
      runtime: "browser" as const,
    })),
  };
}

describe("translation", () => {
  it("exposes and validates exactly the supported languages", () => {
    expect(SUPPORTED_TRANSLATION_LANGUAGES).toHaveLength(20);
    for (const language of SUPPORTED_TRANSLATION_LANGUAGES) {
      expect(isTranslationLanguage(language)).toBe(true);
      expect(() => assertTranslationLanguage(language)).not.toThrow();
    }
    expect(isTranslationLanguage("Klingon")).toBe(false);
    expect(() => assertTranslationLanguage("")).toThrow();
    expect(() => assertTranslationLanguage(" Spanish ")).toThrow();
  });

  it("translates chunks sequentially and preserves source metadata", async () => {
    const fake = runtime();
    const result = await translatePdf({
      file: new File(["pdf"], "test.pdf", { type: "application/pdf" }),
      targetLanguage: "Spanish",
      runtime: fake,
    });

    expect(fake.generateText).toHaveBeenCalledTimes(2);
    expect(result.status).toBe("ready");
    expect(result.chunks.map((chunk) => chunk.pageNumber)).toEqual([1, 2]);
    expect(result.chunks.every((chunk) => chunk.status === "translated")).toBe(true);
    expect(result.pagesWithoutText).toEqual([3]);
  });

  it("retains isolated failures and continues", async () => {
    const fake = runtime();
    fake.generateText
      .mockRejectedValueOnce(new Error("first failed"))
      .mockResolvedValueOnce({ text: "ok", providerId: "test", runtime: "browser" });

    const result = await translatePdf({
      file: new File(["pdf"], "test.pdf", { type: "application/pdf" }),
      targetLanguage: "Hindi",
      runtime: fake,
    });

    expect(result.chunks.map((chunk) => chunk.status)).toEqual(["failed", "translated"]);
    expect(result.status).toBe("partial");
    expect(result.failedChunkIndexes).toEqual([0]);
  });

  it("classifies provider failure before the first chunk", async () => {
    const fake = runtime();
    const error = new Error("Browser AI is unavailable.");
    error.name = "AiRuntimeUnavailableError";
    fake.generateText.mockRejectedValueOnce(error);

    const result = await translatePdf({
      file: new File(["pdf"], "test.pdf", { type: "application/pdf" }),
      targetLanguage: "Hindi",
      runtime: fake,
    });

    expect(result.status).toBe("provider-failed");
    expect(result.providerError).toContain("unavailable");
    expect(result.chunks).toHaveLength(0);
    expect(fake.generateText).toHaveBeenCalledTimes(1);
  });

  it("preserves completed chunks while classifying a later provider failure", async () => {
    const fake = runtime();
    const error = new Error("Ollama is unavailable.");
    error.name = "OllamaClientError";
    fake.generateText
      .mockResolvedValueOnce({ text: "first", providerId: "test", runtime: "browser" })
      .mockRejectedValueOnce(error);

    const result = await translatePdf({
      file: new File(["pdf"], "test.pdf", { type: "application/pdf" }),
      targetLanguage: "Hindi",
      runtime: fake,
    });

    expect(result.status).toBe("provider-failed");
    expect(result.chunks.map((chunk) => chunk.status)).toEqual(["translated"]);
    expect(result.providerError).toContain("unavailable");
  });

  it("marks an entirely image-only document as no-text", async () => {
    vi.mocked(buildAiTextContext).mockResolvedValueOnce({
      chunks: [],
      sourcePageCount: 2,
      pagesWithoutText: [1, 2],
      truncated: false,
      totalCharacters: 0,
      processingTime: 1,
    });

    const fake = runtime();
    const result = await translatePdf({
      file: new File(["pdf"], "scan.pdf", { type: "application/pdf" }),
      targetLanguage: "English",
      runtime: fake,
    });

    expect(result.status).toBe("no-text");
    expect(result.pagesWithoutText).toEqual([1, 2]);
    expect(fake.generateText).not.toHaveBeenCalled();
  });

  it("fails closed for suspicious Browser AI output below the rough boundary", async () => {
    const fake = runtime();
    fake.capabilities.providerId = "browser-ai";
    fake.generateText.mockResolvedValue({
      text: "partial translation,",
      providerId: "test",
      runtime: "browser",
    });

    const result = await translatePdf({
      file: new File(["pdf"], "test.pdf", { type: "application/pdf" }),
      targetLanguage: "Spanish",
      runtime: fake,
    });

    expect(result.chunks[0].status).toBe("truncated");
    expect(result.status).toBe("partial");
  });

  it("accepts a valid short Browser AI translation", async () => {
    const fake = runtime("Traducción completa.");
    fake.capabilities.providerId = "browser-ai";

    const result = await translatePdf({
      file: new File(["pdf"], "test.pdf", { type: "application/pdf" }),
      targetLanguage: "Spanish",
      runtime: fake,
    });

    expect(result.chunks.every((chunk) => chunk.status === "translated")).toBe(true);
    expect(result.status).toBe("ready");
  });

  it("marks output at the advertised boundary as truncated", async () => {
    const fake = runtime("x".repeat(1024));
    fake.capabilities.providerId = "browser-ai";

    const result = await translatePdf({
      file: new File(["pdf"], "test.pdf", { type: "application/pdf" }),
      targetLanguage: "Spanish",
      runtime: fake,
    });

    expect(result.chunks[0].status).toBe("truncated");
  });

  it("stops new work after cancellation", async () => {
    const fake = runtime();
    let cancelled = false;
    const result = await translatePdf({
      file: new File(["pdf"], "test.pdf", { type: "application/pdf" }),
      targetLanguage: "French",
      runtime: fake,
      isCancellationRequested: () => cancelled,
      onProgress: (completed) => {
        if (completed === 1) cancelled = true;
      },
    });

    expect(result.cancelled).toBe(true);
    expect(fake.generateText).toHaveBeenCalledTimes(1);
    expect(result.chunks.map((chunk) => chunk.status)).toEqual(["translated", "cancelled"]);
  });
});
