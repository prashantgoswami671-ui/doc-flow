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
