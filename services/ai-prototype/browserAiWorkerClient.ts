/**
 * Checkpoint 2A — main-thread client for the Browser AI Worker
 * (PROTOTYPE ONLY).
 *
 * The Worker (and therefore `@huggingface/transformers`) is constructed
 * lazily — `new Worker(...)` only runs inside `initModel()`, which the
 * test page only calls when the user explicitly clicks a button.
 * Nothing here runs on module import or page load (checkpoint spec §9,
 * §10 — "Do NOT silently download the model on application/page load").
 *
 * Only ever sends/receives the plain-data shapes in `workerProtocol.ts`.
 */

import type { ChatMessage } from "./promptBuilder";
import type {
  AiWorkerDevice,
  AiWorkerGenerationDiagnostic,
  AiWorkerInitProgress,
  AiWorkerResponse,
} from "./workerProtocol";

export interface BrowserAiWorkerClientCallbacks {
  onInitProgress?: (progress: AiWorkerInitProgress) => void;
  onToken?: (requestId: string, text: string) => void;
}

export interface GenerateResult {
  text: string;
  inferenceMs: number;
  outputCharacters: number;
  cancelled: boolean;
  /** [Checkpoint 2A diagnostic] Present when a generation completed (not cancelled) — see AiWorkerGenerationDiagnostic. */
  diagnostic: AiWorkerGenerationDiagnostic | null;
}

/**
 * Thin, explicit-lifecycle wrapper: `initModel()` must be called (and
 * awaited) before `generate()`. This mirrors the checkpoint's own
 * required flow (load model -> load PDF -> build context -> prompt ->
 * infer -> display -> record timings) rather than hiding init behind
 * generate's first call, so the test page can show/measure model-load
 * time as its own distinct step.
 */
export class BrowserAiWorkerClient {
  private worker: Worker | null = null;
  private pendingGenerate = new Map<
    string,
    {
      resolve: (result: GenerateResult) => void;
      reject: (error: Error) => void;
      text: string;
    }
  >();

  constructor(private readonly callbacks: BrowserAiWorkerClientCallbacks = {}) {}

  async initModel(options: { device: AiWorkerDevice; modelId: string; dtype: string }): Promise<{
    modelInitMs: number;
  }> {
    if (this.worker) {
      throw new Error("initModel() already called on this client instance.");
    }

    this.worker = new Worker(new URL("./browserAiWorker.ts", import.meta.url), {
      type: "module",
    });

    return new Promise((resolve, reject) => {
      const worker = this.worker;
      if (!worker) {
        reject(new Error("Worker failed to construct."));
        return;
      }

      worker.onmessage = (event: MessageEvent<AiWorkerResponse>) => {
        const message = event.data;

        if (message.type === "init-progress") {
          this.callbacks.onInitProgress?.(message);
          return;
        }

        if (message.type === "ready") {
          worker.onmessage = this.mainMessageHandler;
          resolve({ modelInitMs: message.modelInitMs });
          return;
        }

        if (message.type === "error" && message.duringInit) {
          reject(new Error(message.message));
        }
      };

      worker.onerror = (event: ErrorEvent) => {
        reject(new Error(`Worker error during init: ${event.message}`));
      };

      worker.postMessage({
        type: "init",
        device: options.device,
        modelId: options.modelId,
        dtype: options.dtype,
      });
    });
  }

  private mainMessageHandler = (event: MessageEvent<AiWorkerResponse>): void => {
    const message = event.data;

    if (message.type === "token") {
      const pending = this.pendingGenerate.get(message.requestId);
      if (pending) {
        pending.text += message.text;
      }
      this.callbacks.onToken?.(message.requestId, message.text);
      return;
    }

    if (message.type === "done") {
      const pending = this.pendingGenerate.get(message.requestId);
      pending?.resolve({
        text: message.text,
        inferenceMs: message.inferenceMs,
        outputCharacters: message.outputCharacters,
        cancelled: false,
        diagnostic: message.diagnostic,
      });
      this.pendingGenerate.delete(message.requestId);
      return;
    }

    if (message.type === "cancelled") {
      const pending = this.pendingGenerate.get(message.requestId);
      pending?.resolve({
        text: pending.text,
        inferenceMs: 0,
        outputCharacters: pending.text.length,
        cancelled: true,
        diagnostic: null,
      });
      this.pendingGenerate.delete(message.requestId);
      return;
    }

    if (message.type === "error") {
      if (message.requestId) {
        const pending = this.pendingGenerate.get(message.requestId);
        pending?.reject(new Error(message.message));
        this.pendingGenerate.delete(message.requestId);
      }
    }
  };

  generate(messages: ChatMessage[], maxNewTokens: number): { requestId: string; result: Promise<GenerateResult> } {
    if (!this.worker) {
      throw new Error("initModel() must complete before generate().");
    }

    const requestId = crypto.randomUUID();

    const result = new Promise<GenerateResult>((resolve, reject) => {
      this.pendingGenerate.set(requestId, { resolve, reject, text: "" });
    });

    this.worker.postMessage({
      type: "generate",
      requestId,
      messages,
      maxNewTokens,
    });

    return { requestId, result };
  }

  /** Real cancellation via InterruptableStoppingCriteria in the worker — see browserAiWorker.ts. Resolves (not rejects) the pending generate() promise with `cancelled: true` once the worker confirms. */
  cancel(requestId: string): void {
    if (!this.worker) return;
    this.worker.postMessage({ type: "cancel", requestId });
  }

  /** Tears the worker down entirely — used by the test page's "reset" action to prove a fresh init can run again afterward (checkpoint spec §12: "whether another inference can start afterward"). */
  terminate(): void {
    this.worker?.terminate();
    this.worker = null;
    this.pendingGenerate.clear();
  }
}
