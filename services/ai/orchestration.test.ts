import { describe, expect, it, vi } from "vitest";
import type { AiAvailability, AiCapabilities, AiContextChunk, AiRuntime, AiTextGenerationRequest, AiTextGenerationResult } from "./types";
import { AiEmptyContextError, runAiActionOnPdf } from "./orchestration";
import {
  buildMixedPdfBytes,
  buildScannedImageOnlyPdfBytes,
  buildTextVectorPdfBytes,
  toFile,
} from "../pdf/__fixtures__/pdf";

function fakeCapabilities(): AiCapabilities {
  return {
    providerId: "fake",
    displayName: "Fake",
    runtime: "byok",
    isLocal: true,
    requiresConsent: false,
    supportsStreaming: false,
    supportsToolCalling: false,
    supportsTextGeneration: true,
    maxContextCharacters: 100_000,
    maxOutputCharacters: 10_000,
  };
}

class FakeRuntime implements AiRuntime {
  readonly capabilities = fakeCapabilities();
  lastRequest: AiTextGenerationRequest | null = null;
  nextResult: AiTextGenerationResult = { text: "fake result", providerId: "fake", runtime: "byok" };
  shouldReject: Error | null = null;
  callCount = 0;

  async checkAvailability(): Promise<AiAvailability> {
    return { available: true };
  }

  async generateText(request: AiTextGenerationRequest): Promise<AiTextGenerationResult> {
    this.callCount += 1;
    this.lastRequest = request;
    if (this.shouldReject) throw this.shouldReject;
    return this.nextResult;
  }
}

// Browser-like runtime that adds optional contextTruncated
class FakeBrowserRuntime implements AiRuntime {
  readonly capabilities = fakeCapabilities();
  lastRequest: AiTextGenerationRequest | null = null;
  contextTruncated = false;
  callCount = 0;

  async checkAvailability(): Promise<AiAvailability> {
    return { available: true };
  }

  async generateText(request: AiTextGenerationRequest): Promise<AiTextGenerationResult & { contextTruncated?: boolean }> {
    this.callCount += 1;
    this.lastRequest = request;
    return { text: "browser result", providerId: "fake-browser", runtime: "browser", contextTruncated: this.contextTruncated };
  }
}

