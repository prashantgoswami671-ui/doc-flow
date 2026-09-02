/**
 * Checkpoint 2A — Browser AI Worker (PROTOTYPE ONLY).
 *
 * Runs entirely inside a dedicated Web Worker, independent of the
 * existing PDF.js worker (`services/pdf/*`) — no state is shared between
 * them (checkpoint spec §7). Loads `@huggingface/transformers` lazily
 * (only once this worker is actually started, which itself only happens
 * once the user explicitly triggers the prototype — see
 * browserAiWorkerClient.ts) and never on normal page load.
 *
 * [External verified fact] `InterruptableStoppingCriteria` is a real,
 * documented Transformers.js export (see
 * https://huggingface.co/docs/transformers.js/api/generation/stopping_criteria
 * and the official `transformers.js-examples` repo's
 * `llama-3.2-webgpu/src/worker.js` and `deepseek-r1-webgpu/src/worker.js`,
 * both of which use exactly this
 * `new InterruptableStoppingCriteria()` + `.interrupt()` + passing it via
 * `stopping_criteria` to `generate()` pattern). This prototype uses the
 * same pattern rather than inventing a cancellation mechanism — per the
 * checkpoint spec §12, "do not claim cancellation support merely because
 * the runtime uses async functions."
 *
 * Only ever receives/returns the plain-data shapes in `workerProtocol.ts`
 * — no `File`/`Blob`/`ArrayBuffer`/password/image ever crosses into this
 * worker; the main thread only ever sends already-built chat messages
 * whose document-derived portion is already-extracted, already-chunked
 * plain text (see promptBuilder.ts / services/ai/pipeline.ts).
 */

import type {
  AiWorkerCancelRequest,
  AiWorkerGenerateRequest,
  AiWorkerGenerationDiagnostic,
  AiWorkerInitRequest,
  AiWorkerRequest,
  AiWorkerResponse,
} from "./workerProtocol";

/**
 * [Technical inference / problem discovered] This project's tsconfig.json
 * only includes `"lib": ["dom", "dom.iterable", "esnext"]` (no
 * `"webworker"`). Adding `/// <reference lib="webworker" />` here would
 * pull in the webworker lib's own ambient `self`/`postMessage`/etc.
 * declarations project-wide during `tsc --noEmit`, which conflicts with
 * the `dom` lib's ambient `Window`-flavored `self` used everywhere else
 * in the app — a known TypeScript pitfall for exactly this
 * Next.js-app-plus-Worker-file shape. Rather than fight the global lib
 * configuration (which would need verifying against every other file in
 * the program, out of this prototype's scope), this file narrows the
 * ambient `self` to only the worker surface it actually uses via a local
 * cast. This must be re-examined if Checkpoint 2A's Turbopack build
 * (spec §9) reports a *different* worker-typing problem than this one.
 */
interface AiWorkerGlobalScope {
  postMessage(message: AiWorkerResponse): void;
  onmessage: ((event: MessageEvent<AiWorkerRequest>) => void) | null;
}
const workerSelf = self as unknown as AiWorkerGlobalScope;

// Lazily populated on first `init` — nothing from `@huggingface/transformers`
// is imported at module top level, so importing this worker module at all
// does not itself pull the dependency in until `init` actually runs.
type TransformersModule = typeof import("@huggingface/transformers");
// [Problem discovered] `Awaited<ReturnType<TransformersModule["pipeline"]>>`
// resolves to the union of ALL ~24 pipeline result types (TypeScript only
// uses the LAST overload signature of an overloaded function when you take
// its ReturnType), which is not callable as a single function (TS2349,
// confirmed by `tsc --noEmit`). `pipeline()` is overloaded per literal task
// name, so narrow explicitly to the one concrete pipeline class this
// prototype actually uses instead.
type TextGenerationPipelineInstance = InstanceType<TransformersModule["TextGenerationPipeline"]>;

let transformersModule: TransformersModule | null = null;
let generator: TextGenerationPipelineInstance | null = null;
let activeStoppingCriteria: InstanceType<TransformersModule["InterruptableStoppingCriteria"]> | null =
  null;
