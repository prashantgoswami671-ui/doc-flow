/**
 * V6-D04 — Ollama production integration (service layer, no UI).
 *
 * Production wiring seam for Tier-2 Ollama generation. Owns the
 * policy ordering so the UI never duplicates it:
 *
 *   capability policy (C04: summarize only)
 *     → runtime selection (D01: explicit internal "ollama")
 *     → availability (D02: must be "available")
 *     → consent (D03: must be granted for this provider)
 *     → production AI execution (existing orchestration)
 *
 * Safety rules:
 * - Ollama is never the default and never a fallback: availability
 *   or consent failure rejects before generation (never Browser).
 * - No consent is auto-granted, persisted, or inferred from
 *   availability. No global consent or runtime singletons.
 * - Only `prompt` + `contextChunks` reach the runtime (existing
 *   `AiRuntime` contract; SEC-06 protections unchanged).
 * - The returned text is RAW model output, explicitly marked
 *   `validated: false`: it is NOT C02-validated and NOT evidence.
 *   C02 remains the output-validation authority and C03 the
 *   grounding authority; V6-E builds the first validated Tier-2
 *   capability on top of this seam (chunks + sourcePageCount are
 *   carried for that purpose). No second validation schema, no
 *   model-authored excerpts, no promoted evidence.
 * - Fixed local endpoint/model authority stays in
 *   `services/ai/ollama/types.ts`; nothing here configures endpoints,
 *   pulls models, or manages remotes.
 * - Importing this module performs zero network activity.
 */

import type { AiContextChunk, AiRuntime } from "./types";
import { runAiActionOnPdf } from "./orchestration";
import { AiRuntimeSelectionError, selectAiRuntime } from "./providerSelection";
import { getOllamaAvailability } from "./ollama/availability";
import { AiConsentRequiredError, assertAiConsent } from "./consent";
import { Stage2CapabilityError, resolveStage2Capability } from "./stage2/capability";

/** Machine-readable Tier-2 service failure codes (content-free). */
export type Tier2ServiceErrorCode =
  | "invalid-request"
  | "unsupported-capability"
  | "selection-failed"
  | "service-unavailable"
  | "model-unavailable"
  | "availability-error"
  | "consent-required"
  | "empty-context"
  | "generation-failed";

/** Thrown when the Tier-2 production request cannot proceed. */
export class Tier2ServiceError extends Error {
  readonly code: Tier2ServiceErrorCode;

  constructor(code: Tier2ServiceErrorCode, message: string) {
    super(message);
    this.name = "Tier2ServiceError";
    this.code = code;
  }
}

/** Tier-2 production request envelope (still runtime-validated). */
export interface RunTier2OllamaSummarizeOptions {
  /** Source PDF. Must be a real `File`; validated fail-closed. */
  file: unknown;
  /** Explicit caller-owned in-memory consent store (D03). */
  consentStore: unknown;
  /** Requested action; must resolve to supported summarize (default). */
  action?: unknown;
}

/**
 * Tier-2 production result.
 *
 * `text` is the RAW Ollama output string — `validated: false` marks
 * that C02 validation and C03 grounding have NOT been applied. V6-E
 * owns the validated user-facing capability; `chunks` and
 * `sourcePageCount` are carried so that layer can build it.
 */
