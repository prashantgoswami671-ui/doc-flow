/**
 * V6-D02 — Tier-2 availability handling (provider-local, UI-agnostic).
 *
 * Deterministic machine-readable availability state for the configured
 * Ollama service + model, built around the existing runtime behavior.
 * Pure apart from the single delegated `checkAvailability()` call: no
 * `fetch`, no `/api/tags` or `/api/show` requests, no second client,
 * no generation, no document data, no consent, no UI strings.
 *
 * State model:
 * - `"available"` — service reachable AND configured model present.
 * - `"unavailable"` — service not reachable (or answered with a
 *   non-model failure). Reason `service-unreachable`.
 * - `"model-unavailable"` — service reachable but the configured
 *   model is absent, via the structured `modelMissing` signal
 *   (never reason-string parsing). Reason `configured-model-missing`.
 * - `"error"` — the check itself threw or returned a malformed
 *   result. Never collapses to `"available"`.
 *
 * Policy: one explicit check per call (no cache, no polling, no
 * timers, no singleton runtime). Importing this module performs zero
 * network activity. Configuration authority stays in `./types.ts`
 * (`OLLAMA_BASE_URL`, `OLLAMA_MODEL`); capability metadata comes
 * from `runtime.capabilities` untouched.
 */

import type { AiCapabilities } from "../types";
import { OllamaRuntime } from "./runtime";

/** Machine-readable Tier-2 availability states. */
export type OllamaAvailabilityStatus =
  | "available"
  | "unavailable"
  | "model-unavailable"
  | "error";

/** Machine-readable reason codes (content-free, no document/model text). */
export type OllamaAvailabilityReasonCode =
  | "service-unreachable"
  | "configured-model-missing"
  | "availability-check-failed"
  | "malformed-availability-response";

/** Thrown for malformed caller envelopes only (never for availability states). */
export class OllamaAvailabilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OllamaAvailabilityError";
  }
}

/** Structured availability outcome for later UI/provider handling. */
export interface OllamaAvailability {
  readonly status: OllamaAvailabilityStatus;
  /** Present for every non-available status; absent when available. */
  readonly reasonCode?: OllamaAvailabilityReasonCode;
  /** Same reference as `runtime.capabilities` — never duplicated. */
  readonly capabilities: AiCapabilities;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Returns the structured Tier-2 availability state. Calls
 * `runtime.checkAvailability()` exactly once. When `runtime` is
 * omitted, a default `OllamaRuntime` is constructed for the check
 * (per-call instance, never shared or cached).
 *
 * Throws only for a malformed caller envelope (missing/invalid
 * runtime). Availability failures themselves are returned as data.
 */
export async function getOllamaAvailability(
  runtime?: unknown,
): Promise<OllamaAvailability> {
  const resolved: OllamaRuntime =
    runtime === undefined ? new OllamaRuntime() : (runtime as OllamaRuntime);
  if (!(resolved instanceof OllamaRuntime)) {
    throw new OllamaAvailabilityError("Ollama availability requires an OllamaRuntime.");
  }
  const capabilities = resolved.capabilities;

  let result: unknown;
  try {
    result = await resolved.checkAvailability();
  } catch {
    return { status: "error", reasonCode: "availability-check-failed", capabilities };
  }
  if (!isPlainObject(result) || typeof result.available !== "boolean") {
    return { status: "error", reasonCode: "malformed-availability-response", capabilities };
  }
  if (result.available === true) {
    return { status: "available", capabilities };
  }
  if (result.modelMissing === true) {
    return { status: "model-unavailable", reasonCode: "configured-model-missing", capabilities };
  }
  return { status: "unavailable", reasonCode: "service-unreachable", capabilities };
}
