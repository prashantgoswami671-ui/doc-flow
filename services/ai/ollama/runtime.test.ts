import { describe, expect, it, vi } from "vitest";
import type { AiContextChunk } from "../types";
import {
  AiRequestValidationError,
  ProhibitedAiRequestFieldError,
  assertValidAiCapabilities,
} from "../validation";
import {
  OLLAMA_BASE_URL,
  OLLAMA_DEFAULT_MAX_TOKENS,
  OLLAMA_MAX_CONTEXT_CHARACTERS,
  OLLAMA_MAX_OUTPUT_CHARACTERS,
  OLLAMA_MAX_OUTPUT_TOKENS,
  OLLAMA_MODEL,
  OLLAMA_PROVIDER_ID,
} from "./types";
import {
  OllamaClientError,
  OllamaGenerationError,
  OllamaModelNotFoundError,
  OllamaRuntime,
  OllamaRuntimeDisposedError,
  boundContextChunks,
} from "./runtime";
import { buildOllamaPrompt, createOllamaClient } from "./client";

function availableAlways() {
  return Promise.resolve({ available: true as const });
}

interface MockOllamaClient {
  checkAvailability: ReturnType<typeof vi.fn>;
  generate: ReturnType<typeof vi.fn>;
  showModel: ReturnType<typeof vi.fn>;
  lastGenerateCall: {
    prompt: string;
    contextChunks?: { text: string; pageNumber: number; chunkIndex: number }[];
    settings?: { temperature?: number; maxOutputTokens?: number };
  } | null;
  shouldFailAvailability: boolean;
  shouldFailGenerate: boolean;
  failGenerateError: Error | null;
}

function createMockClient(overrides: Partial<MockOllamaClient> = {}): MockOllamaClient {
  const client: MockOllamaClient = {
    checkAvailability: vi.fn().mockResolvedValue({ available: true }),
    generate: vi.fn().mockResolvedValue("generated text"),
    showModel: vi.fn().mockResolvedValue({}),
    lastGenerateCall: null,
    shouldFailAvailability: false,
    shouldFailGenerate: false,
    failGenerateError: null,
    ...overrides,
  };

  // Wrap methods to track calls and apply failure logic
  const originalCheckAvailability = client.checkAvailability;
  client.checkAvailability = vi.fn().mockImplementation(async () => {
    if (client.shouldFailAvailability) {
      return { available: false, reason: "Ollama not reachable" };
    }
    return originalCheckAvailability();
  });

  const originalGenerate = client.generate;
  client.generate = vi.fn().mockImplementation(async (
    prompt: string,
    contextChunks?: { text: string; pageNumber: number; chunkIndex: number }[],
    settings?: { temperature?: number; maxOutputTokens?: number },
  ) => {
    client.lastGenerateCall = { prompt, contextChunks, settings };
    if (client.shouldFailGenerate && client.failGenerateError) {
      throw client.failGenerateError;
    }
    return originalGenerate();
  });

  return client;
}

function runtimeWithMockClient(mockClient: MockOllamaClient): OllamaRuntime {
  return new OllamaRuntime({
    clientFactory: () => mockClient as unknown as ReturnType<typeof createOllamaClient>,
    availabilityCheck: availableAlways,
  });
}

function makeChunk(
  overrides: Partial<AiContextChunk> & { text: string },
): AiContextChunk {
  return {
    chunkIndex: overrides.chunkIndex ?? 0,
    pageNumber: overrides.pageNumber ?? 1,
    text: overrides.text,
    startOffset: overrides.startOffset ?? 0,
    endOffset: overrides.endOffset ?? overrides.text.length,
  };
}

describe("OllamaRuntime capabilities", () => {
  it("exposes a valid capability object that matches the implemented surface", () => {
    const mockClient = createMockClient();
    const runtime = runtimeWithMockClient(mockClient);

    expect(() => assertValidAiCapabilities(runtime.capabilities)).not.toThrow();
    expect(runtime.capabilities.providerId).toBe(OLLAMA_PROVIDER_ID);
    expect(runtime.capabilities.displayName).toBe("Ollama (qwen3:4b)");
    expect(runtime.capabilities.runtime).toBe("ollama");
    expect(runtime.capabilities.isLocal).toBe(true);
    expect(runtime.capabilities.requiresConsent).toBe(true);
    expect(runtime.capabilities.supportsTextGeneration).toBe(true);
    expect(runtime.capabilities.supportsToolCalling).toBe(false);
    expect(runtime.capabilities.supportsStreaming).toBe(false);
    expect(runtime.capabilities.maxContextCharacters).toBe(OLLAMA_MAX_CONTEXT_CHARACTERS);
    expect(runtime.capabilities.maxOutputCharacters).toBe(OLLAMA_MAX_OUTPUT_CHARACTERS);
  });
});