export interface Tier2OllamaSummarizeResult {
  readonly text: string;
  readonly providerId: string;
  readonly runtime: "ollama";
  readonly chunks: readonly AiContextChunk[];
  readonly sourcePageCount: number;
  readonly validated: false;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A freshly gated Ollama runtime plus its caller-owned disposal. */
export interface GatedOllamaRuntime {
  readonly runtime: AiRuntime;
  dispose(): void;
}

/**
 * Shared internal gate sequence reused by the D04 raw seam and the
 * V6-E01 validated pipeline: capability (summarize only) → selection
 * (explicit internal "ollama") → availability (must be "available") →
 * consent (granted for this provider). Rejects with Tier2ServiceError
 * before any content-bearing generation. The caller owns the
 * returned runtime lifetime via `dispose()`.
 */
export async function acquireGatedOllamaRuntime(
  consentStore: unknown,
  action?: unknown,
): Promise<GatedOllamaRuntime> {
  if (consentStore === undefined || consentStore === null) {
    throw new Tier2ServiceError("invalid-request", "Tier-2 request requires a consent store.");
  }

  // 1. Capability policy (C04): summarize only. Malformed or
  //    unsupported actions fail here — never reinterpreted.
  try {
    const decision = resolveStage2Capability(action ?? "summarize");
    if (decision.status !== "supported") {
      throw new Tier2ServiceError(
        "unsupported-capability",
        "Tier-2 production supports the summarize capability only.",
      );
    }
  } catch (error) {
    if (error instanceof Tier2ServiceError) {
      throw error;
    }
    if (error instanceof Stage2CapabilityError) {
      throw new Tier2ServiceError(
        "unsupported-capability",
        "Tier-2 production supports the summarize capability only.",
      );
    }
    throw error;
  }

  // 2. Runtime selection (D01): explicit internal "ollama" only.
  let runtime: AiRuntime;
  try {
    runtime = selectAiRuntime("ollama").runtime;
  } catch (error) {
    if (error instanceof AiRuntimeSelectionError) {
      throw new Tier2ServiceError("selection-failed", "Tier-2 runtime selection failed.");
    }
    throw error;
  }

  const dispose = () => {
    const disposable = runtime as unknown as { dispose?: () => void };
    if (typeof disposable.dispose === "function") {
      disposable.dispose();
    }
  };

  // 3. Availability (D02): anything but "available" stops here.
  const availability = await getOllamaAvailability(runtime);
  if (availability.status === "model-unavailable") {
    dispose();
    throw new Tier2ServiceError(
      "model-unavailable",
      "The configured Ollama model is not installed.",
    );
  }
  if (availability.status === "unavailable") {
    dispose();
    throw new Tier2ServiceError(
      "service-unavailable",
      "The local Ollama service is not reachable.",
    );
  }
  if (availability.status !== "available") {
    dispose();
    throw new Tier2ServiceError(
      "availability-error",
      "Ollama availability could not be established.",
    );
  }

  // 4. Consent (D03): granted-for-this-provider or blocked.
  try {
    assertAiConsent(runtime, consentStore);
  } catch (error) {
    dispose();
    if (error instanceof AiConsentRequiredError) {
      throw new Tier2ServiceError(
        "consent-required",
        "Consent is required before sending content to Ollama.",
      );
    }
    throw new Tier2ServiceError("invalid-request", "Tier-2 consent state is invalid.");
  }

  return { runtime, dispose };
}

/**
 * Runs one Tier-2 Ollama summarize through the full production gate
 * sequence. Rejects with `Tier2ServiceError` (deterministic code)
 * before generation whenever capability, selection, availability, or
 * consent fails. The runtime instance is fresh per call and disposed
 * before return; no singleton, cache, or shared state exists.
 */
export async function runTier2OllamaSummarize(
  options: unknown,
): Promise<Tier2OllamaSummarizeResult> {
  if (!isPlainObject(options)) {
    throw new Tier2ServiceError("invalid-request", "Tier-2 request must be an object.");
  }
  const { file, consentStore, action } = options;
  if (!(file instanceof File)) {
    throw new Tier2ServiceError("invalid-request", "Tier-2 request requires a PDF File.");
  }
  if (consentStore === undefined || consentStore === null) {
    throw new Tier2ServiceError("invalid-request", "Tier-2 request requires a consent store.");
  }

  const { runtime, dispose } = await acquireGatedOllamaRuntime(consentStore, action);

  try {
    // 5. Production AI execution (existing orchestration; the AiRuntime
    //    contract admits only prompt + contextChunks downstream).
    let generated;
    try {
      generated = await runAiActionOnPdf({ file, action: "summarize", runtime });
    } catch (error) {
      if (error instanceof Tier2ServiceError) {
        throw error;
      }
      throw new Tier2ServiceError("generation-failed", "Tier-2 Ollama generation failed.");
    }

    return Object.freeze({
      text: generated.text,
      providerId: generated.providerId,
      runtime: "ollama" as const,
      chunks: Object.freeze([...generated.chunks]),
      sourcePageCount: generated.sourcePageCount,
      validated: false as const,
    });
  } finally {
    dispose();
  }
}
