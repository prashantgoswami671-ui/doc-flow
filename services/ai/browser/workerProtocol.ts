/**
 * Plain-data postMessage protocol between `browserAiRuntime.ts` (main
 * thread) and `browserAiWorker.ts`.
 *
 * Every payload is strings/numbers/booleans only. File, Blob, ArrayBuffer,
 * PDF bytes, passwords, images, thumbnails, and document metadata must
 * never cross this boundary.
 */

export type AiWorkerDevice = "webgpu" | "wasm";

export interface AiWorkerChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface AiWorkerInitRequest {
  type: "init";
  device: AiWorkerDevice;
  modelId: string;
  dtype: string;
}

export interface AiWorkerGenerateRequest {
  type: "generate";
  requestId: string;
  messages: AiWorkerChatMessage[];
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

export interface AiWorkerReady {
  type: "ready";
  device: AiWorkerDevice;
}

export interface AiWorkerDone {
  type: "done";
  requestId: string;
  text: string;
}

export interface AiWorkerCancelled {
  type: "cancelled";
  requestId: string;
}

export interface AiWorkerError {
  type: "error";
  requestId?: string;
  message: string;
  duringInit?: boolean;
}

export type AiWorkerResponse =
  | AiWorkerReady
  | AiWorkerDone
  | AiWorkerCancelled
  | AiWorkerError;
