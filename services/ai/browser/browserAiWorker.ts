/**
 * Production Browser AI Worker.
 *
 * Isolated from the PDF.js worker (`services/pdf/*`). Loads
 * `@huggingface/transformers` only on `init` — importing this module
 * does not download the model. Uses documented
 * `InterruptableStoppingCriteria` for real cancellation.
 *
 * Receives/returns only the plain-data shapes in `workerProtocol.ts`.
 */

import type {
  AiWorkerCancelRequest,
  AiWorkerGenerateRequest,
  AiWorkerInitRequest,
  AiWorkerRequest,
  AiWorkerResponse,
} from "./workerProtocol";

/**
 * This project's tsconfig only includes the DOM lib. Referencing
 * `webworker` globally conflicts with `Window`-flavored `self`. Narrow
 * locally instead (same approach as the Checkpoint 2A prototype).
 */
interface AiWorkerGlobalScope {
  postMessage(message: AiWorkerResponse): void;
  onmessage: ((event: MessageEvent<AiWorkerRequest>) => void) | null;
}
const workerSelf = self as unknown as AiWorkerGlobalScope;

type TransformersModule = typeof import("@huggingface/transformers");
type TextGenerationPipelineInstance = InstanceType<TransformersModule["TextGenerationPipeline"]>;

let transformersModule: TransformersModule | null = null;
let generator: TextGenerationPipelineInstance | null = null;
let activeStoppingCriteria: InstanceType<
  TransformersModule["InterruptableStoppingCriteria"]
> | null = null;
let ready = false;
/** Cancel may arrive before `generate` if the main thread races the Worker. */
let pendingCancelRequestId: string | null = null;

function post(message: AiWorkerResponse): void {
  workerSelf.postMessage(message);
}

function errorMessageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

async function handleInit(request: AiWorkerInitRequest): Promise<void> {
  try {
    transformersModule = await import("@huggingface/transformers");
    const { pipeline, env } = transformersModule;

    if (request.device === "wasm" && env.backends.onnx.wasm) {
      env.backends.onnx.wasm.proxy = false;
    }

    generator = (await pipeline("text-generation", request.modelId, {
      device: request.device,
      dtype: request.dtype as never,
    })) as unknown as TextGenerationPipelineInstance;

    ready = true;
    post({ type: "ready", device: request.device });
  } catch (error) {
    ready = false;
    generator = null;
    transformersModule = null;
    post({
      type: "error",
      message: `Model initialization failed: ${errorMessageOf(error)}`,
      duringInit: true,
    });
  }
}

async function handleGenerate(request: AiWorkerGenerateRequest): Promise<void> {
  if (pendingCancelRequestId === request.requestId) {
    pendingCancelRequestId = null;
    post({ type: "cancelled", requestId: request.requestId });
    return;
  }
  pendingCancelRequestId = null;

  if (!generator || !transformersModule || !ready) {
    post({
      type: "error",
      requestId: request.requestId,
      message: "Generate called before the model finished initializing.",
    });
    return;
  }

  const { TextStreamer, InterruptableStoppingCriteria } = transformersModule;
  const stoppingCriteria = new InterruptableStoppingCriteria();
  activeStoppingCriteria = stoppingCriteria;

  let outputText = "";
  const streamer = new TextStreamer(
    (generator as unknown as { tokenizer: unknown }).tokenizer as never,
    {
      skip_prompt: true,
      skip_special_tokens: true,
      callback_function: (chunkText: string) => {
        outputText += chunkText;
      },
    } as never,
  );

  try {
    await generator(request.messages as never, {
      max_new_tokens: request.maxNewTokens,
      do_sample: false,
      streamer,
      stopping_criteria: [stoppingCriteria],
    } as never);

    if (stoppingCriteria.interrupted) {
      post({ type: "cancelled", requestId: request.requestId });
    } else {
      post({
        type: "done",
        requestId: request.requestId,
        text: outputText,
      });
    }
  } catch (error) {
    post({
      type: "error",
      requestId: request.requestId,
      message: `Generation failed: ${errorMessageOf(error)}`,
    });
  } finally {
    activeStoppingCriteria = null;
  }
}

function handleCancel(request: AiWorkerCancelRequest): void {
  if (activeStoppingCriteria) {
    activeStoppingCriteria.interrupt();
    return;
  }

  pendingCancelRequestId = request.requestId;
}

workerSelf.onmessage = (event: MessageEvent<AiWorkerRequest>) => {
  const request = event.data;

  switch (request.type) {
    case "init":
      void handleInit(request);
      break;
    case "generate":
      void handleGenerate(request);
      break;
    case "cancel":
      handleCancel(request);
      break;
  }
};
