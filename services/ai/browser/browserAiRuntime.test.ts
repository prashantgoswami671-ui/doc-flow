import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  AiRequestValidationError,
  ProhibitedAiRequestFieldError,
  assertValidAiCapabilities,
} from "../validation";
import {
  BROWSER_AI_MODEL_DTYPE,
  BROWSER_AI_MODEL_ID,
  TRANSFORMERS_JS_VERSION,
} from "./constants";
import {
  AiConcurrentGenerationError,
  AiGenerationCancelledError,
  AiGenerationError,
  AiModelInitializationError,
  AiRuntimeUnavailableError,
  BrowserAiRuntime,
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
  failInit = false;
  failGenerate = false;
  generateCalls = 0;
  initCalls = 0;

  postMessage(data: AiWorkerRequest): void {
    queueMicrotask(() => this.dispatch(data));
  }

  terminate(): void {}

  emit(message: AiWorkerResponse): void {
    this.onmessage?.({ data: message } as MessageEvent<AiWorkerResponse>);
  }

  private dispatch(data: AiWorkerRequest): void {
    if (data.type === "init") {
      this.initCalls += 1;
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
