import { describe, expect, it, vi } from "vitest";
import { generateKeyPoints, parseKeyPointsResponse } from "./keyPoints";
import type { AiRuntime } from "./types";
import { AiGenerationError } from "./browser/errors";

vi.mock("./pipeline", () => ({ buildAiTextContext: vi.fn() }));
import { buildAiTextContext } from "./pipeline";

const chunk = (chunkIndex: number, text = `source-${chunkIndex}`) => ({
  chunkIndex, pageNumber: chunkIndex + 1, text, startOffset: chunkIndex * 10, endOffset: chunkIndex * 10 + text.length,
});
const runtime = (outputs: string[]) => ({ capabilities: { providerId: "browser-ai", maxOutputCharacters: 10000 }, generateText: vi.fn(async () => ({ text: outputs.shift() ?? '{"points":["fallback"]}', providerId: "browser-ai", runtime: "browser" })) } as unknown as AiRuntime);

describe("key points", () => {
  it("strictly parses only a bounded points object", () => {
    expect(parseKeyPointsResponse('{"points":["one"," two "]}')).toEqual(["one", "two"]);
    expect(parseKeyPointsResponse("- one")).toBeNull();
    expect(parseKeyPointsResponse('{"points":[""]}')).toBeNull();
    expect(parseKeyPointsResponse('{"points":["1","2","3","4"]}')).toBeNull();
  });
  it("processes chunks sequentially, deduplicates exactly, and preserves metadata", async () => {
    vi.mocked(buildAiTextContext).mockResolvedValue({ chunks: [chunk(0), chunk(1)], sourcePageCount: 2, pagesWithoutText: [], truncated: false, totalCharacters: 18, processingTime: 0 });
    const r = runtime(['{"points":["A","B"]}', '{"points":[" b ","C"]}']);
    const result = await generateKeyPoints({ file: new File(["x"], "x.pdf"), runtime: r });
    expect(r.generateText).toHaveBeenCalledTimes(2);
    expect(result.points.map((p) => p.text)).toEqual(["A", "B", "C"]);
    expect(result.points[2]).toMatchObject({ pointIndex: 2, sourceChunkIndex: 1, sourcePageNumber: 2, sourceText: "source-1" });
  });
  it("continues isolated failures", async () => {
    vi.mocked(buildAiTextContext).mockResolvedValue({ chunks: [chunk(0), chunk(1), chunk(2)], sourcePageCount: 3, pagesWithoutText: [], truncated: false, totalCharacters: 27, processingTime: 0 });
    const r = runtime(['{"points":["ok"]}', '{"points":["later"]}']);
    vi.mocked(r.generateText).mockRejectedValueOnce(new Error("chunk-local failure"));
    const partial = await generateKeyPoints({ file: new File(["x"], "x.pdf"), runtime: r });
    expect(partial.status).toBe("partial"); expect(partial.failedChunkIndexes).toEqual([0]);
    expect(r.generateText).toHaveBeenCalledTimes(3);
  });
  it("classifies Browser generation failure before the first chunk as provider-failed", async () => {
    vi.mocked(buildAiTextContext).mockResolvedValue({ chunks: [chunk(0), chunk(1)], sourcePageCount: 2, pagesWithoutText: [], truncated: false, totalCharacters: 18, processingTime: 0 });
    const failing = runtime([]);
    vi.mocked(failing.generateText).mockRejectedValueOnce(new AiGenerationError("generation unavailable"));
    const provider = await generateKeyPoints({ file: new File(["x"], "x.pdf"), runtime: failing });
    expect(provider.status).toBe("provider-failed");
    expect(provider.points).toHaveLength(0);
    expect(provider.providerError).toBe("generation unavailable");
    expect(failing.generateText).toHaveBeenCalledTimes(1);
  });
  it("classifies Browser generation failure after earlier success and preserves points", async () => {
    vi.mocked(buildAiTextContext).mockResolvedValue({ chunks: [chunk(0), chunk(1), chunk(2)], sourcePageCount: 3, pagesWithoutText: [], truncated: false, totalCharacters: 27, processingTime: 0 });
    const failing = runtime(['{"points":["kept"]}']);
    vi.mocked(failing.generateText).mockResolvedValueOnce({ text: '{"points":["kept"]}', providerId: "browser-ai", runtime: "browser" });
    vi.mocked(failing.generateText).mockRejectedValueOnce(new AiGenerationError("worker generation failed"));
    const provider = await generateKeyPoints({ file: new File(["x"], "x.pdf"), runtime: failing });
    expect(provider.status).toBe("provider-failed");
    expect(provider.points.map((point) => point.text)).toEqual(["kept"]);
    expect(provider.providerError).toBe("worker generation failed");
    expect(failing.generateText).toHaveBeenCalledTimes(2);
  });
  it("preserves cancellation instead of classifying it as provider failure", async () => {
    vi.mocked(buildAiTextContext).mockResolvedValue({ chunks: [chunk(0), chunk(1)], sourcePageCount: 2, pagesWithoutText: [], truncated: false, totalCharacters: 18, processingTime: 0 });
    const cancelled = runtime(['{"points":["first"]}']);
    const result = await generateKeyPoints({ file: new File(["x"], "x.pdf"), runtime: cancelled, isCancellationRequested: () => true });
    expect(result.status).toBe("cancelled");
    expect(result.providerError).toBeUndefined();
    expect(cancelled.generateText).not.toHaveBeenCalled();
  });
  it("retains recognized Ollama provider failures", async () => {
    vi.mocked(buildAiTextContext).mockResolvedValue({ chunks: [chunk(0)], sourcePageCount: 1, pagesWithoutText: [], truncated: false, totalCharacters: 9, processingTime: 0 });
    const failing = runtime([]);
    vi.mocked(failing.generateText).mockRejectedValueOnce(Object.assign(new Error("Ollama unavailable"), { name: "OllamaGenerationError" }));
    const provider = await generateKeyPoints({ file: new File(["x"], "x.pdf"), runtime: failing });
    expect(provider.status).toBe("provider-failed");
    expect(provider.providerError).toBe("Ollama unavailable");
  });
  it("returns no-text without invoking the runtime", async () => {
    vi.mocked(buildAiTextContext).mockResolvedValue({ chunks: [], sourcePageCount: 1, pagesWithoutText: [1], truncated: false, totalCharacters: 0, processingTime: 0 });
    const r = runtime([]);
    const result = await generateKeyPoints({ file: new File(["x"], "x.pdf"), runtime: r });
    expect(result.status).toBe("no-text"); expect(r.generateText).not.toHaveBeenCalled();
  });
});