describe("runAiActionOnPdf", () => {
  it("real text PDF passes through buildAiTextContext and reaches fake runtime", async () => {
    const bytes = await buildTextVectorPdfBytes(1);
    const file = toFile(bytes);
    const runtime = new FakeRuntime();

    const result = await runAiActionOnPdf({ file, action: "summarize", runtime });

    expect(runtime.callCount).toBe(1);
    expect(runtime.lastRequest).not.toBeNull();
    expect(runtime.lastRequest!.contextChunks!.length).toBeGreaterThan(0);
    expect(result.text).toBe("fake result");
    expect(result.providerId).toBe("fake");
    expect(result.chunks.length).toBeGreaterThan(0);
    expect(result.sourcePageCount).toBe(1);
  });

  it("correct action instruction is passed to runtime", async () => {
    const bytes = await buildTextVectorPdfBytes(1);
    const runtime = new FakeRuntime();

    await runAiActionOnPdf({
      file: toFile(bytes),
      action: "translate",
      targetLanguage: "Spanish",
      runtime,
    });
    expect(runtime.lastRequest!.prompt.toLowerCase()).toContain("translate");
    expect(runtime.lastRequest!.prompt).toContain("Spanish");

    const runtime2 = new FakeRuntime();
    await runAiActionOnPdf({
      file: toFile(bytes),
      action: "ask",
      userQuestion: "What is the heading?",
      runtime: runtime2,
    });
    expect(runtime2.lastRequest!.prompt).toContain("What is the heading?");

    const runtime3 = new FakeRuntime();
    await runAiActionOnPdf({ file: toFile(bytes), action: "keyPoints", runtime: runtime3 });
    expect(runtime3.lastRequest!.prompt.toLowerCase()).toContain("key points");

    const runtime4 = new FakeRuntime();
    await runAiActionOnPdf({ file: toFile(bytes), action: "summarize", runtime: runtime4 });
    expect(runtime4.lastRequest!.prompt.toLowerCase()).toContain("summar");
  });

  it("empty/non-text PDF throws AiEmptyContextError", async () => {
    const bytes = await buildScannedImageOnlyPdfBytes(1);
    const file = toFile(bytes);
    const runtime = new FakeRuntime();

    await expect(runAiActionOnPdf({ file, action: "summarize", runtime })).rejects.toBeInstanceOf(
      AiEmptyContextError,
    );
  });

  it("runtime is NOT called when context is empty", async () => {
    const bytes = await buildScannedImageOnlyPdfBytes(1);
    const file = toFile(bytes);
    const runtime = new FakeRuntime();

    await expect(runAiActionOnPdf({ file, action: "summarize", runtime })).rejects.toBeInstanceOf(
      AiEmptyContextError,
    );
    expect(runtime.callCount).toBe(0);
  });

  it("AI-02 truncation is preserved (contextOptions small budget)", async () => {
    const bytes = await buildTextVectorPdfBytes(3);
    const runtime = new FakeRuntime();
    // Force AI-02 truncation via chunk-count limit (keeps 1 chunk)
    const result = await runAiActionOnPdf({
      file: toFile(bytes),
      action: "summarize",
      runtime,
      contextOptions: { maxChunks: 1 },
    });
    expect(result.truncated).toBe(true);
    // runtime itself did not truncate further
    expect(runtime.lastRequest!.contextChunks!.length).toBe(1);
  });

  it("runtime contextTruncated=true is preserved", async () => {
    const bytes = await buildTextVectorPdfBytes(1);
    const runtime = new FakeBrowserRuntime();
    runtime.contextTruncated = true;

    const result = await runAiActionOnPdf({ file: toFile(bytes), action: "summarize", runtime });
    expect(result.truncated).toBe(true);
  });

  it("AI-02=true + runtime=false -> truncated=true", async () => {
    const bytes = await buildTextVectorPdfBytes(3);
    const runtime = new FakeBrowserRuntime();
    runtime.contextTruncated = false;

    const result = await runAiActionOnPdf({
      file: toFile(bytes),
      action: "summarize",
      runtime,
      contextOptions: { maxChunks: 1 },
    });
    expect(result.truncated).toBe(true);
  });

  it("AI-02=false + runtime=true -> truncated=true", async () => {
    const bytes = await buildTextVectorPdfBytes(1);
    const runtime = new FakeBrowserRuntime();
    runtime.contextTruncated = true;

    const result = await runAiActionOnPdf({ file: toFile(bytes), action: "summarize", runtime });
    expect(result.truncated).toBe(true);
  });

  it("AI-02=false + runtime=false -> truncated=false", async () => {
    const bytes = await buildTextVectorPdfBytes(1);
    const runtime = new FakeBrowserRuntime();
    runtime.contextTruncated = false;

    const result = await runAiActionOnPdf({ file: toFile(bytes), action: "summarize", runtime });
    expect(result.truncated).toBe(false);
    expect(result.chunks.length).toBeGreaterThan(0);
  });

  it("pagesWithoutText is preserved (mixed fixture)", async () => {
    const bytes = await buildMixedPdfBytes();
    const runtime = new FakeRuntime();
    const result = await runAiActionOnPdf({ file: toFile(bytes), action: "summarize", runtime });
    // mixed fixture has at least one scanned/image page without extractable text
    // so pagesWithoutText should be non-empty but chunks should still exist
    expect(result.pagesWithoutText.length).toBeGreaterThan(0);
    expect(result.chunks.length).toBeGreaterThan(0);
  });

  it("generation error propagates unchanged", async () => {
    const bytes = await buildTextVectorPdfBytes(1);
    const runtime = new FakeRuntime();
    const genError = new Error("generation failed");
    genError.name = "AiGenerationError";
    runtime.shouldReject = genError;

    await expect(runAiActionOnPdf({ file: toFile(bytes), action: "summarize", runtime })).rejects.toBe(
      genError,
    );
  });

  it("cancellation error propagates unchanged", async () => {
    const bytes = await buildTextVectorPdfBytes(1);
    const runtime = new FakeRuntime();
    const cancelError = new Error("cancelled");
    cancelError.name = "AiGenerationCancelledError";
    runtime.shouldReject = cancelError;

    await expect(runAiActionOnPdf({ file: toFile(bytes), action: "summarize", runtime })).rejects.toBe(
      cancelError,
    );
  });

  it("runtime receives only prompt and contextChunks", async () => {
    const bytes = await buildTextVectorPdfBytes(1);
    const runtime = new FakeRuntime();
    await runAiActionOnPdf({ file: toFile(bytes), action: "summarize", runtime });
    const req = runtime.lastRequest as unknown as Record<string, unknown>;
    expect(typeof req.prompt).toBe("string");
    expect(Array.isArray(req.contextChunks)).toBe(true);
    expect(req.file).toBeUndefined();
    expect(req.blob).toBeUndefined();
    expect(req.fileBytes).toBeUndefined();
    expect(req.arrayBuffer).toBeUndefined();
    expect(req.password).toBeUndefined();
    expect(JSON.stringify(req)).not.toMatch(/file|blob|fileBytes|arrayBuffer|password|pageImage|thumbnail|metadata/);
  });

  it("orchestration does not require BrowserAiRuntime (uses generic AiRuntime)", async () => {
    const bytes = await buildTextVectorPdfBytes(1);
    // generic fake without browser specifics
    const runtime: AiRuntime = {
      capabilities: fakeCapabilities(),
      checkAvailability: async () => ({ available: true }),
      generateText: async (req) => {
        expect(req.prompt).toContain("Summar");
        return { text: "ok", providerId: "generic", runtime: "byok" };
      },
    };

    const result = await runAiActionOnPdf({ file: toFile(bytes), action: "summarize", runtime });
    expect(result.text).toBe("ok");
    expect(result.providerId).toBe("generic");
  });

  it("pageNumbers option is forwarded to extraction", async () => {
    const bytes = await buildTextVectorPdfBytes(3);
    const runtime = new FakeRuntime();
    const result = await runAiActionOnPdf({
      file: toFile(bytes),
      action: "summarize",
      runtime,
      pageNumbers: [1],
    });
    // only page 1 extracted -> sourcePageCount still reports original doc pages
    expect(result.sourcePageCount).toBe(3);
    // chunks should only be from page 1
    for (const c of result.chunks) {
      expect(c.pageNumber).toBe(1);
    }
  });
});