describe("buildOllamaPrompt", () => {
  it("builds a prompt with system instruction and user prompt only", () => {
    const prompt = "Summarize this.";
    const result = buildOllamaPrompt(prompt, undefined);

    expect(result).toContain("You are a helpful assistant working with document text");
    expect(result).toContain(prompt);
    expect(result).not.toContain("DOCUMENT_CONTEXT_START");
  });

  it("includes document context when chunks provided", () => {
    const prompt = "Summarize this.";
    const chunks = [
      { chunkIndex: 0, pageNumber: 1, text: "Page 1 content." },
      { chunkIndex: 1, pageNumber: 2, text: "Page 2 content." },
    ];
    const result = buildOllamaPrompt(prompt, chunks);

    expect(result).toContain("DOCUMENT_CONTEXT_START");
    expect(result).toContain("DOCUMENT_CONTEXT_END");
    expect(result).toContain("[page 1] Page 1 content.");
    expect(result).toContain("[page 2] Page 2 content.");
  });

  it("sorts chunks by chunkIndex", () => {
    const chunks = [
      { chunkIndex: 2, pageNumber: 3, text: "Third." },
      { chunkIndex: 0, pageNumber: 1, text: "First." },
      { chunkIndex: 1, pageNumber: 2, text: "Second." },
    ];
    const result = buildOllamaPrompt("Prompt", chunks);

    const startIdx = result.indexOf("DOCUMENT_CONTEXT_START");
    const endIdx = result.indexOf("DOCUMENT_CONTEXT_END");
    const contextBlock = result.slice(startIdx, endIdx);

    // First occurrence order should be 0, 1, 2
    expect(contextBlock.indexOf("First.")).toBeLessThan(contextBlock.indexOf("Second."));
    expect(contextBlock.indexOf("Second.")).toBeLessThan(contextBlock.indexOf("Third."));
  });
});

