/**
 * AI-01 — Runtime validation for the AI provider/runtime contract.
 *
 * `services/ai/types.ts` enforces the SEC-06 request boundary at the type
 * level (prohibited fields typed `never`). That protects normal
 * TypeScript call sites but not: data crossing a JSON boundary, a
 * caller using `as`/`any`, or a malformed provider configuration. This
 * module is the runtime half of that boundary — every function here is
 * pure and dependency-free (no network, no DOM), so it is safe to unit
 * test directly and to call from any future provider implementation
 * before a request leaves the abstraction layer.
 */

import type {
  AiCapabilities,
  AiContextChunk,
  AiRequestSettings,
  AiRuntimeKind,
} from "./types";

/** Keys that must never appear (even as `undefined`-valued own properties are fine — presence with a defined value is what matters) on an AI request. Mirrors the `never`-typed fields in `AiTextGenerationRequest`. */
const PROHIBITED_REQUEST_KEYS = [
  "file",
  "blob",
  "fileBytes",
  "arrayBuffer",
  "password",
  "pageImage",
  "thumbnail",
  "metadata",
] as const;

const VALID_RUNTIME_KINDS: readonly AiRuntimeKind[] = [
  "browser",
  "ollama",
  "byok",
  "cloud",
];

export class AiRequestValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AiRequestValidationError";
  }
}

export class ProhibitedAiRequestFieldError extends AiRequestValidationError {
  readonly field: string;

  constructor(field: string) {
    super(
      `AI request contained prohibited field "${field}". Only extracted text/chunks, a prompt, and non-sensitive settings may be sent to an AI provider (see docs/SEC-06-AI-DATA-POLICY.md).`,
    );
    this.name = "ProhibitedAiRequestFieldError";
    this.field = field;
  }
}

/**
 * Recursively checks a value for binary/document-bearing payloads that
 * should never reach an AI provider, regardless of which key they were
 * assigned to. This is deliberately independent of
 * `PROHIBITED_REQUEST_KEYS` — it exists so that a PDF/file/password
 * payload cannot "accidentally satisfy" the request shape by arriving
 * under an unexpected or renamed key.
 */