let readyDevice: "webgpu" | "wasm" | null = null;
let readyModelId: string | null = null;
let readyDtype: string | null = null;

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
  const startTime = performance.now();

  try {
    // Dynamic import — this is the "lazy-loaded so users who never use AI
    // do not pay the full dependency cost" requirement (checkpoint spec
    // §9), applied at the worker level. The worker itself is also only
    // constructed on explicit user action (browserAiWorkerClient.ts).
    transformersModule = await import("@huggingface/transformers");

    const { pipeline, env } = transformersModule;

    // Explicit device selection per request — the prototype's WebGPU and
    // WASM test paths (checkpoint spec §8) each call `init` with a fixed
    // `device`, rather than letting Transformers.js silently choose, so a
    // WebGPU failure is visible as an error for that path instead of a
    // silent WASM fallback masking the result.
    if (request.device === "wasm") {
      // Force CPU/WASM execution — do not let a WebGPU-capable browser
      // pick GPU anyway, since this path exists specifically to measure
      // WASM behavior in isolation (checkpoint spec §8, "WASM path").
      // `env.backends.onnx.wasm` is typed as possibly undefined (TS18048,
      // confirmed by `tsc --noEmit`) because Transformers.js populates it
      // lazily at runtime from the ONNX Runtime backend module — it is
      // guaranteed present by the time `pipeline()` has been called at
      // least once, but not necessarily before, so this guards rather
      // than asserting it away.
      if (env.backends.onnx.wasm) {
        env.backends.onnx.wasm.proxy = false;
      }
    }

    generator = (await pipeline("text-generation", request.modelId, {
      device: request.device,
      dtype: request.dtype as never,
      progress_callback: (progress: Record<string, unknown>) => {
        post({
          type: "init-progress",
          status: String(progress.status ?? "progress"),
          file: typeof progress.file === "string" ? progress.file : undefined,
          loaded: typeof progress.loaded === "number" ? progress.loaded : undefined,
          total: typeof progress.total === "number" ? progress.total : undefined,
        });
      },
    })) as unknown as TextGenerationPipelineInstance;

    readyDevice = request.device;
    readyModelId = request.modelId;
    readyDtype = request.dtype;

    post({
      type: "ready",
      device: request.device,
      modelId: request.modelId,
      dtype: request.dtype,
      modelInitMs: performance.now() - startTime,
    });
  } catch (error) {
    post({
      type: "error",
      message: `Model init failed (device=${request.device}, model=${request.modelId}): ${errorMessageOf(error)}`,
      duringInit: true,
    });
  }
}

/**
 * [Checkpoint 2A — approved diagnostic instrumentation] Minimal surface
 * this file needs from the generator's tokenizer to build a generation
 * diagnostic, kept separate from the `TextStreamer` constructor's own
 * `as never` cast so this one is precisely typed instead of widened.
 * `all_special_ids` and `decode` are real `PreTrainedTokenizer` members
 * (see node_modules/@huggingface/transformers/src/generation/streamers.js,
 * which reads `tokenizer.all_special_ids` the same way, and
 * src/pipelines/text-generation.js, which calls `tokenizer.batch_decode`
 * built on the same `decode`).
 */
interface DiagnosticTokenizer {
  all_special_ids: number[];
  decode(ids: (number | bigint)[], options?: { skip_special_tokens?: boolean }): string;
  /** [Checkpoint 2A/2B diagnostic] Real, documented `PreTrainedTokenizer.apply_chat_template` member (see node_modules/@huggingface/transformers/src/tokenization_utils.js) — with `tokenize: false` it returns the rendered chat-template string, exactly the first of the two steps `TextGenerationPipeline._call` performs on chat input before tokenizing (src/pipelines/text-generation.js). */
  apply_chat_template(
    conversation: { role: string; content: string }[],
    options?: { tokenize?: boolean; add_generation_prompt?: boolean },
  ): string;
  /** [Checkpoint 2A/2B diagnostic] The tokenizer instance is itself `Callable` (`_call`) — invoking it directly reproduces the second of the two steps `TextGenerationPipeline._call` performs on chat input: `this.tokenizer(inputs, { add_special_tokens: false, padding: true, truncation: true, ... })`. `return_tensor: false` returns plain arrays instead of a Tensor. */
  (
    text: string,
    options?: {
      add_special_tokens?: boolean;
      padding?: boolean;
      truncation?: boolean;
      return_tensor?: boolean;
    },
  ): { input_ids: number[] };
}

/** Small fixed sample size for the diagnostic's first/last token IDs — enough to eyeball the sequence without dumping hundreds of tokens into the UI log (checkpoint spec: "Avoid dumping hundreds of tokens into the UI log"). */
const DIAGNOSTIC_TOKEN_SAMPLE_SIZE = 10;
/** Character bound for the diagnostic's raw-decoded text before it crosses the Worker boundary, for the same reason. */
const DIAGNOSTIC_RAW_DECODED_CHAR_LIMIT = 500;

