/**
 * Production Ollama AiRuntime (Tier 2).
 *
 * Implements `services/ai/types.ts` `AiRuntime`. Inference runs via HTTP
 * against a local Ollama instance at http://127.0.0.1:11434 using model
 * qwen3:4b. Document content stays local: only already-extracted
 * prompt/context text is sent to Ollama.
 *
 * Does not import `services/ai-prototype/`.
 */

import type {
  AiAvailability,
  AiCapabilities,
  AiContextChunk,
  AiRuntime,
  AiTextGenerationRequest,
  AiTextGenerationResult,
} from "../types";
import { assertValidAiTextGenerationRequest } from "../validation";
import {
  OLLAMA_DEFAULT_MAX_TOKENS,
  OLLAMA_DISPLAY_NAME,
  OLLAMA_MAX_CONTEXT_CHARACTERS,
  OLLAMA_MAX_OUTPUT_CHARACTERS,
  OLLAMA_MAX_OUTPUT_TOKENS,
  OLLAMA_PROVIDER_ID,
} from "./types";
import {
  OllamaClientError,
  type OllamaClient,
  createOllamaClient,
} from "./client";

export {
  OllamaClientError,
  OllamaGenerationError,
  OllamaModelNotFoundError,
} from "./client";

export interface OllamaRuntimeOptions {
  /** Injected in unit tests so Node/Vitest does not need a real Ollama server. */
  clientFactory?: () => OllamaClient;
  /** Optional custom availability check. */
  availabilityCheck?: () => Promise<AiAvailability>;
}

/** Error thrown when generateText() is called after dispose(). */
export class OllamaRuntimeDisposedError extends Error {
  constructor() {
    super("OllamaRuntime has been disposed. Create a new instance to generate again.");
    this.name = "OllamaRuntimeDisposedError";
  }
}

/**
 * Ollama-provider-specific result shape. `contextTruncated` is a
 * provider-local fact (Browser AI/BYOK/Cloud have entirely different context
 * mechanics) so it is declared here rather than widening the shared
 * `AiTextGenerationResult` contract in `services/ai/types.ts`. The
 * covariant return type is legal against the `AiRuntime` interface.
 */
export interface OllamaTextGenerationResult extends AiTextGenerationResult {
  /** True when one or more supplied context chunks were dropped to stay within `OLLAMA_MAX_CONTEXT_CHARACTERS`. */
  contextTruncated: boolean;
}

export const OLLAMA_CAPABILITIES: AiCapabilities = {
  providerId: OLLAMA_PROVIDER_ID,
  displayName: OLLAMA_DISPLAY_NAME,
  runtime: "ollama",
  isLocal: true,
  requiresConsent: true,
  supportsStreaming: false,
  supportsToolCalling: false,
  supportsTextGeneration: true,
  maxContextCharacters: OLLAMA_MAX_CONTEXT_CHARACTERS,
  maxOutputCharacters: OLLAMA_MAX_OUTPUT_CHARACTERS,
};

/**
 * Deterministically bounds document context to `maxCharacters`, measured
 * as the sum of each chunk's `text.length`. Iterates in the order given
 * (the caller's existing chunk order — never re-sorted or reordered) and
 * keeps a chunk only if adding it whole still fits. Stops at the first
 * chunk that would overflow rather than skipping it and continuing, and
 * never slices an individual chunk's `text`. Does not mutate `chunks`.
 */
export function boundContextChunks(
  chunks: AiContextChunk[],
  maxCharacters: number,
): { chunks: AiContextChunk[]; truncated: boolean } {
  const kept: AiContextChunk[] = [];
  let total = 0;

  for (const chunk of chunks) {
    const nextTotal = total + chunk.text.length;
    if (nextTotal > maxCharacters) {
      return { chunks: kept, truncated: true };
    }
    kept.push(chunk);
    total = nextTotal;
  }

  return { chunks: kept, truncated: false };
}

/**
 * Resolves the token limit passed to Ollama as `num_predict`. num_predict
 * counts *tokens*, not characters, so it is clamped against
 * OLLAMA_MAX_OUTPUT_TOKENS — never against the advertised character ceiling
 * (OLLAMA_MAX_OUTPUT_CHARACTERS), which is informational only.
 */
function resolveMaxOutputTokens(maxOutputTokens: number | undefined): number {
  const requested = maxOutputTokens ?? OLLAMA_DEFAULT_MAX_TOKENS;
  return Math.min(requested, OLLAMA_MAX_OUTPUT_TOKENS);
}

function createProductionClient(): OllamaClient {
  return createOllamaClient();
}

export class OllamaRuntime implements AiRuntime {
  readonly capabilities: AiCapabilities = OLLAMA_CAPABILITIES;

  private readonly clientFactory: () => OllamaClient;
  private readonly availabilityCheck: () => Promise<AiAvailability>;

  private client: OllamaClient | null = null;
  private inFlight = false;
  private disposed = false;

  constructor(options: OllamaRuntimeOptions = {}) {
    this.clientFactory = options.clientFactory ?? createProductionClient;
    this.availabilityCheck = options.availabilityCheck ?? this.defaultAvailabilityCheck;
  }

  private async defaultAvailabilityCheck(): Promise<AiAvailability> {
    if (!this.client) {
      this.client = this.clientFactory();
    }
    return this.client.checkAvailability();
  }

  checkAvailability(): Promise<AiAvailability> {
    return this.availabilityCheck();
  }

  /**
   * No cancellation support for HTTP-based Ollama generation.
   * Kept for interface compatibility — does nothing.
   */
  cancel(): void {
    // Ollama HTTP generate is non-streaming and non-cancellable at the client level.
    // A future enhancement could use AbortController, but the Ollama API
    // does not currently support cancelling a /api/generate call in flight.
  }

  /**
   * Permanently disposes the runtime: clears the cached client and marks
   * this instance unusable — every later generateText() rejects with
   * OllamaRuntimeDisposedError. Disposal does not cancel anything: an
   * already-running HTTP request may settle naturally and deliver its
   * result (or error) to its own caller. No complex cancellation is
   * implemented.
   */
  dispose(): void {
    this.disposed = true;
    this.client = null;
  }

  async generateText(
    request: AiTextGenerationRequest,
  ): Promise<OllamaTextGenerationResult> {
    if (this.disposed) {
      throw new OllamaRuntimeDisposedError();
    }

    assertValidAiTextGenerationRequest(request);

    if (this.inFlight) {
      throw new Error("Ollama runtime supports one in-flight generation at a time.");
    }

    this.inFlight = true;

    try {
      const availability = await this.checkAvailability();
      if (!availability.available) {
        throw new OllamaClientError(
          availability.reason ?? "Ollama is not available.",
          null,
          "/api/tags",
        );
      }

      const { chunks: boundedChunks, truncated: contextTruncated } = boundContextChunks(
        request.contextChunks ?? [],
        OLLAMA_MAX_CONTEXT_CHARACTERS,
      );

      if (!this.client) {
        this.client = this.clientFactory();
      }

      const text = await this.client.generate(
        request.prompt,
        boundedChunks.map((c) => ({
          text: c.text,
          pageNumber: c.pageNumber,
          chunkIndex: c.chunkIndex,
        })),
        {
          temperature: request.settings?.temperature,
          maxOutputTokens: resolveMaxOutputTokens(request.settings?.maxOutputTokens),
        },
      );

      return {
        text,
        providerId: this.capabilities.providerId,
        runtime: this.capabilities.runtime,
        contextTruncated,
      };
    } finally {
      this.inFlight = false;
    }
  }
}