describe("OllamaRuntime.generateText contract", () => {
  it("rejects invalid and prohibited request data before touching the client", async () => {
    const mockClient = createMockClient();
    const runtime = runtimeWithMockClient(mockClient);

    await expect(runtime.generateText({ prompt: "   " })).rejects.toBeInstanceOf(
      AiRequestValidationError,
    );
    await expect(
      runtime.generateText({
        prompt: "Summarize",
        file: new File(["pdf"], "doc.pdf"),
      } as never),
    ).rejects.toBeInstanceOf(ProhibitedAiRequestFieldError);

    expect(mockClient.generate).not.toHaveBeenCalled();
  });

  it("rejects generation when the runtime is unavailable", async () => {
    const mockClient = createMockClient({ shouldFailAvailability: true });
    const runtime = new OllamaRuntime({
      clientFactory: () => mockClient as unknown as ReturnType<typeof createOllamaClient>,
      availabilityCheck: () => Promise.resolve({ available: false, reason: "Ollama not running" }),
    });

    await expect(runtime.generateText({ prompt: "Hello" })).rejects.toBeInstanceOf(
      OllamaClientError,
    );
  });

  it("returns a valid AiTextGenerationResult and sends only text to Ollama", async () => {
    const mockClient = createMockClient();
    const runtime = runtimeWithMockClient(mockClient);

    const result = await runtime.generateText({
      prompt: "Summarize this.",
      contextChunks: [
        makeChunk({ chunkIndex: 0, pageNumber: 1, text: "Extracted page text." }),
      ],
      settings: { maxOutputTokens: 64, temperature: 0.2 },
    });

    expect(result).toEqual({
      text: "generated text",
      providerId: OLLAMA_PROVIDER_ID,
      runtime: "ollama",
      contextTruncated: false,
    });

    expect(mockClient.lastGenerateCall).not.toBeNull();
    expect(mockClient.lastGenerateCall?.contextChunks).toHaveLength(1);
    expect(mockClient.lastGenerateCall?.contextChunks?.[0].text).toBe("Extracted page text.");
    expect(mockClient.lastGenerateCall?.settings?.maxOutputTokens).toBe(64);
    expect(mockClient.lastGenerateCall?.settings?.temperature).toBe(0.2);
  });

  it("treats maxOutputTokens as a token limit: passthrough within OLLAMA_MAX_OUTPUT_TOKENS, clamped above it", async () => {
    const passthroughClient = createMockClient();
    const passthroughRuntime = runtimeWithMockClient(passthroughClient);
    await passthroughRuntime.generateText({
      prompt: "hi",
      settings: { maxOutputTokens: 128 },
    });
    expect(passthroughClient.lastGenerateCall?.settings?.maxOutputTokens).toBe(128);

    const clampedClient = createMockClient();
    const clampedRuntime = runtimeWithMockClient(clampedClient);
    await clampedRuntime.generateText({
      prompt: "hi",
      settings: { maxOutputTokens: 100_000 },
    });
    expect(clampedClient.lastGenerateCall?.settings?.maxOutputTokens).toBe(
      OLLAMA_MAX_OUTPUT_TOKENS,
    );
  });

  it("defaults maxOutputTokens to OLLAMA_DEFAULT_MAX_TOKENS when unset", async () => {
    const mockClient = createMockClient();
    const runtime = runtimeWithMockClient(mockClient);

    await runtime.generateText({ prompt: "hi" });

    expect(mockClient.lastGenerateCall?.settings?.maxOutputTokens).toBe(
      OLLAMA_DEFAULT_MAX_TOKENS,
    );
  });

  it("propagates model not found error from client", async () => {
    const mockClient = createMockClient({
      shouldFailGenerate: true,
      failGenerateError: new OllamaModelNotFoundError(OLLAMA_MODEL, "/api/generate"),
    });
    const runtime = runtimeWithMockClient(mockClient);

    await expect(runtime.generateText({ prompt: "Hello" })).rejects.toBeInstanceOf(
      OllamaModelNotFoundError,
    );
  });

  it("propagates generation errors from client", async () => {
    const mockClient = createMockClient({
      shouldFailGenerate: true,
      failGenerateError: new OllamaGenerationError("server error", 500, "/api/generate"),
    });
    const runtime = runtimeWithMockClient(mockClient);

    await expect(runtime.generateText({ prompt: "Hello" })).rejects.toBeInstanceOf(
      OllamaGenerationError,
    );
  });

  it("rejects a second generateText while one is in flight", async () => {
    let resolveGenerate: (value: string) => void;
    const generatePromise = new Promise<string>((resolve) => {
      resolveGenerate = resolve;
    });

    const mockClient = createMockClient();
    mockClient.generate = vi.fn().mockReturnValue(generatePromise);
    const runtime = runtimeWithMockClient(mockClient);

    const first = runtime.generateText({ prompt: "first" });

    // Second call should reject immediately with in-flight error
    await expect(runtime.generateText({ prompt: "second" })).rejects.toThrow(
      "Ollama runtime supports one in-flight generation at a time.",
    );

    // Resolve the first to clean up
    resolveGenerate!("done");
    await expect(first).resolves.toBeDefined();
  });
});