export function containsDisallowedBinaryPayload(
  value: unknown,
  seen: Set<unknown> = new Set(),
): boolean {
  if (value === null || typeof value !== "object") {
    return false;
  }

  if (
    (typeof File !== "undefined" && value instanceof File) ||
    (typeof Blob !== "undefined" && value instanceof Blob) ||
    value instanceof ArrayBuffer ||
    ArrayBuffer.isView(value)
  ) {
    return true;
  }

  if (seen.has(value)) {
    return false;
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.some((item) => containsDisallowedBinaryPayload(item, seen));
  }

  return Object.values(value as Record<string, unknown>).some((item) =>
    containsDisallowedBinaryPayload(item, seen),
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertValidContextChunk(chunk: unknown, index: number): asserts chunk is AiContextChunk {
  if (!isPlainObject(chunk)) {
    throw new AiRequestValidationError(`contextChunks[${index}] must be an object.`);
  }

  if (!Number.isSafeInteger(chunk.chunkIndex) || (chunk.chunkIndex as number) < 0) {
    throw new AiRequestValidationError(
      `contextChunks[${index}].chunkIndex must be a non-negative integer.`,
    );
  }

  if (!Number.isSafeInteger(chunk.pageNumber) || (chunk.pageNumber as number) < 1) {
    throw new AiRequestValidationError(
      `contextChunks[${index}].pageNumber must be a positive integer.`,
    );
  }

  if (typeof chunk.text !== "string") {
    throw new AiRequestValidationError(`contextChunks[${index}].text must be a string.`);
  }

  if (
    !Number.isSafeInteger(chunk.startOffset) ||
    !Number.isSafeInteger(chunk.endOffset) ||
    (chunk.startOffset as number) < 0 ||
    (chunk.endOffset as number) < (chunk.startOffset as number)
  ) {
    throw new AiRequestValidationError(
      `contextChunks[${index}] has an invalid startOffset/endOffset pair.`,
    );
  }

  if (containsDisallowedBinaryPayload(chunk)) {
    throw new AiRequestValidationError(
      `contextChunks[${index}] contains a disallowed binary payload.`,
    );
  }
}

function assertValidSettings(settings: unknown): asserts settings is AiRequestSettings {
  if (!isPlainObject(settings)) {
    throw new AiRequestValidationError("settings must be an object.");
  }

  if (
    settings.temperature !== undefined &&
    (typeof settings.temperature !== "number" || !Number.isFinite(settings.temperature))
  ) {
    throw new AiRequestValidationError("settings.temperature must be a finite number.");
  }

  if (
    settings.maxOutputTokens !== undefined &&
    (!Number.isSafeInteger(settings.maxOutputTokens) || (settings.maxOutputTokens as number) < 1)
  ) {
    throw new AiRequestValidationError(
      "settings.maxOutputTokens must be a positive integer.",
    );
  }
}

/**
 * Validates an AI text-generation request at runtime. Throws
 * `ProhibitedAiRequestFieldError` for a field SEC-06 prohibits, and
 * `AiRequestValidationError` for any other malformed shape. Accepts
 * `unknown` deliberately — this is the boundary a request must pass
 * through regardless of how it was constructed (including data crossing
 * a JSON boundary, where TypeScript's compile-time `never` fields give
 * no protection).
 */
export function assertValidAiTextGenerationRequest(
  request: unknown,
): asserts request is {
  prompt: string;
  contextChunks?: AiContextChunk[];
  settings?: AiRequestSettings;
} {
  if (!isPlainObject(request)) {
    throw new AiRequestValidationError("AI request must be an object.");
  }

  for (const key of PROHIBITED_REQUEST_KEYS) {
    if (key in request && request[key] !== undefined) {
      throw new ProhibitedAiRequestFieldError(key);
    }
  }

  if (typeof request.prompt !== "string" || request.prompt.trim() === "") {
    throw new AiRequestValidationError("AI request must include a non-empty prompt.");
  }

  if (request.contextChunks !== undefined) {
    if (!Array.isArray(request.contextChunks)) {
      throw new AiRequestValidationError("contextChunks must be an array.");
    }

    request.contextChunks.forEach((chunk, index) => assertValidContextChunk(chunk, index));
  }

  if (request.settings !== undefined) {
    assertValidSettings(request.settings);
  }

  // Defense in depth: even if every individual field above validated,
  // reject the request if a binary payload is present anywhere in it
  // (e.g. under a key not in PROHIBITED_REQUEST_KEYS).
  if (containsDisallowedBinaryPayload(request)) {
    throw new AiRequestValidationError(
      "AI request contains a disallowed binary payload (File/Blob/ArrayBuffer/typed array).",
    );
  }
}

/**
 * Validates provider/runtime capability metadata. Used both to guard
 * against a malformed provider configuration and as a single place
 * future provider implementations can lean on before registering
 * themselves.
 */
export function assertValidAiCapabilities(
  capabilities: unknown,
): asserts capabilities is AiCapabilities {
  if (!isPlainObject(capabilities)) {
    throw new AiRequestValidationError("AI capabilities must be an object.");
  }

  if (typeof capabilities.providerId !== "string" || capabilities.providerId.trim() === "") {
    throw new AiRequestValidationError("capabilities.providerId must be a non-empty string.");
  }

  if (typeof capabilities.displayName !== "string" || capabilities.displayName.trim() === "") {
    throw new AiRequestValidationError("capabilities.displayName must be a non-empty string.");
  }

  if (!VALID_RUNTIME_KINDS.includes(capabilities.runtime as AiRuntimeKind)) {
    throw new AiRequestValidationError(
      `capabilities.runtime must be one of ${VALID_RUNTIME_KINDS.join(", ")}.`,
    );
  }

  const booleanFields = [
    "isLocal",
    "requiresConsent",
    "supportsStreaming",
    "supportsToolCalling",
    "supportsTextGeneration",
  ] as const;

  for (const field of booleanFields) {
    if (typeof capabilities[field] !== "boolean") {
      throw new AiRequestValidationError(`capabilities.${field} must be a boolean.`);
    }
  }

  if (
    !Number.isFinite(capabilities.maxContextCharacters) ||
    (capabilities.maxContextCharacters as number) <= 0
  ) {
    throw new AiRequestValidationError(
      "capabilities.maxContextCharacters must be a positive number.",
    );
  }

  if (
    !Number.isFinite(capabilities.maxOutputCharacters) ||
    (capabilities.maxOutputCharacters as number) <= 0
  ) {
    throw new AiRequestValidationError(
      "capabilities.maxOutputCharacters must be a positive number.",
    );
  }
}
