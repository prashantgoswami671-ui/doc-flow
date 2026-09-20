/**
 * V6-D01 — Provider/runtime selection seam (provider-agnostic call sites).
 *
 * Centralizes production runtime construction so business/UI code can
 * request a runtime by preference without constructing a specific
 * provider directly. Selection reasons from capability policy, not
 * from tier-name branching at the call site: the returned
 * `AiRuntime` still exposes `capabilities` for later D02 (live
 * availability) and D03 (consent) evaluation.
 *
 * D01 boundaries (extended minimally by V6-D04):
 * - Browser AI is the production default (`"automatic"`, `"browser"`).
 *   `"ollama"` is selectable ONLY through the internal D04 production
 *   path: it is not user-facing, never the automatic default, and use
 *   remains gated by D02 availability + D03 consent. `"byok"` and
 *   `"cloud"` still throw `AiRuntimeSelectionError`.
 * - No availability probing: this module never calls
 *   `checkAvailability()`, never touches `127.0.0.1`, performs no
 *   `fetch`, and creates no network traffic. Constructing a runtime
 *   performs no network activity; only D02/D04 invocation does.
 * - No consent logic: `requiresConsent` is surfaced untouched via
 *   `runtime.capabilities` for D03; nothing here blocks, grants, or
 *   invents consent state.
 * - No lifecycle ownership: every selection constructs a fresh
 *   runtime. No global singleton, no shared cache, no module-level
 *   mutable state. The caller owns reuse and `dispose()` exactly as
 *   `SummarizePdfCard` does today (approach A: current UI behavior
 *   is unchanged and unwired; future wiring reuses this seam).
 * - Input is a preference string only. Document data (`File`, `Blob`,
 *   bytes, passwords, images, metadata, model output) is never
 *   accepted or propagated — such input is rejected as an invalid
 *   preference.
 */

import type { AiCapabilities, AiRuntime } from "./types";
import { BrowserAiRuntime } from "./browser/browserAiRuntime";
import { OllamaRuntime } from "./ollama/runtime";

/**
 * Production-usable runtime preferences for v1.
 *
 * `"ollama"` is service-layer-internal (V6-D04): no UI exposes it,
 * and every use must still pass D02 availability + D03 consent.
 */
export type AiRuntimePreference = "automatic" | "browser" | "ollama";

/** Machine-readable selection failure codes (content-free). */
export type AiRuntimeSelectionErrorCode = "invalid-preference" | "unsupported-runtime";

/** Thrown when a runtime cannot be selected (never a fallback). */
export class AiRuntimeSelectionError extends Error {
  readonly code: AiRuntimeSelectionErrorCode;

  constructor(code: AiRuntimeSelectionErrorCode, message: string) {
    super(message);
    this.name = "AiRuntimeSelectionError";
    this.code = code;
  }
}

/** One selection outcome: a fresh caller-owned runtime plus its policy basis. */
export interface AiRuntimeSelection {
  /** Fresh runtime instance owned by the caller (caller disposes). */
  readonly runtime: AiRuntime;
  /** Authoritative capability metadata — same reference as `runtime.capabilities`. */
  readonly capabilities: AiCapabilities;
  /** The preference as given. */
  readonly preference: AiRuntimePreference;
  /**
   * How the preference resolved. `"automatic"` documents the v1
   * production default (Browser AI); `"browser"`/`"ollama"` are the
   * explicit choices. No silent provider substitution ever occurs.
   */
  readonly resolved: "browser" | "ollama";
}

/**
 * Selects a production runtime for the given preference. Constructs a
 * fresh runtime per call: `BrowserAiRuntime` for `"automatic"` (v1
 * default) and `"browser"`, `OllamaRuntime` for the internal
 * `"ollama"` production path. `"byok"`, `"cloud"`, malformed input,
 * and document-carrying objects throw `AiRuntimeSelectionError` with
 * a deterministic code.
 */
export function selectAiRuntime(preference: unknown): AiRuntimeSelection {
  if (preference !== "automatic" && preference !== "browser" && preference !== "ollama") {
    if (preference === "byok" || preference === "cloud") {
      throw new AiRuntimeSelectionError(
        "unsupported-runtime",
        `Runtime "${String(preference)}" is not yet selectable for production requests.`,
      );
    }
    throw new AiRuntimeSelectionError(
      "invalid-preference",
      "Runtime preference must be \"automatic\", \"browser\", or \"ollama\".",
    );
  }
  const runtime = preference === "ollama" ? new OllamaRuntime() : new BrowserAiRuntime();
  return {
    runtime,
    capabilities: runtime.capabilities,
    preference,
    resolved: preference === "ollama" ? "ollama" : "browser",
  };
}