describe("boundContextChunks", () => {
  it("returns empty truncated=false for empty array", () => {
    expect(boundContextChunks([], OLLAMA_MAX_CONTEXT_CHARACTERS)).toEqual({
      chunks: [],
      truncated: false,
    });
  });

  it("returns all chunks when within budget", () => {
    const chunks = [
      makeChunk({ chunkIndex: 0, text: "a".repeat(10000) }),
      makeChunk({ chunkIndex: 1, text: "b".repeat(10000) }),
    ];
    const result = boundContextChunks(chunks, OLLAMA_MAX_CONTEXT_CHARACTERS);
    expect(result.chunks).toHaveLength(2);
    expect(result.truncated).toBe(false);
  });

  it("truncates trailing chunks when total exceeds budget and does not slice", () => {
    const a = makeChunk({ chunkIndex: 0, text: "a".repeat(15000) });
    const b = makeChunk({ chunkIndex: 1, text: "b".repeat(15000) });
    const c = makeChunk({ chunkIndex: 2, text: "c".repeat(15000) });
    const original = [a, b, c];
    const originalSnapshot = original.map((ch) => ({ ...ch }));
    const result = boundContextChunks(original, OLLAMA_MAX_CONTEXT_CHARACTERS);
    // A+B=30000 fits, C would make 45000 >32768 => truncated
    expect(result.chunks).toHaveLength(2);
    expect(result.chunks[0].text).toBe("a".repeat(15000));
    expect(result.chunks[1].text).toBe("b".repeat(15000));
    expect(result.truncated).toBe(true);
    // no mutation
    expect(original).toHaveLength(3);
    expect(original[0].text).toBe(originalSnapshot[0].text);
    // deterministic: later chunks not included
    expect(result.chunks.map((ch) => ch.chunkIndex)).toEqual([0, 1]);
  });

  it("returns zero chunks truncated=true when first chunk alone exceeds budget", () => {
    const huge = makeChunk({ text: "x".repeat(40000) });
    const result = boundContextChunks([huge], OLLAMA_MAX_CONTEXT_CHARACTERS);
    expect(result.chunks).toHaveLength(0);
    expect(result.truncated).toBe(true);
  });

  it("does not skip an oversized chunk to include later ones", () => {
    const huge = makeChunk({ chunkIndex: 0, text: "x".repeat(40000) });
    const small = makeChunk({ chunkIndex: 1, text: "y".repeat(100) });
    const result = boundContextChunks([huge, small], OLLAMA_MAX_CONTEXT_CHARACTERS);
    expect(result.chunks).toHaveLength(0);
    expect(result.truncated).toBe(true);
  });

  it("never mutates input array or objects", () => {
    const a = makeChunk({ chunkIndex: 0, text: "a".repeat(10) });
    const b = makeChunk({ chunkIndex: 1, text: "b".repeat(10) });
    const input = [a, b];
    boundContextChunks(input, 15);
    expect(input).toHaveLength(2);
    expect(a.text).toBe("a".repeat(10));
  });
});

describe("OllamaRuntime context budget integration", () => {
  it("sends all chunks and contextTruncated=false when within budget", async () => {
    const mockClient = createMockClient();
    const runtime = runtimeWithMockClient(mockClient);
    const chunks = [
      makeChunk({ chunkIndex: 0, text: "a".repeat(10000) }),
      makeChunk({ chunkIndex: 1, text: "b".repeat(10000) }),
    ];
    const result = await runtime.generateText({ prompt: "hi", contextChunks: chunks });
    expect(result.contextTruncated).toBe(false);
    expect(mockClient.lastGenerateCall?.contextChunks).toHaveLength(2);
  });

  it("truncates trailing chunks and reports contextTruncated=true", async () => {
    const mockClient = createMockClient();
    const runtime = runtimeWithMockClient(mockClient);
    const a = makeChunk({ chunkIndex: 0, text: "a".repeat(15000) });
    const b = makeChunk({ chunkIndex: 1, text: "b".repeat(15000) });
    const c = makeChunk({ chunkIndex: 2, text: "c".repeat(15000) });
    const result = await runtime.generateText({
      prompt: "hi",
      contextChunks: [a, b, c],
    });
    expect(result.contextTruncated).toBe(true);
    expect(mockClient.lastGenerateCall?.contextChunks).toHaveLength(2);
    // no partial slice
    expect(mockClient.lastGenerateCall?.contextChunks?.[0].text).toBe("a".repeat(15000));
    expect(mockClient.lastGenerateCall?.contextChunks?.[1].text).toBe("b".repeat(15000));
  });

  it("handles empty and undefined context as not truncated", async () => {
    const mockClient1 = createMockClient();
    const runtime1 = runtimeWithMockClient(mockClient1);
    const res1 = await runtime1.generateText({ prompt: "hi" });
    expect(res1.contextTruncated).toBe(false);
    expect(mockClient1.lastGenerateCall?.contextChunks).toEqual([]);

    const mockClient2 = createMockClient();
    const runtime2 = runtimeWithMockClient(mockClient2);
    const res2 = await runtime2.generateText({ prompt: "hi", contextChunks: [] });
    expect(res2.contextTruncated).toBe(false);
  });

  it("handles oversized first chunk: zero chunks to Ollama, truncated=true but still succeeds", async () => {
    const mockClient = createMockClient();
    const runtime = runtimeWithMockClient(mockClient);
    const huge = makeChunk({ text: "x".repeat(40000) });
    const result = await runtime.generateText({ prompt: "hi", contextChunks: [huge] });
    expect(result.contextTruncated).toBe(true);
    expect(result.text).toBe("generated text");
    expect(mockClient.lastGenerateCall?.contextChunks).toHaveLength(0);
  });

  it("does not include system prompt in budget — only chunk text length counts", async () => {
    const mockClient = createMockClient();
    const runtime = runtimeWithMockClient(mockClient);
    // prompt is long but should not affect truncation
    const longPrompt = "p".repeat(5000);
    const chunks = [makeChunk({ text: "a".repeat(30000) })];
    const result = await runtime.generateText({ prompt: longPrompt, contextChunks: chunks });
    expect(result.contextTruncated).toBe(false);
  });
});

