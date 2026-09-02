import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AiContextChunk } from "../types";
import {
  AiRequestValidationError,
  ProhibitedAiRequestFieldError,
  assertValidAiCapabilities,
} from "../validation";
import {
  BROWSER_AI_MAX_CONTEXT_CHARACTERS,
  BROWSER_AI_MODEL_DTYPE,
  BROWSER_AI_MODEL_ID,
  TRANSFORMERS_JS_VERSION,
} from "./constants";
import {
  AiConcurrentGenerationError,
  AiGenerationCancelledError,
  AiGenerationError,
  AiModelInitializationError,
  AiRuntimeDisposedError,
  AiRuntimeUnavailableError,
  BrowserAiRuntime,
  boundContextChunks,
  buildBrowserAiMessages,
  probeBrowserAiAvailability,
  selectBrowserAiDevice,
} from "./browserAiRuntime";
import type { AiWorkerRequest, AiWorkerResponse } from "./workerProtocol";

function availableAlways() {
  return Promise.resolve({ available: true as const });
}

class FakeWorker {
  onmessage: ((event: MessageEvent<AiWorkerResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  lastGenerate: Extract<AiWorkerRequest, { type: "generate" }> | null = null;
  generateHold = false;
  initHold = false;
  failInit = false;
  failGenerate = false;
  generateCalls = 0;
  initCalls = 0;
  terminateCalls = 0;

  postMessage(data: AiWorkerRequest): void {
    queueMicrotask(() => this.dispatch(data));
  }

  terminate(): void {
    this.terminateCalls += 1;
  }

  emit(message: AiWorkerResponse): void {
    this.onmessage?.({ data: message } as MessageEvent<AiWorkerResponse>);
  }

  private dispatch(data: AiWorkerRequest): void {
    if (data.type === "init") {
      this.initCalls += 1;
      if (this.initHold) {
        return;
      }
      if (this.failInit) {
        this.emit({
          type: "error",
          duringInit: true,
          message: "simulated init failure",
        });
        return;
      }
      this.emit({ type: "ready", device: "wasm" });
      return;
    }

    if (data.type === "generate") {
      this.generateCalls += 1;
      this.lastGenerate = data;
      if (this.generateHold) {
        return;
      }
      if (this.failGenerate) {
        this.emit({
          type: "error",
          requestId: data.requestId,
          message: "simulated generation failure",
        });
        return;
      }
      this.emit({
        type: "done",
        requestId: data.requestId,
        text: "generated text",
      });
      return;
    }

    if (data.type === "cancel" && this.lastGenerate) {
      this.emit({ type: "cancelled", requestId: data.requestId });
    }
  }
}

function runtimeWith(worker: FakeWorker): BrowserAiRuntime {
  return new BrowserAiRuntime({
    workerFactory: () => worker as unknown as Worker,
    availabilityCheck: availableAlways,
    selectDevice: () => Promise.resolve("wasm"),
  });
}

/** Returns workers from a fixed script in order, then falls back to fresh `FakeWorker`s — lets a test pre-configure (e.g. `generateHold`/`initHold`) the worker a given `generateText()` call will receive, while still exercising the real `workerFactory()` path for any later re-initialization. */
function scriptedWorkerFactory(...scripted: FakeWorker[]): {
  factory: () => Worker;
  workers: FakeWorker[];
} {
  const workers: FakeWorker[] = [];
  let index = 0;
  const factory = () => {
    const worker = index < scripted.length ? scripted[index] : new FakeWorker();
    index += 1;
    workers.push(worker);
    return worker as unknown as Worker;
  };
  return { factory, workers };
}

function runtimeWithFactory(
  factory: () => Worker,
  selectDevice: () => Promise<"wasm" | "webgpu"> = () => Promise.resolve("wasm"),
): BrowserAiRuntime {
  return new BrowserAiRuntime({
    workerFactory: factory,
    availabilityCheck: availableAlways,
    selectDevice,
  });
}

describe("BrowserAiRuntime capabilities", () => {
  it("exposes a valid capability object that matches the implemented surface", () => {
    const runtime = runtimeWith(new FakeWorker());

    expect(() => assertValidAiCapabilities(runtime.capabilities)).not.toThrow();
    expect(runtime.capabilities.providerId).toBe("browser-ai");
    expect(runtime.capabilities.displayName).toBe("Browser AI");
    expect(runtime.capabilities.runtime).toBe("browser");
    expect(runtime.capabilities.isLocal).toBe(true);
    expect(runtime.capabilities.requiresConsent).toBe(false);
    expect(runtime.capabilities.supportsTextGeneration).toBe(true);
    expect(runtime.capabilities.supportsToolCalling).toBe(false);
    expect(runtime.capabilities.supportsStreaming).toBe(false);
  });
});

describe("probeBrowserAiAvailability", () => {
  it("reports unavailable when Web Workers are missing", async () => {
    const result = await probeBrowserAiAvailability({
      WebAssembly: {},
    });

    expect(result.available).toBe(false);
    expect(result.reason).toMatch(/Web Workers/i);
  });

  it("reports unavailable when WebAssembly is missing", async () => {
    const result = await probeBrowserAiAvailability({
      Worker: function WorkerStub() {},
    });

    expect(result.available).toBe(false);
    expect(result.reason).toMatch(/WebAssembly/i);
  });

  it("reports available when Worker and WebAssembly exist, even without WebGPU", async () => {
    const result = await probeBrowserAiAvailability({
      Worker: function WorkerStub() {},
      WebAssembly: {},
    });

    expect(result).toEqual({ available: true });
  });

  it("selects wasm unless requestAdapter actually returns an adapter", async () => {
    await expect(selectBrowserAiDevice({})).resolves.toBe("wasm");
    await expect(
      selectBrowserAiDevice({
        navigator: { gpu: { requestAdapter: async () => null } },
      }),
    ).resolves.toBe("wasm");
    await expect(
      selectBrowserAiDevice({
        navigator: { gpu: { requestAdapter: async () => ({}) } },
      }),
    ).resolves.toBe("webgpu");
  });
});

describe("BrowserAiRuntime.generateText contract", () => {
  it("rejects invalid and prohibited request data before touching the Worker", async () => {
    const worker = new FakeWorker();
    const runtime = runtimeWith(worker);

    await expect(runtime.generateText({ prompt: "   " })).rejects.toBeInstanceOf(
      AiRequestValidationError,
    );
    await expect(
      runtime.generateText({
        prompt: "Summarize",
        file: new File(["pdf"], "doc.pdf"),
      } as never),
    ).rejects.toBeInstanceOf(ProhibitedAiRequestFieldError);

    expect(worker.initCalls).toBe(0);
    expect(worker.generateCalls).toBe(0);
  });

  it("rejects generation when the runtime is unavailable", async () => {
    const runtime = new BrowserAiRuntime({
      workerFactory: () => new FakeWorker() as unknown as Worker,
      availabilityCheck: () =>
        Promise.resolve({ available: false, reason: "no worker" }),
    });

    await expect(runtime.generateText({ prompt: "Hello" })).rejects.toBeInstanceOf(
      AiRuntimeUnavailableError,
    );
  });

  it("returns a valid AiTextGenerationResult and sends only text to the Worker", async () => {
    const worker = new FakeWorker();
    const runtime = runtimeWith(worker);

    const result = await runtime.generateText({
      prompt: "Summarize this.",
      contextChunks: [
        {
          chunkIndex: 0,
          pageNumber: 1,
          text: "Extracted page text.",
          startOffset: 0,
          endOffset: 20,
        },
      ],
      settings: { maxOutputTokens: 64 },
    });

    expect(result).toEqual({
      text: "generated text",
      providerId: "browser-ai",
      runtime: "browser",
      contextTruncated: false,
    });
    expect(worker.lastGenerate?.messages).toEqual(
      buildBrowserAiMessages("Summarize this.", [
        {
          chunkIndex: 0,
          pageNumber: 1,
          text: "Extracted page text.",
          startOffset: 0,
          endOffset: 20,
        },
      ]),
    );
    expect(JSON.stringify(worker.lastGenerate)).not.toMatch(
      /"file"|"blob"|"fileBytes"|"arrayBuffer"|"password"|"pageImage"|"thumbnail"|"metadata"/,
    );
    expect(worker.lastGenerate?.maxNewTokens).toBe(64);
  });

  it("propagates model initialization failures", async () => {
    const worker = new FakeWorker();
    worker.failInit = true;
    const runtime = runtimeWith(worker);

    await expect(runtime.generateText({ prompt: "Hello" })).rejects.toBeInstanceOf(
      AiModelInitializationError,
    );
  });

  it("propagates generation failures", async () => {
    const worker = new FakeWorker();
    worker.failGenerate = true;
    const runtime = runtimeWith(worker);

    await expect(runtime.generateText({ prompt: "Hello" })).rejects.toBeInstanceOf(
      AiGenerationError,
    );
  });

  it("cancels an in-flight generation and allows a later generation", async () => {
    const worker = new FakeWorker();
    worker.generateHold = true;
    const runtime = runtimeWith(worker);

    const first = runtime.generateText({ prompt: "first" });
    await vi.waitFor(() => expect(worker.lastGenerate).not.toBeNull());

    runtime.cancel();
    await expect(first).rejects.toBeInstanceOf(AiGenerationCancelledError);

    worker.generateHold = false;
    const second = await runtime.generateText({ prompt: "second" });
    expect(second.text).toBe("generated text");
    expect(worker.generateCalls).toBe(2);
  });

  it("rejects a second generateText while one is in flight", async () => {
    const worker = new FakeWorker();
    worker.generateHold = true;
    const runtime = runtimeWith(worker);

    const first = runtime.generateText({ prompt: "first" });
    await expect(runtime.generateText({ prompt: "second" })).rejects.toBeInstanceOf(
      AiConcurrentGenerationError,
    );

    runtime.cancel();
    await expect(first).rejects.toBeInstanceOf(AiGenerationCancelledError);
  });
});

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

describe("boundContextChunks", () => {
  it("returns empty truncated=false for empty array", () => {
    expect(boundContextChunks([], BROWSER_AI_MAX_CONTEXT_CHARACTERS)).toEqual({
      chunks: [],
      truncated: false,
    });
  });

  it("returns all chunks when within budget", () => {
    const chunks = [
      makeChunk({ chunkIndex: 0, text: "a".repeat(3000) }),
      makeChunk({ chunkIndex: 1, text: "b".repeat(3000) }),
    ];
    const result = boundContextChunks(chunks, BROWSER_AI_MAX_CONTEXT_CHARACTERS);
    expect(result.chunks).toHaveLength(2);
    expect(result.truncated).toBe(false);
    expect(result.chunks[0].text).toBe(chunks[0].text);
    expect(result.chunks[1].text).toBe(chunks[1].text);
  });

  it("truncates trailing chunks when total exceeds 8192 and does not slice", () => {
    const a = makeChunk({ chunkIndex: 0, text: "a".repeat(3000) });
    const b = makeChunk({ chunkIndex: 1, text: "b".repeat(3000) });
    const c = makeChunk({ chunkIndex: 2, text: "c".repeat(3000) });
    const original = [a, b, c];
    const originalSnapshot = original.map((ch) => ({ ...ch }));
    const result = boundContextChunks(original, BROWSER_AI_MAX_CONTEXT_CHARACTERS);
    // A+B=6000 fits, C would make 9000 >8192 => truncated
    expect(result.chunks).toHaveLength(2);
    expect(result.chunks[0].text).toBe("a".repeat(3000));
    expect(result.chunks[1].text).toBe("b".repeat(3000));
    expect(result.truncated).toBe(true);
    // no mutation
    expect(original).toHaveLength(3);
    expect(original[0].text).toBe(originalSnapshot[0].text);
    // deterministic: later chunks not included
    expect(result.chunks.map((ch) => ch.chunkIndex)).toEqual([0, 1]);
  });

  it("returns zero chunks truncated=true when first chunk alone exceeds budget", () => {
    const huge = makeChunk({ text: "x".repeat(9000) });
    const result = boundContextChunks([huge], BROWSER_AI_MAX_CONTEXT_CHARACTERS);
    expect(result.chunks).toHaveLength(0);
    expect(result.truncated).toBe(true);
  });

  it("does not skip an oversized chunk to include later ones", () => {
    const huge = makeChunk({ chunkIndex: 0, text: "x".repeat(9000) });
    const small = makeChunk({ chunkIndex: 1, text: "y".repeat(100) });
    const result = boundContextChunks([huge, small], BROWSER_AI_MAX_CONTEXT_CHARACTERS);
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

describe("BrowserAiRuntime context budget integration", () => {
  it("sends all chunks and contextTruncated=false when within 8192", async () => {
    const worker = new FakeWorker();
    const runtime = runtimeWith(worker);
    const chunks = [
      makeChunk({ chunkIndex: 0, text: "a".repeat(1000) }),
      makeChunk({ chunkIndex: 1, text: "b".repeat(1000) }),
    ];
    const result = await runtime.generateText({ prompt: "hi", contextChunks: chunks });
    expect(result.contextTruncated).toBe(false);
    expect(worker.lastGenerate?.messages).toEqual(buildBrowserAiMessages("hi", chunks));
  });

  it("truncates trailing chunks and reports contextTruncated=true", async () => {
    const worker = new FakeWorker();
    const runtime = runtimeWith(worker);
    const a = makeChunk({ chunkIndex: 0, text: "a".repeat(3000) });
    const b = makeChunk({ chunkIndex: 1, text: "b".repeat(3000) });
    const c = makeChunk({ chunkIndex: 2, text: "c".repeat(3000) });
    const result = await runtime.generateText({
      prompt: "hi",
      contextChunks: [a, b, c],
    });
    expect(result.contextTruncated).toBe(true);
    const expected = buildBrowserAiMessages("hi", [a, b]);
    expect(worker.lastGenerate?.messages).toEqual(expected);
    // no partial slice
    expect(worker.lastGenerate?.messages[1].content).not.toContain("c");
  });

  it("handles empty and undefined context as not truncated", async () => {
    const w1 = new FakeWorker();
    const r1 = runtimeWith(w1);
    const res1 = await r1.generateText({ prompt: "hi" });
    expect(res1.contextTruncated).toBe(false);
    expect(w1.lastGenerate?.messages).toEqual(buildBrowserAiMessages("hi", []));

    const w2 = new FakeWorker();
    const r2 = runtimeWith(w2);
    const res2 = await r2.generateText({ prompt: "hi", contextChunks: [] });
    expect(res2.contextTruncated).toBe(false);
  });

  it("handles oversized first chunk: zero chunks to Worker, truncated=true but still succeeds", async () => {
    const worker = new FakeWorker();
    const runtime = runtimeWith(worker);
    const huge = makeChunk({ text: "x".repeat(9000) });
    const result = await runtime.generateText({ prompt: "hi", contextChunks: [huge] });
    expect(result.contextTruncated).toBe(true);
    expect(result.text).toBe("generated text");
    expect(worker.lastGenerate?.messages).toEqual(buildBrowserAiMessages("hi", []));
  });

  it("does not include system prompt in budget — only chunk text length counts", async () => {
    const worker = new FakeWorker();
    const runtime = runtimeWith(worker);
    // prompt is long but should not affect truncation
    const longPrompt = "p".repeat(5000);
    const chunks = [makeChunk({ text: "a".repeat(8000) })];
    const result = await runtime.generateText({ prompt: longPrompt, contextChunks: chunks });
    expect(result.contextTruncated).toBe(false);
  });
});

describe("BrowserAiRuntime lifecycle hardening", () => {
  it("dispose during pending generation rejects with AiRuntimeDisposedError and allows next generation", async () => {
    const w1 = new FakeWorker();
    w1.generateHold = true;
    const { factory, workers } = scriptedWorkerFactory(w1, new FakeWorker());
    const runtime = runtimeWithFactory(factory);

    const first = runtime.generateText({ prompt: "first" });
    await vi.waitFor(() => expect(workers[0].lastGenerate).not.toBeNull());

    runtime.dispose();
    await expect(first).rejects.toBeInstanceOf(AiRuntimeDisposedError);

    // next generation must succeed with fresh worker
    const second = await runtime.generateText({ prompt: "second" });
    expect(second.text).toBe("generated text");
    expect(second.contextTruncated).toBe(false);
    expect(workers).toHaveLength(2);
    expect(workers[1].initCalls).toBe(1);
  });

  it("dispose during initialization rejects and remains reusable", async () => {
    const w1 = new FakeWorker();
    w1.initHold = true;
    const { factory, workers } = scriptedWorkerFactory(w1, new FakeWorker());
    const runtime = runtimeWithFactory(factory);

    const pending = runtime.generateText({ prompt: "hello" });
    // give ensureInitialized time to start initHold
    await new Promise((r) => setTimeout(r, 10));
    runtime.dispose();
    await expect(pending).rejects.toBeInstanceOf(AiRuntimeDisposedError);

    const second = await runtime.generateText({ prompt: "after" });
    expect(second.text).toBe("generated text");
    expect(workers).toHaveLength(2);
  });

  it("Worker.onerror during generation discards broken Worker and next generation uses new Worker", async () => {
    const w1 = new FakeWorker();
    w1.generateHold = true;
    const { factory, workers } = scriptedWorkerFactory(w1, new FakeWorker());
    const runtime = runtimeWithFactory(factory);

    const first = runtime.generateText({ prompt: "first" });
    await vi.waitFor(() => expect(workers[0].lastGenerate).not.toBeNull());

    // simulate thread-level crash
    workers[0].onerror?.({ message: "thread crash" } as ErrorEvent);

    await expect(first).rejects.toBeInstanceOf(AiGenerationError);
    expect(workers[0].terminateCalls).toBe(1);

    const second = await runtime.generateText({ prompt: "second" });
    expect(second.text).toBe("generated text");
    expect(workers).toHaveLength(2);
    expect(workers[1].initCalls).toBe(1);
    expect(workers[1].generateCalls).toBe(1);
  });

  it("selectDevice rejection rejects generateText, resets inFlight, and remains reusable", async () => {
    let shouldReject = true;
    const selectDevice = () =>
      shouldReject ? Promise.reject(new Error("device probe failed")) : Promise.resolve("wasm" as const);
    const { factory, workers } = scriptedWorkerFactory(new FakeWorker(), new FakeWorker());
    const runtime = runtimeWithFactory(factory, selectDevice);

    await expect(runtime.generateText({ prompt: "first" })).rejects.toBeInstanceOf(
      AiModelInitializationError,
    );
    // inFlight must have reset — second call should not throw concurrent error
    shouldReject = false;
    const second = await runtime.generateText({ prompt: "second" });
    expect(second.text).toBe("generated text");
    expect(workers).toHaveLength(2);
  });

  it("late messages after dispose cannot settle a later generation", async () => {
    const w1 = new FakeWorker();
    w1.generateHold = true;
    const w2 = new FakeWorker();
    const { factory, workers } = scriptedWorkerFactory(w1, w2);
    const runtime = runtimeWithFactory(factory);

    const first = runtime.generateText({ prompt: "first" });
    await vi.waitFor(() => expect(workers[0].lastGenerate).not.toBeNull());
    const firstRequestId = workers[0].lastGenerate!.requestId;

    runtime.dispose();
    await expect(first).rejects.toBeInstanceOf(AiRuntimeDisposedError);

    // late done from old worker with old requestId must not affect new generation
    const secondPromise = runtime.generateText({ prompt: "second" });
    // emit late message from disposed worker using old requestId
    workers[0].emit({ type: "done", requestId: firstRequestId, text: "late text" });
    // second should still resolve with its own worker's text, not late text
    const second = await secondPromise;
    expect(second.text).toBe("generated text");
    expect(second.text).not.toBe("late text");
  });
});

describe("production Browser AI source boundary", () => {
  it("pins the reviewed 0.5B q4 model rather than prototype experiment candidates", () => {
    expect(BROWSER_AI_MODEL_ID).toBe("onnx-community/Qwen2.5-0.5B-Instruct");
    expect(BROWSER_AI_MODEL_DTYPE).toBe("q4");
    expect(TRANSFORMERS_JS_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("does not import services/ai-prototype", () => {
    const dir = join(process.cwd(), "services", "ai", "browser");
    const files = [
      "browserAiRuntime.ts",
      "browserAiWorker.ts",
      "workerProtocol.ts",
      "constants.ts",
      "errors.ts",
    ];

    for (const fileName of files) {
      const source = readFileSync(join(dir, fileName), "utf-8");
      expect(source).not.toMatch(/from\s+["'][^"']*ai-prototype/);
      expect(source).not.toMatch(/import\s*\(\s*["'][^"']*ai-prototype/);
    }
  });
});
