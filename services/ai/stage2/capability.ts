/**
 * V6-C04 — Explicit unresolved-capability policy.
 *
 * Deterministic capability boundary for Stage-2 v1. Maps a
 * higher-level requested action onto either the single supported
 * Stage-2 entry point (`summarize`) or an explicit unsupported state
 * with a machine-readable reason. Pure and provider-agnostic: no
 * provider, no network, no DOM, no PDF parsing, no model output, no UI.
 *
 * Design rules (frozen):
 * - The C01 types (`Stage2TaskId`, `Stage2ClaimKind`, `Stage2Input`,
 *   `Stage2Claim`) are NOT extended here and are not imported for
 *   extension — only `Stage2TaskId` is referenced as the supported
 *   task value.
 * - Unsupported capabilities are NEVER downgraded to summarize, fact,
 *   or conclusion. No silent task substitution.
 * - No normalization: no trimming, no case folding, no fuzzy matching,
 *   no alias guessing (beyond the two documented `ask`/`qa` spellings).
 * - Content-free: decisions and errors carry status + reason codes
 *   only — never document text, model output, PDF metadata, or
 *   source excerpts.
 */

import type { Stage2TaskId } from "./types";

/** Thrown for malformed capability requests (never for known-unsupported ones). */
export class Stage2CapabilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Stage2CapabilityError";
  }
}

/** Capability resolution outcome. Only one supported value exists in v1. */
export type Stage2CapabilityStatus = "supported" | "unsupported";

/** Machine-readable policy reason codes (content-free). */
export type Stage2CapabilityReason =
  | "supported-summarize"
  | "unsupported-task"
  | "unsupported-comparison"
  | "unsupported-attribution"
  | "unsupported-causal"
  | "unsupported-qa"
  | "unsupported-translation"
  | "unsupported-key-points"
  | "unsupported-multi-document";

/** The single supported v1 entry point. */
export interface SupportedStage2Capability {
  readonly status: "supported";
  readonly task: Stage2TaskId;
  readonly reason: Extract<Stage2CapabilityReason, "supported-summarize">;
}

/** Explicit unsupported state: the request must not enter Stage-2. */
export interface UnsupportedStage2Capability {
  readonly status: "unsupported";
  readonly reason: Exclude<Stage2CapabilityReason, "supported-summarize">;
}

export type Stage2CapabilityDecision = SupportedStage2Capability | UnsupportedStage2Capability;

/**
 * Keys that must never appear on a capability request. Their presence
 * is a caller error (fail-loud) — the policy neither accepts nor
 * propagates binary, document, provider, or model-output state.
 */
const PROHIBITED_REQUEST_KEYS: readonly string[] = [
  "file",
  "blob",
  "fileBytes",
  "arrayBuffer",
  "password",
  "pageImage",
  "thumbnail",
  "metadata",
  "provider",
  "runtime",
  "modelOutput",
];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unsupported(
  reason: UnsupportedStage2Capability["reason"],
): UnsupportedStage2Capability {
  return Object.freeze({ status: "unsupported", reason });
}

/** Exact action-name mapping. No normalization is applied before this switch. */
function decideActionName(name: string): Stage2CapabilityDecision {
  switch (name) {
    case "summarize":
      return Object.freeze({
        status: "supported",
        task: "summarize",
        reason: "supported-summarize",
      });
    case "translate":
      return unsupported("unsupported-translation");
    case "keyPoints":
      return unsupported("unsupported-key-points");
    case "ask":
    case "qa":
      return unsupported("unsupported-qa");
    case "comparison":
      return unsupported("unsupported-comparison");
    case "attribution":
      return unsupported("unsupported-attribution");
    case "causal":
      return unsupported("unsupported-causal");
    default:
      return unsupported("unsupported-task");
  }
}

function hasMultiDocumentSignal(request: Record<string, unknown>): boolean {
  if (request["multiDocument"] === true) {
    return true;
  }
  if (typeof request["documentCount"] === "number" && request["documentCount"] > 1) {
    return true;
  }
  for (const key of ["documentIds", "documents"] as const) {
    const value = request[key];
    if (Array.isArray(value) && value.length > 1) {
      return true;
    }
  }
  return false;
}

/**
 * Resolves whether a requested capability may enter Stage-2 v1.
 *
 * Accepts a bare action-name string or an object envelope with an
 * `action` and/or `task` field plus optional capability flags
 * (`comparison`, `attribution`, `causal`) and multi-document signals
 * (`multiDocument`, `documentCount`, `documentIds`, `documents`).
 *
 * Returns a frozen supported/unsupported decision for every
 * well-formed request. Throws `Stage2CapabilityError` fail-loud for
 * malformed envelopes: null/undefined/non-string primitives,
 * missing action/task, conflicting action/task fields, unknown
 * non-string action types, and prohibited security-boundary keys.
 */
export function resolveStage2Capability(request: unknown): Stage2CapabilityDecision {
  if (typeof request === "string") {
    return decideActionName(request);
  }
  if (!isPlainObject(request)) {
    throw new Stage2CapabilityError("Capability request must be an action name or an object.");
  }
  for (const key of Object.keys(request)) {
    if (PROHIBITED_REQUEST_KEYS.includes(key)) {
      throw new Stage2CapabilityError("Capability request carries a prohibited field.");
    }
  }

  // Flag-based unresolved capabilities take precedence over the action
  // name in fixed priority order (deterministic when several apply).
  if (hasMultiDocumentSignal(request)) {
    return unsupported("unsupported-multi-document");
  }
  if (request["comparison"] === true) {
    return unsupported("unsupported-comparison");
  }
  if (request["attribution"] === true) {
    return unsupported("unsupported-attribution");
  }
  if (request["causal"] === true) {
    return unsupported("unsupported-causal");
  }

  const { action, task } = request;
  if (action === undefined && task === undefined) {
    throw new Stage2CapabilityError("Capability request is missing an action.");
  }
  if (action !== undefined && task !== undefined && action !== task) {
    throw new Stage2CapabilityError("Capability request has conflicting action fields.");
  }
  const name = (action ?? task) as unknown;
  if (typeof name !== "string") {
    throw new Stage2CapabilityError("Capability action must be a string.");
  }
  return decideActionName(name);
}