describe("OllamaRuntime lifecycle", () => {
  it("dispose is permanent: future generateText rejects with OllamaRuntimeDisposedError", async () => {
    const mockClient = createMockClient();
    const runtime = runtimeWithMockClient(mockClient);

    await runtime.generateText({ prompt: "first" });
    expect(mockClient.generate).toHaveBeenCalledTimes(1);

    runtime.dispose();

    await expect(runtime.generateText({ prompt: "second" })).rejects.toBeInstanceOf(
      OllamaRuntimeDisposedError,
    );
    // The rejected call never reached the client again.
    expect(mockClient.generate).toHaveBeenCalledTimes(1);
  });

  it("an already-running generation settles naturally after dispose", async () => {
    let resolveGenerate: (value: string) => void;
    const generatePromise = new Promise<string>((resolve) => {
      resolveGenerate = resolve;
    });

    const mockClient = createMockClient();
    mockClient.generate = vi.fn().mockReturnValue(generatePromise);
    const runtime = runtimeWithMockClient(mockClient);

    const inFlight = runtime.generateText({ prompt: "in-flight" });

    // Disposal mid-flight does not cancel the HTTP request's promise.
    runtime.dispose();
    resolveGenerate!("late result");

    await expect(inFlight).resolves.toEqual({
      text: "late result",
      providerId: OLLAMA_PROVIDER_ID,
      runtime: "ollama",
      contextTruncated: false,
    });

    // …but the disposed instance still refuses new generations.
    await expect(runtime.generateText({ prompt: "after" })).rejects.toBeInstanceOf(
      OllamaRuntimeDisposedError,
    );
  });

  it("cancel is a no-op (HTTP-based generation not cancellable)", async () => {
    const mockClient = createMockClient();
    const runtime = runtimeWithMockClient(mockClient);

    // Should not throw
    runtime.cancel();

    const result = await runtime.generateText({ prompt: "hi" });
    expect(result.text).toBe("generated text");
  });
});

