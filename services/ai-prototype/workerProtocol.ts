/**
 * Checkpoint 2A — typed postMessage protocol between the main thread
 * (browserAiWorkerClient.ts) and the AI Worker (browserAiWorker.ts).
 *
 * Kept as a separate module (rather than inlined in either side) so both
 * sides import the same types instead of two hand-synced copies, and so
 * this module-level guarantee is visible in one place: every message
 * shape below carries only plain strings/numbers/booleans — the same
 * "text/settings only" boundary AI-01 (`services/ai/types.ts`) enforces
 * for a provider request, applied here to the worker boundary too.
 */

import type { ChatMessage } from "./promptBuilder";

export type AiWorkerDevice = "webgpu" | "wasm";

export interface AiWorkerInitRequest {
  type: "init";
  device: AiWorkerDevice;
  modelId: string;
  dtype: string;
}

export interface AiWorkerGenerateRequest {
  type: "generate";
  requestId: string;
  messages: ChatMessage[];
  maxNewTokens: number;
}

export interface AiWorkerCancelRequest {
  type: "cancel";
  requestId: string;
}

export type AiWorkerRequest =
  | AiWorkerInitRequest
  | AiWorkerGenerateRequest
  | AiWorkerCancelRequest;

export interface AiWorkerInitProgress {
  type: "init-progress";
  /** Raw progress event forwarded from Transformers.js's `progress_callback` — status/file/loaded/total, all plain data. */
  status: string;
  file?: string;
  loaded?: number;
  total?: number;
}

export interface AiWorkerReady {
  type: "ready";
  device: AiWorkerDevice;
  modelId: string;
  dtype: string;
  modelInitMs: number;
}

export interface AiWorkerToken {
  type: "token";
  requestId: string;
  text: string;
}

/**
 * Checkpoint 2A — approved diagnostic instrumentation (read-only
 * investigation follow-up). Captures what TextStreamer actually saw
 * during generation, independent of the streamer's own
 * `skip_special_tokens` filtering, so a "0 output characters" result can
 * be distinguished between: no tokens generated, tokens generated but
 * discarded by special-token filtering, or tokens generated and passed
 * to the streamer but lost elsewhere. Does not alter generation
 * behavior — purely additional observation of the same generate() call.
 */
export interface AiWorkerGenerationDiagnostic {
  /** Count of tokens produced by generate() after the prompt (i.e. excluding the initial prompt-token batch the streamer receives first). */
  generatedTokenCount: number;
  /** How many of those generated tokens matched the tokenizer's own special-token ID set — the same set TextStreamer.put() checks via `special_ids.has(...)` before applying `skip_special_tokens`. */
  specialTokenCount: number;
  /** First few generated token IDs in generation order (small fixed sample, not the full sequence). */
  firstTokenIds: number[];
  /** Last few generated token IDs in generation order (small fixed sample, not the full sequence). */
  lastTokenIds: number[];
  /** All generated tokens decoded together with `skip_special_tokens: false`, so raw model output (including special-token markup) is visible even when the streamer's own `skip_special_tokens: true` path produced no visible text. Truncated to a fixed character bound before crossing the Worker boundary. */
  rawDecoded: string;
  /** Same value as the sibling AiWorkerDone.outputCharacters — repeated here so the diagnostic is self-contained when read on its own. */
  streamedOutputCharacters: number;
  /** Token count of the exact formatted chat prompt fed into generate(), measured immediately before the call. Null if diagnostic tokenization fails. */
  inputTokenCount: number | null;
}

export interface AiWorkerDone {
  type: "done";
  requestId: string;
  text: string;
  inferenceMs: number;
  outputCharacters: number;
  diagnostic: AiWorkerGenerationDiagnostic;
}

export interface AiWorkerCancelled {
  type: "cancelled";
  requestId: string;
}

export interface AiWorkerError {
  type: "error";
  requestId?: string;
  message: string;
  /** True when this error happened during `init` (model load), so the client knows a `generate` was never attempted. */
  duringInit?: boolean;
}

export type AiWorkerResponse =
  | AiWorkerInitProgress
  | AiWorkerReady
  | AiWorkerToken
  | AiWorkerDone
  | AiWorkerCancelled
  | AiWorkerError;
