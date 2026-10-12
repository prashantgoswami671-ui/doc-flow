import { describe, expect, it, vi } from "vitest";
import {
  SUPPORTED_TRANSLATION_LANGUAGES,
  TRANSLATION_MAX_OUTPUT_TOKENS,
  TRANSLATION_TEMPERATURE,
  assertTranslationLanguage,
  hasPathologicalRepetition,
  isTranslationLanguage,
  isUntranslatedEcho,
  lacksTargetScript,
  stripReasoningLeakage,
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
    generateText: vi.fn(
      async ({
        contextChunks,
      }: {
        contextChunks?: { text: string; pageNumber?: number }[];
        settings?: { temperature?: number; maxOutputTokens?: number };
      }): Promise<{
        text: string;
        providerId: string;
        runtime: "browser";
        outputTruncated?: boolean;
        contextTruncated?: boolean;
      }> => ({
        text: `${response}:${contextChunks?.[0]?.text}`,
        providerId: "test",
        runtime: "browser" as const,
      }),
    ),
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

  it("classifies AiGenerationError before the first chunk as provider-failed", async () => {
    const fake = runtime();
    const error = new Error("Browser generation failed.");
    error.name = "AiGenerationError";
    fake.generateText.mockRejectedValueOnce(error);

    const result = await translatePdf({
      file: new File(["pdf"], "test.pdf", { type: "application/pdf" }),
      targetLanguage: "Hindi",
      runtime: fake,
    });

    expect(result.status).toBe("provider-failed");
    expect(result.providerError).toContain("generation failed");
    expect(result.chunks).toHaveLength(0);
    expect(result.failedChunkIndexes).toEqual([]);
    expect(fake.generateText).toHaveBeenCalledTimes(1);
  });

  it("classifies AiGenerationError after one chunk while preserving completed chunks", async () => {
    const fake = runtime();
    const error = new Error("Worker generation failed.");
    error.name = "AiGenerationError";
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
    expect(result.chunks).toHaveLength(1);
    expect(result.providerError).toContain("generation failed");
    expect(result.failedChunkIndexes).toEqual([]);
  });

  it("keeps generic errors as partial failures, not provider-failed", async () => {
    const fake = runtime();
    fake.generateText.mockRejectedValueOnce(new Error("chunk-local failure"));

    const result = await translatePdf({
      file: new File(["pdf"], "test.pdf", { type: "application/pdf" }),
      targetLanguage: "Hindi",
      runtime: fake,
    });

    expect(result.status).not.toBe("provider-failed");
    expect(result.providerError).toBeUndefined();
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

  it("marks a chunk truncated when the runtime reports outputTruncated", async () => {
    const fake = runtime();
    fake.generateText.mockResolvedValue({
      text: "cut off text",
      providerId: "test",
      runtime: "browser",
      outputTruncated: true,
    });

    const result = await translatePdf({
      file: new File(["pdf"], "test.pdf", { type: "application/pdf" }),
      targetLanguage: "Bengali",
      runtime: fake,
    });

    expect(result.chunks.map((chunk) => chunk.status)).toEqual(["truncated", "truncated"]);
    expect(result.chunks[0].error).toBe("The provider output reached its limit.");
    expect(result.status).toBe("partial");
    expect(result.truncated).toBe(true);
    expect(result.failedChunkIndexes).toEqual([0, 1]);
  });

  it("treats outputTruncated false like an absent signal", async () => {
    const fake = runtime();
    fake.generateText.mockResolvedValue({
      text: "complete text",
      providerId: "test",
      runtime: "browser",
      outputTruncated: false,
    });

    const result = await translatePdf({
      file: new File(["pdf"], "test.pdf", { type: "application/pdf" }),
      targetLanguage: "Bengali",
      runtime: fake,
    });

    expect(result.chunks.every((chunk) => chunk.status === "translated")).toBe(true);
    expect(result.status).toBe("ready");
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

/**
 * Phase 0 translation-quality regression tests.
 *
 * These use mocked runtimes to pin the validators' contract
 * (prompt settings, page-scoping, failure classification). They prove
 * the wiring — they are NOT evidence of real translation quality.
 * Quality evidence comes only from the recorded real-model QA.
 */
describe("translation phase 0 validators", () => {
  it("strips think-tag reasoning and stores the cleaned translation", async () => {
    const fake = runtime();
    fake.generateText.mockResolvedValue({
      text: "<think>First I should consider the grammar of this sentence.</think>Traducción completa del documento.",
      providerId: "test",
      runtime: "browser",
    });

    const result = await translatePdf({
      file: new File(["pdf"], "test.pdf", { type: "application/pdf" }),
      targetLanguage: "Spanish",
      runtime: fake,
    });

    expect(result.chunks[0].status).toBe("translated");
    expect(result.chunks[0].translatedText).toBe("Traducción completa del documento.");
    expect(result.chunks[0].translatedText).not.toContain("<think>");
  });

  it("fails a response that is only reasoning with no translation", async () => {
    const fake = runtime();
    fake.generateText.mockResolvedValue({
      text: "<think>Let me think about how to translate this.</think>",
      providerId: "test",
      runtime: "browser",
    });

    const result = await translatePdf({
      file: new File(["pdf"], "test.pdf", { type: "application/pdf" }),
      targetLanguage: "Spanish",
      runtime: fake,
    });

    expect(result.chunks.every((chunk) => chunk.status === "failed")).toBe(true);
    expect(result.status).toBe("partial");
  });

  it("fails an exact untranslated echo of the source", async () => {
    vi.mocked(buildAiTextContext).mockResolvedValueOnce({
      chunks: [
        {
          chunkIndex: 0,
          pageNumber: 1,
          startOffset: 0,
          endOffset: 60,
          text: "The quarterly revenue exceeded all analyst expectations.",
        },
      ],
      sourcePageCount: 1,
      pagesWithoutText: [],
      truncated: false,
      totalCharacters: 60,
      processingTime: 1,
    });
    const fake = runtime();
    fake.generateText.mockResolvedValue({
      text: "The quarterly revenue exceeded all analyst expectations.",
      providerId: "test",
      runtime: "browser",
    });

    const result = await translatePdf({
      file: new File(["pdf"], "test.pdf", { type: "application/pdf" }),
      targetLanguage: "Spanish",
      runtime: fake,
    });

    expect(result.chunks[0].status).toBe("failed");
    expect(result.chunks[0].error).toMatch(/without translating/i);
  });

  it("fails a Latin-only response for a Bengali request", async () => {
    vi.mocked(buildAiTextContext).mockResolvedValueOnce({
      chunks: [
        {
          chunkIndex: 0,
          pageNumber: 1,
          startOffset: 0,
          endOffset: 60,
          text: "The quarterly revenue exceeded all analyst expectations.",
        },
      ],
      sourcePageCount: 1,
      pagesWithoutText: [],
      truncated: false,
      totalCharacters: 60,
      processingTime: 1,
    });
    const fake = runtime();
    fake.generateText.mockResolvedValue({
      text: "This is an English response with more than enough length.",
      providerId: "test",
      runtime: "browser",
    });

    const result = await translatePdf({
      file: new File(["pdf"], "test.pdf", { type: "application/pdf" }),
      targetLanguage: "Bengali",
      runtime: fake,
    });

    expect(result.chunks[0].status).toBe("failed");
    expect(result.chunks[0].error).toMatch(/Bengali/);
  });

  it("fails degenerated repetition instead of marking it translated", async () => {
    const fake = runtime();
    fake.generateText.mockResolvedValue({
      text: "El informe anual muestra resultados. ".repeat(8),
      providerId: "test",
      runtime: "browser",
    });

    const result = await translatePdf({
      file: new File(["pdf"], "test.pdf", { type: "application/pdf" }),
      targetLanguage: "Spanish",
      runtime: fake,
    });

    expect(result.chunks[0].status).toBe("failed");
    expect(result.chunks[0].error).toMatch(/repetition/i);
  });

  it("flags heuristic truncation for non-browser providers too", async () => {
    for (const text of ["partial translation,", "open (paren", "truncated…", "cut off wor-"]) {
      const fake = runtime();
      fake.generateText.mockResolvedValue({ text, providerId: "test", runtime: "browser" });

      const result = await translatePdf({
        file: new File(["pdf"], "test.pdf", { type: "application/pdf" }),
        targetLanguage: "Spanish",
        runtime: fake,
      });

      expect(result.chunks[0].status).toBe("truncated");
      expect(result.status).toBe("partial");
    }
  });

  it("marks source-context truncation as truncated, never translated", async () => {
    const fake = runtime();
    fake.generateText.mockResolvedValue({
      text: "Esta es una traducción completa y válida del documento.",
      providerId: "test",
      runtime: "browser",
      contextTruncated: true,
    });

    const result = await translatePdf({
      file: new File(["pdf"], "test.pdf", { type: "application/pdf" }),
      targetLanguage: "Spanish",
      runtime: fake,
    });

    expect(result.chunks.every((chunk) => chunk.status === "truncated")).toBe(true);
    expect(result.truncated).toBe(true);
    expect(result.status).toBe("partial");
  });
});

describe("translation phase 0 request shape", () => {
  it("sends deterministic translation settings with every request", async () => {
    const fake = runtime();
    await translatePdf({
      file: new File(["pdf"], "test.pdf", { type: "application/pdf" }),
      targetLanguage: "Spanish",
      runtime: fake,
    });

    expect(fake.generateText).toHaveBeenCalledTimes(2);
    for (const call of fake.generateText.mock.calls) {
      expect(call[0].settings).toEqual({
        temperature: TRANSLATION_TEMPERATURE,
        maxOutputTokens: TRANSLATION_MAX_OUTPUT_TOKENS,
      });
    }
    expect(TRANSLATION_TEMPERATURE).toBe(0);
  });

  it("translates a page's chunks together instead of splitting mid-page", async () => {
    vi.mocked(buildAiTextContext).mockResolvedValueOnce({
      chunks: [
        { chunkIndex: 0, pageNumber: 1, startOffset: 0, endOffset: 6, text: "hello " },
        { chunkIndex: 1, pageNumber: 1, startOffset: 6, endOffset: 11, text: "world" },
        { chunkIndex: 2, pageNumber: 2, startOffset: 0, endOffset: 3, text: "bye" },
      ],
      sourcePageCount: 2,
      pagesWithoutText: [],
      truncated: false,
      totalCharacters: 14,
      processingTime: 1,
    });
    const fake = runtime();
    const result = await translatePdf({
      file: new File(["pdf"], "test.pdf", { type: "application/pdf" }),
      targetLanguage: "Spanish",
      runtime: fake,
    });

    // Two pages -> two model calls, not three chunk calls.
    expect(fake.generateText).toHaveBeenCalledTimes(2);
    const firstCall = fake.generateText.mock.calls[0]?.[0];
    expect(firstCall?.contextChunks).toHaveLength(1);
    expect(firstCall?.contextChunks?.[0]?.text).toBe("hello world");
    expect(firstCall?.contextChunks?.[0]?.pageNumber).toBe(1);
    expect(result.chunks.map((chunk) => chunk.pageNumber)).toEqual([1, 2]);
    expect(result.chunks[0].sourceText).toBe("hello world");
    expect(result.status).toBe("ready");
  });
});

describe("translation phase 0 validator units", () => {
  it("stripReasoningLeakage removes think blocks and reports leakage", () => {
    expect(
      stripReasoningLeakage("<think>reasoning here</think>Real translation."),
    ).toEqual({ cleaned: "Real translation.", hadLeakage: true });
    expect(stripReasoningLeakage("Clean translation.")).toEqual({
      cleaned: "Clean translation.",
      hadLeakage: false,
    });
    expect(stripReasoningLeakage("<think>only reasoning</think>").cleaned).toBe("");
  });

  it("isUntranslatedEcho matches exact and label-wrapped echoes only", () => {
    expect(isUntranslatedEcho("hello world", "hello world")).toBe(true);
    expect(
      isUntranslatedEcho(
        "The quarterly revenue exceeded all analyst expectations.",
        "Translation: The quarterly revenue exceeded all analyst expectations.",
      ),
    ).toBe(true);
    expect(isUntranslatedEcho("hello world", "hola mundo")).toBe(false);
    expect(isUntranslatedEcho("short", "short")).toBe(true);
  });

  it("lacksTargetScript skips Latin targets and short outputs", () => {
    expect(lacksTargetScript("Spanish", "This is English text long enough.")).toBe(false);
    expect(lacksTargetScript("Bengali", "ok")).toBe(false);
    expect(lacksTargetScript("Bengali", "This is English text long enough.")).toBe(true);
    expect(lacksTargetScript("Bengali", "এটি একটি বাংলা অনুবাদ পরীক্ষা।")).toBe(false);
  });

  it("hasPathologicalRepetition detects loops but accepts normal text", () => {
    expect(hasPathologicalRepetition("El informe anual. ".repeat(8))).toBe(true);
    expect(hasPathologicalRepetition("the the the the the the the the")).toBe(false);
    expect(
      hasPathologicalRepetition(
        "Esta es una traducción completa y fiel del documento original con números 123 y nombres propios.",
      ),
    ).toBe(false);
  });
});