describe("createOllamaClient", () => {
  it("defaults to the fixed T2-01 loopback endpoint when no baseUrl is passed", async () => {
    const captured: { url: string | null } = { url: null };
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      captured.url = url;
      return {
        ok: true,
        json: async () => ({
          model: OLLAMA_MODEL,
          created_at: new Date().toISOString(),
          response: "test response",
          done: true,
        }),
      } as Response;
    });

    // No options at all — this is the production construction path.
    const client = createOllamaClient({ fetchImpl: mockFetch });
    await client.generate("test prompt");

    expect(captured.url).toBe(`${OLLAMA_BASE_URL}/api/generate`);
  });

  it("builds correct request URL and body for generate", async () => {
    const captured: { url: string | null; init: RequestInit | null } = { url: null, init: null };
    const mockFetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      captured.url = url;
      captured.init = init ?? null;
      return {
        ok: true,
        json: async () => ({
          model: OLLAMA_MODEL,
          created_at: new Date().toISOString(),
          response: "test response",
          done: true,
        }),
      } as Response;
    });

    const client = createOllamaClient({ fetchImpl: mockFetch, baseUrl: "http://test:11434" });
    await client.generate("test prompt", [], { temperature: 0.5, maxOutputTokens: 100 });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(captured.url).toBe("http://test:11434/api/generate");
    expect(captured.init?.method).toBe("POST");

    const body = JSON.parse(captured.init?.body as string);
    expect(body.model).toBe(OLLAMA_MODEL);
    expect(body.prompt).toContain("test prompt");
    expect(body.stream).toBe(false);
    expect(body.options?.temperature).toBe(0.5);
    expect(body.options?.num_predict).toBe(100);
  });

  it("generateDetailed returns Ollama metrics alongside the text and sends the identical request shape", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        model: OLLAMA_MODEL,
        created_at: new Date().toISOString(),
        response: "detailed response",
        done: true,
        prompt_eval_count: 1234,
        eval_count: 256,
        total_duration: 5_000_000_000,
        load_duration: 1_000_000_000,
        prompt_eval_duration: 500_000_000,
        eval_duration: 3_000_000_000,
      }),
    } as Response);

    const client = createOllamaClient({ fetchImpl: mockFetch });
    const detailed = await client.generateDetailed("test prompt", [], {
      temperature: 0.4,
      maxOutputTokens: 128,
    });

    expect(detailed.text).toBe("detailed response");
    // Nanoseconds -> milliseconds.
    expect(detailed.promptEvalCount).toBe(1234);
    expect(detailed.evalCount).toBe(256);
    expect(detailed.totalDurationMs).toBe(5000);
    expect(detailed.loadDurationMs).toBe(1000);
    expect(detailed.promptEvalDurationMs).toBe(500);
    expect(detailed.evalDurationMs).toBe(3000);

    // Same wire request as generate(): same model/prompt/stream/options.
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:11434/api/generate");
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe(OLLAMA_MODEL);
    expect(body.stream).toBe(false);
    expect(body.options).toEqual({ temperature: 0.4, num_predict: 128 });
  });

  it("generateDetailed reports null metrics when Ollama omits them (never fabricated)", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        model: OLLAMA_MODEL,
        created_at: new Date().toISOString(),
        response: "minimal response",
        done: true,
      }),
    } as Response);

    const client = createOllamaClient({ fetchImpl: mockFetch });
    const detailed = await client.generateDetailed("test prompt");

    expect(detailed.text).toBe("minimal response");
    expect(detailed.promptEvalCount).toBeNull();
    expect(detailed.evalCount).toBeNull();
    expect(detailed.totalDurationMs).toBeNull();
    expect(detailed.loadDurationMs).toBeNull();
    expect(detailed.promptEvalDurationMs).toBeNull();
    expect(detailed.evalDurationMs).toBeNull();
  });

  it("generateDetailed maps errors identically to generate()", async () => {
    const unreachable = createOllamaClient({
      fetchImpl: vi.fn().mockRejectedValue(new Error("ECONNREFUSED")),
    });
    await expect(unreachable.generateDetailed("p")).rejects.toBeInstanceOf(OllamaGenerationError);

    const modelMissing = createOllamaClient({
      fetchImpl: vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        statusText: "Not Found",
        json: async () => ({ error: "model 'qwen3:4b' not found" }),
      } as Response),
    });
    await expect(modelMissing.generateDetailed("p")).rejects.toBeInstanceOf(
      OllamaModelNotFoundError,
    );
  });

  it("checkAvailability returns available=false when fetch fails", async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));

    const client = createOllamaClient({ fetchImpl: mockFetch });
    const result = await client.checkAvailability();

    expect(result.available).toBe(false);
    expect(result.reason).toContain("ECONNREFUSED");
  });

  it("checkAvailability returns available=false when model not in tags", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        models: [{ name: "other-model", model: "other-model", modified_at: "", size: 0, digest: "" }],
      }),
    } as Response);

    const client = createOllamaClient({ fetchImpl: mockFetch });
    const result = await client.checkAvailability();

    expect(result.available).toBe(false);
    expect(result.reason).toContain(OLLAMA_MODEL);
  });
});

describe("production Ollama source boundary", () => {
  it("pins the T2-01 fixed loopback endpoint and model", () => {
    expect(OLLAMA_BASE_URL).toBe("http://127.0.0.1:11434");
    expect(OLLAMA_MODEL).toBe("qwen3:4b");
  });
});