async function handleGenerate(request: AiWorkerGenerateRequest): Promise<void> {
  if (!generator || !transformersModule || !readyDevice || !readyModelId || !readyDtype) {
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

  const diagnosticTokenizer = (generator as unknown as { tokenizer: DiagnosticTokenizer }).tokenizer;

  // [Checkpoint 2A/2B diagnostic] Input-token-count instrumentation
  // (approved follow-up to the read-only inspection). Reproduces the
  // exact two steps `TextGenerationPipeline._call` performs on chat
  // input (src/pipelines/text-generation.js) — (1) render the chat
  // template to a string via `apply_chat_template(..., { tokenize:
  // false, add_generation_prompt: true })`, then (2) tokenize that
  // string with the same flags the pipeline uses for chat input
  // (`add_special_tokens: false, padding: true, truncation: true`) —
  // on the SAME tokenizer instance (`diagnosticTokenizer`, i.e.
  // `generator.tokenizer`) the pipeline itself will use moments later
  // inside `generator(...)`. This read-only tokenization does not
  // touch the model/session and cannot include generated tokens, since
  // it runs entirely before generation starts. Placed before
  // `startTime` below so this diagnostic's own CPU cost is excluded
  // from `inferenceMs`. Never allowed to break inference: any failure
  // here is caught and recorded as `null`, not thrown.
  let inputTokenCount: number | null = null;
  try {
    const promptString = diagnosticTokenizer.apply_chat_template(request.messages, {
      tokenize: false,
      add_generation_prompt: true,
    });
    const encoded = diagnosticTokenizer(promptString, {
      add_special_tokens: false,
      padding: true,
      truncation: true,
      return_tensor: false,
    });
    inputTokenCount = encoded.input_ids.length;
  } catch {
    inputTokenCount = null;
  }

  // [Checkpoint 2A diagnostic] Every generated token ID, captured via
  // TextStreamer's own `token_callback_function` — a real, documented
  // constructor option (see streamers.js) distinct from
  // `callback_function`. This fires for every token TextStreamer.put()
  // receives INCLUDING ones `skip_special_tokens` will later cause
  // `callback_function` to never see, so it observes strictly more than
  // the existing `outputText` accumulation without changing what
  // `outputText` itself collects. `skip_prompt: true` still causes the
  // initial prompt-token batch to return before either callback fires
  // (see streamers.js `put()`), so this array only ever contains
  // generated tokens, never prompt tokens.
  const generatedTokenIds: bigint[] = [];

  let outputText = "";
  const streamer = new TextStreamer(
    (generator as unknown as { tokenizer: unknown }).tokenizer as never,
    {
      skip_prompt: true,
      skip_special_tokens: true,
      callback_function: (chunkText: string) => {
        outputText += chunkText;
        post({ type: "token", requestId: request.requestId, text: chunkText });
      },
      token_callback_function: (tokens: bigint[]) => {
        generatedTokenIds.push(...tokens);
      },
    } as never,
  );

  const startTime = performance.now();

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
      // [Checkpoint 2A diagnostic] Same special-token-ID set TextStreamer
      // itself checks (see streamers.js: `this.special_ids = new
      // Set(this.tokenizer.all_special_ids.map(BigInt))`), recomputed here
      // read-only so this file doesn't reach into the streamer instance's
      // internals.
      const specialIds = new Set(diagnosticTokenizer.all_special_ids.map((id) => BigInt(id)));
      const specialTokenCount = generatedTokenIds.reduce(
        (count, id) => (specialIds.has(id) ? count + 1 : count),
        0,
      );

      // [Checkpoint 2A diagnostic] Decoded with skip_special_tokens: false
      // — deliberately the opposite of the streamer's own decode_kwargs —
      // so special-token markup that skip_special_tokens:true would strip
      // is visible here even if it is invisible in `outputText`.
      const rawDecodedFull =
        generatedTokenIds.length > 0
          ? diagnosticTokenizer.decode(generatedTokenIds, { skip_special_tokens: false })
          : "";
      const rawDecoded =
        rawDecodedFull.length > DIAGNOSTIC_RAW_DECODED_CHAR_LIMIT
          ? `${rawDecodedFull.slice(0, DIAGNOSTIC_RAW_DECODED_CHAR_LIMIT)}…[truncated]`
          : rawDecodedFull;

      const diagnostic: AiWorkerGenerationDiagnostic = {
        generatedTokenCount: generatedTokenIds.length,
        specialTokenCount,
        firstTokenIds: generatedTokenIds.slice(0, DIAGNOSTIC_TOKEN_SAMPLE_SIZE).map(Number),
        lastTokenIds: generatedTokenIds.slice(-DIAGNOSTIC_TOKEN_SAMPLE_SIZE).map(Number),
        rawDecoded,
        streamedOutputCharacters: outputText.length,
        inputTokenCount,
      };

      post({
        type: "done",
        requestId: request.requestId,
        text: outputText,
        inferenceMs: performance.now() - startTime,
        outputCharacters: outputText.length,
        diagnostic,
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
  // Real interruption, not a hidden/discarded response (checkpoint spec
  // §12): this actually stops the in-progress `generate()` loop via the
  // same InterruptableStoppingCriteria instance passed into it above.
  if (activeStoppingCriteria) {
    activeStoppingCriteria.interrupt();
  } else {
    post({
      type: "error",
      requestId: request.requestId,
      message: "Cancel requested but no generation was in progress.",
    });
  }
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