describe("key points ollama structured experiment", () => {
  const structuredSchema = {
    type: "object",
    properties: {
      points: { type: "array", items: { type: "string" }, maxItems: 3 },
    },
    required: ["points"],
    additionalProperties: false,
  };

  const ollamaStructuredRuntime = (outputs: string[]) => {
    const generateText = vi.fn(async () => ({
      text: '{"points":["generic-path"]}', providerId: "ollama", runtime: "ollama",
    }));
    const generateStructuredText = vi.fn(async () => outputs.shift() ?? '{"points":["fallback"]}');
    const r = {
      capabilities: { providerId: "ollama", maxOutputCharacters: 10000, maxContextCharacters: 32768 },
      generateText,
      generateStructuredText,
    } as unknown as AiRuntime;
    return { runtime: r, generateText, generateStructuredText };
  };

  const ollamaWithoutStructured = () => {
    const generateText = vi.fn(async () => ({
      text: '{"points":["generic-path"]}', providerId: "ollama", runtime: "ollama",
    }));
    const r = {
      capabilities: { providerId: "ollama", maxOutputCharacters: 10000, maxContextCharacters: 32768 },
      generateText,
    } as unknown as AiRuntime;
    return { runtime: r, generateText };
  };

  it("calls generateStructuredText with the exact schema and chunk, not generateText", async () => {
    vi.mocked(buildAiTextContext).mockResolvedValue({ chunks: [chunk(0), chunk(1)], sourcePageCount: 2, pagesWithoutText: [], truncated: false, totalCharacters: 18, processingTime: 0 });
    const { runtime: r, generateText, generateStructuredText } = ollamaStructuredRuntime(['{"points":["A","B"]}', '{"points":["C"]}']);
    const result = await generateKeyPoints({ file: new File(["x"], "x.pdf"), runtime: r });
    expect(generateStructuredText).toHaveBeenCalledTimes(2);
    expect(generateText).not.toHaveBeenCalled();
    expect(generateStructuredText).toHaveBeenNthCalledWith(1, {
      prompt: expect.stringContaining("at most 3"),
      contextChunks: [chunk(0)],
      format: structuredSchema,
      settings: { temperature: 0, maxOutputTokens: 256 },
    });
    expect(generateStructuredText).toHaveBeenNthCalledWith(2, expect.objectContaining({
      contextChunks: [chunk(1)],
      format: structuredSchema,
    }));
    expect(result.points.map((p) => p.text)).toEqual(["A", "B", "C"]);
    expect(result.status).toBe("ready");
  });

  it("uses generateText when the ollama runtime has no structured method", async () => {
    vi.mocked(buildAiTextContext).mockResolvedValue({ chunks: [chunk(0)], sourcePageCount: 1, pagesWithoutText: [], truncated: false, totalCharacters: 9, processingTime: 0 });
    const { runtime: r, generateText } = ollamaWithoutStructured();
    const result = await generateKeyPoints({ file: new File(["x"], "x.pdf"), runtime: r });
    expect(generateText).toHaveBeenCalledTimes(1);
    expect(result.points.map((p) => p.text)).toEqual(["generic-path"]);
    expect(result.status).toBe("ready");
  });

  it("keeps the browser-ai path on generateText even if a structured method exists", async () => {
    vi.mocked(buildAiTextContext).mockResolvedValue({ chunks: [chunk(0)], sourcePageCount: 1, pagesWithoutText: [], truncated: false, totalCharacters: 9, processingTime: 0 });
    const r = runtime(['{"points":["kept"]}']) as unknown as AiRuntime & { generateStructuredText: ReturnType<typeof vi.fn> };
    r.generateStructuredText = vi.fn(async () => '{"points":["wrong"]}');
    const result = await generateKeyPoints({ file: new File(["x"], "x.pdf"), runtime: r });
    expect(r.generateStructuredText).not.toHaveBeenCalled();
    expect(result.points.map((p) => p.text)).toEqual(["kept"]);
    expect(result.status).toBe("ready");
  });

  it("produces points with source metadata from valid structured output", async () => {
    vi.mocked(buildAiTextContext).mockResolvedValue({ chunks: [chunk(1, "source-one")], sourcePageCount: 2, pagesWithoutText: [], truncated: false, totalCharacters: 10, processingTime: 0 });
    const { runtime: r } = ollamaStructuredRuntime(['{"points":["First","Second"]}']);
    const result = await generateKeyPoints({ file: new File(["x"], "x.pdf"), runtime: r });
    expect(result.points).toHaveLength(2);
    expect(result.points[0]).toMatchObject({ pointIndex: 0, sourceChunkIndex: 1, sourcePageNumber: 2, sourceText: "source-one" });
    expect(result.status).toBe("ready");
  });

  it("marks malformed structured output as a failed chunk", async () => {
    vi.mocked(buildAiTextContext).mockResolvedValue({ chunks: [chunk(0)], sourcePageCount: 1, pagesWithoutText: [], truncated: false, totalCharacters: 9, processingTime: 0 });
    const { runtime: r, generateText } = ollamaStructuredRuntime(["Prose reasoning, not JSON."]);
    const result = await generateKeyPoints({ file: new File(["x"], "x.pdf"), runtime: r });
    expect(result.status).toBe("partial");
    expect(result.failedChunkIndexes).toEqual([0]);
    expect(result.points).toHaveLength(0);
    expect(result.providerError).toBeUndefined();
    expect(generateText).not.toHaveBeenCalled();
  });

  it("keeps structured provider failure as provider-failed", async () => {
    vi.mocked(buildAiTextContext).mockResolvedValue({ chunks: [chunk(0), chunk(1)], sourcePageCount: 2, pagesWithoutText: [], truncated: false, totalCharacters: 18, processingTime: 0 });
    const { runtime: r, generateText, generateStructuredText } = ollamaStructuredRuntime([]);
    vi.mocked(generateStructuredText).mockRejectedValueOnce(new AiGenerationError("structured generation failed"));
    const result = await generateKeyPoints({ file: new File(["x"], "x.pdf"), runtime: r });
    expect(result.status).toBe("provider-failed");
    expect(result.providerError).toBe("structured generation failed");
    expect(result.points).toHaveLength(0);
    expect(generateText).not.toHaveBeenCalled();
    expect(generateStructuredText).toHaveBeenCalledTimes(1);
  });

  it("preserves cancellation on the structured path", async () => {
    vi.mocked(buildAiTextContext).mockResolvedValue({ chunks: [chunk(0), chunk(1)], sourcePageCount: 2, pagesWithoutText: [], truncated: false, totalCharacters: 18, processingTime: 0 });
    const { runtime: r, generateStructuredText } = ollamaStructuredRuntime(['{"points":["first"]}']);
    const result = await generateKeyPoints({ file: new File(["x"], "x.pdf"), runtime: r, isCancellationRequested: () => true });
    expect(result.status).toBe("cancelled");
    expect(result.providerError).toBeUndefined();
    expect(generateStructuredText).not.toHaveBeenCalled();
  });

  it("rejects structured output over the three-point limit", async () => {
    vi.mocked(buildAiTextContext).mockResolvedValue({ chunks: [chunk(0)], sourcePageCount: 1, pagesWithoutText: [], truncated: false, totalCharacters: 9, processingTime: 0 });
    const { runtime: r } = ollamaStructuredRuntime(['{"points":["1","2","3","4"]}']);
    const result = await generateKeyPoints({ file: new File(["x"], "x.pdf"), runtime: r });
    expect(result.status).toBe("partial");
    expect(result.failedChunkIndexes).toEqual([0]);
    expect(result.points).toHaveLength(0);
  });

  it("deduplicates structured output exactly", async () => {
    vi.mocked(buildAiTextContext).mockResolvedValue({ chunks: [chunk(0), chunk(1)], sourcePageCount: 2, pagesWithoutText: [], truncated: false, totalCharacters: 18, processingTime: 0 });
    const { runtime: r } = ollamaStructuredRuntime(['{"points":["Same","Unique"]}', '{"points":[" same ","Other"]}']);
    const result = await generateKeyPoints({ file: new File(["x"], "x.pdf"), runtime: r });
    expect(result.points.map((p) => p.text)).toEqual(["Same", "Unique", "Other"]);
    expect(result.status).toBe("ready");
  });
});
