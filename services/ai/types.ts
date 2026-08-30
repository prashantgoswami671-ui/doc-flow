/**
 * AI-01 — Capability-based AI provider/runtime abstraction.
 *
 * This is the contract/foundation only (Checkpoint 1). It defines the
 * shape of an AI runtime and the shape of a text-generation request, so
 * that Browser AI, Ollama, BYOK, and a future Cloud AI provider can all
 * be implemented later without redesigning the core application.
 *
 * NO PROVIDER IS IMPLEMENTED HERE. There is no fetch, no Ollama URL, no
 * API key, no model download logic — see `docs/SEC-06-AI-DATA-POLICY.md`
 * and `docs/DOCFLOW_STATUS.md` (AI-01) for why that is deliberate.
 *
 * The contract is capability-based rather than tier-based: callers branch
 * on what a runtime can do (`AiCapabilities`), not on which tier it
 * belongs to, so a future runtime that doesn't fit today's three tiers
 * cleanly still works without changing calling code.
 */

/** Coarse identification of which kind of runtime a provider is. Informational only — behavior must be driven by `AiCapabilities`, not by switching on this. */
export type AiRuntimeKind = "browser" | "ollama" | "byok" | "cloud";

/**
 * Describes what a given AI provider/runtime can do. This is the
 * capability surface the rest of the app is expected to branch on.
 */
export interface AiCapabilities {
  /** Stable identifier for this provider/runtime, e.g. "browser-ai", "ollama", "byok:openai". */
  providerId: string;
  /** Human-readable name for disclosure/consent UI. */
  displayName: string;
  /** Coarse runtime classification — informational, see type doc comment. */
  runtime: AiRuntimeKind;
  /**
   * True only once the deployment has been verified as local/loopback
   * (see SEC-06 §3). Must never be assumed true purely because a runtime
   * is nominally "Ollama" or "browser" — a misconfigured/self-hosted
   * remote Ollama is not local.
   */
  isLocal: boolean;
  /**
   * True when a content-bearing request from this runtime requires
   * explicit user consent before it can be sent (SEC-06 §6). Browser AI
   * is expected to be `false` (nothing leaves the browser); Ollama,
   * BYOK, and Cloud AI are expected to be `true`.
   */
  requiresConsent: boolean;
  /** Whether this runtime can stream partial output. */
  supportsStreaming: boolean;
  /** Whether this runtime supports tool/function calling. Not used by anything at Checkpoint 1 — declared for future runtimes. */
  supportsToolCalling: boolean;
  /** Maximum input context size this runtime accepts, in characters. */
  maxContextCharacters: number;
  /** Maximum output size this runtime will return, in characters. */
  maxOutputCharacters: number;
  /** Whether this runtime currently reports itself as reachable/healthy. Static capability metadata only — call `AiRuntime.checkAvailability()` for a live check. */
  supportsTextGeneration: boolean;
}

/**
 * A single bounded, page-aware chunk of extracted document text, as
 * produced by AI-02 (`services/ai/chunking.ts`). This is the only
 * document-derived shape allowed into an AI request — see
 * `AiTextGenerationRequest` below and SEC-06 §1/§2.
 */
export interface AiContextChunk {
  /** Zero-based order of this chunk among all chunks produced for the request. */
  chunkIndex: number;
  /** One-based source page number this chunk's text came from. */
  pageNumber: number;
  /** Extracted, plain-text content only — never binary/image data. */
  text: string;
  /** Character offset (inclusive) of `text` within that page's extracted text. */
  startOffset: number;
  /** Character offset (exclusive) of `text` within that page's extracted text. */
  endOffset: number;
}

/** Non-sensitive, provider-agnostic generation settings. */
export interface AiRequestSettings {
  temperature?: number;
  maxOutputTokens?: number;
}

/**
 * The AI request/input type. This structurally excludes every field
 * SEC-06 §1 and §9 prohibit from reaching an AI provider: `File`, `Blob`,
 * raw PDF bytes, `ArrayBuffer`/`Uint8Array` containing the original PDF,
 * passwords, raw page images, thumbnails, and arbitrary document
 * metadata. Each is declared as `never` below so that constructing a
 * request carrying one is a compile-time error, not just a runtime one.
 *
 * TypeScript's structural typing can still be bypassed (e.g. `as any`,
 * data crossing a JSON boundary, or a caller not written in TypeScript),
 * so this is paired with runtime validation in `services/ai/validation.ts`
 * — do not rely on this type alone to enforce the boundary.
 */
export interface AiTextGenerationRequest {
  /** The user's instruction/question. */
  prompt: string;
  /** Minimized, already-extracted text context. Optional — a request may be prompt-only. */
  contextChunks?: AiContextChunk[];
  /** Non-sensitive generation settings. */
  settings?: AiRequestSettings;

  // Structurally prohibited fields (SEC-06 §1, §9). Never assign these.
  file?: never;
  blob?: never;
  fileBytes?: never;
  arrayBuffer?: never;
  password?: never;
  pageImage?: never;
  thumbnail?: never;
  metadata?: never;
}

export interface AiTextGenerationResult {
  text: string;
  providerId: string;
  runtime: AiRuntimeKind;
}

export interface AiAvailability {
  available: boolean;
  /** Human-readable reason when `available` is false (e.g. "Ollama not reachable at configured endpoint"). */
  reason?: string;
}

/**
 * The common surface every AI provider/runtime implementation will
 * expose. No implementation of this interface is provided at Checkpoint
 * 1 — Browser AI, Ollama, BYOK, and Cloud AI implementations are future
 * work (see `docs/DOCFLOW_STATUS.md`, AI-16 onward).
 */
export interface AiRuntime {
  readonly capabilities: AiCapabilities;
  /** Live reachability/health check — must not be inferred from `capabilities` alone. */
  checkAvailability(): Promise<AiAvailability>;
  generateText(request: AiTextGenerationRequest): Promise<AiTextGenerationResult>;
}
