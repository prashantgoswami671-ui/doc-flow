/**
 * V6-C02 — Deterministic Stage-2 output validator.
 *
 * Validates untrusted model output against the frozen V6-C01 claim
 * contract (`./types.ts`). Pure and provider-agnostic: no provider,
 * no network, no DOM, no PDF parsing. Reuses the committed B02 ID
 * semantics (`isValidEvidenceId`) — no second ID implementation.
 *
 * Fail-closed, two levels (same philosophy as B03/B04/B05):
 * - Malformed caller envelope (bad options/scope) is a programmer
 *   error and throws `Stage2ValidationError` fail-loud.
 * - Bad model data never throws: the offending claim (or the whole
 *   top-level envelope) is rejected with a content-free reason code.
 *   Nothing is repaired, normalized, fuzzy-matched, or inferred.
 *
 * Immutability: accepted claims (and their nested `evidenceIds`
 * arrays) are fresh frozen copies. The input object and the Evidence
 * Store snapshot are never mutated.
 */

import { isValidEvidenceId } from "../evidence/ids";
import { EvidenceStore } from "../evidence/store";
import type { Stage2Claim } from "./types";

/** Thrown for malformed caller envelopes only (never for bad model data). */
export class Stage2ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Stage2ValidationError";
  }
}

/**
 * Conservative bound for one claim restatement (~2-3 sentences,
 * roughly 100-125 tokens). Keeps multi-claim Stage-2 output inside
 * both the 256-new-token Browser budget and the 2048-token Ollama
 * budget without reintroducing T2-07 truncation pressure, and
 * prevents prompt-injection dumps from passing as restatements.
 * Oversized text rejects the claim — never truncated.
 */
export const MAX_STAGE2_CLAIM_TEXT_CHARACTERS = 500;

/**
 * Conservative bound for citations per claim. Allows synthesis across
 * several spans (chunk-2 held 18 spans, expected to split across
 * claims) while preventing whole-store dumps into a single claim.
 * Oversized arrays reject the claim.
 */
export const MAX_STAGE2_EVIDENCE_IDS_PER_CLAIM = 8;

/** Exact allowed claim key set: nothing else may appear. */
const ALLOWED_CLAIM_KEYS: readonly string[] = ["evidenceIds", "kind", "text"];

/** Content-free rejection reason codes (no document/claim text echoed). */
export type Stage2RejectionReason =
  | "malformed-output"
  | "malformed-claim"
  | "unknown-field"
  | "invalid-kind"
  | "empty-claim-text"
  | "invalid-claim-text"
  | "claim-text-too-long"
  | "invalid-evidenceIds"
  | "empty-evidenceIds"
  | "evidenceIds-too-many"
  | "malformed-evidence-id"
  | "unknown-evidence-id";

/** Top-level envelope failure (non-array / malformed JSON). */
export type Stage2OutputError = Extract<Stage2RejectionReason, "malformed-output">;

/** One rejected claim: position plus content-free reason. */
export interface Stage2Rejection {
  readonly index: number;
  readonly reason: Stage2RejectionReason;
}

/** Validator options (still runtime-validated — see below). */
export interface ValidateStage2OutputOptions {
  /**
   * Permitted evidence scope: either an `EvidenceStore` (resolved via
   * its frozen items) or a readonly snapshot array of items carrying
   * `evidenceId` strings. Exact-ID membership only.
   */
  scope: unknown;
}

/** Validation outcome: frozen accepted claims plus per-claim rejections. */
export interface ValidateStage2OutputResult {
  readonly accepted: readonly Stage2Claim[];
  /** Per-claim rejections, in input order. Empty when output is clean. */
  readonly rejected: readonly Stage2Rejection[];
  /**
   * Present only when the top-level envelope itself is invalid
   * (malformed JSON, non-array). Absent otherwise — including when
   * individual claims are rejected.
   */
  readonly outputError?: Stage2OutputError;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Builds the permitted-ID set fail-loud; model IDs are checked against it. */
function resolveScopeIds(scope: unknown): ReadonlySet<string> {
  if (scope instanceof EvidenceStore) {
    const ids = new Set<string>();
    for (const item of scope.items) {
      if (
        !isPlainObject(item) ||
        typeof item.evidenceId !== "string" ||
        !isValidEvidenceId(item.evidenceId)
      ) {
        throw new Stage2ValidationError("Evidence scope contains an invalid item.");
      }
      ids.add(item.evidenceId);
    }
    return ids;
  }
  if (Array.isArray(scope)) {
    const ids = new Set<string>();
    for (const [position, item] of scope.entries()) {
      if (
        !isPlainObject(item) ||
        typeof item.evidenceId !== "string" ||
        !isValidEvidenceId(item.evidenceId)
      ) {
        throw new Stage2ValidationError(
          `Evidence scope[${position}] must carry a valid evidenceId.`,
        );
      }
      ids.add(item.evidenceId);
    }
    return ids;
  }
  throw new Stage2ValidationError("Validation scope must be an EvidenceStore or item array.");
}

function failedResult(
  accepted: Stage2Claim[],
  rejected: Stage2Rejection[],
  outputError?: Stage2OutputError,
): ValidateStage2OutputResult {
  return {
    accepted: Object.freeze(accepted),
    rejected: Object.freeze(rejected),
    ...(outputError === undefined ? {} : { outputError }),
  };
}

/** Validates one already-parsed claim entry; returns a frozen claim or a reason. */
function validateClaimEntry(
  entry: unknown,
  scopeIds: ReadonlySet<string>,
): { claim?: Stage2Claim; reason?: Stage2RejectionReason } {
  if (!isPlainObject(entry)) {
    return { reason: "malformed-claim" };
  }
  const keys = Object.keys(entry);
  // Any key outside the exact allowed set fails closed (forbidden
  // fields and unknown fields alike are never stripped and continued).
  for (const key of keys) {
    if (!ALLOWED_CLAIM_KEYS.includes(key)) {
      return { reason: "unknown-field" };
    }
  }
  // Missing keys (no extras, but incomplete) are malformed claims.
  if (keys.length !== ALLOWED_CLAIM_KEYS.length) {
    return { reason: "malformed-claim" };
  }

  const { kind, text, evidenceIds } = entry;

  if (kind !== "fact" && kind !== "conclusion") {
    return { reason: "invalid-kind" };
  }
  if (typeof text !== "string") {
    return { reason: "invalid-claim-text" };
  }
  if (text.length === 0 || text.trim().length === 0) {
    return { reason: "empty-claim-text" };
  }
  if (text.length > MAX_STAGE2_CLAIM_TEXT_CHARACTERS) {
    return { reason: "claim-text-too-long" };
  }
  if (!Array.isArray(evidenceIds)) {
    return { reason: "invalid-evidenceIds" };
  }
  if (evidenceIds.length === 0) {
    return { reason: "empty-evidenceIds" };
  }
  if (evidenceIds.length > MAX_STAGE2_EVIDENCE_IDS_PER_CLAIM) {
    return { reason: "evidenceIds-too-many" };
  }
  for (const id of evidenceIds) {
    // Exact syntax only — no trimming, no case folding, no repair.
    if (typeof id !== "string" || !isValidEvidenceId(id)) {
      return { reason: "malformed-evidence-id" };
    }
    if (!scopeIds.has(id)) {
      return { reason: "unknown-evidence-id" };
    }
  }

  // Duplicates are preserved (C01), never deduplicated.
  const claim: Stage2Claim = Object.freeze({
    kind,
    text,
    evidenceIds: Object.freeze([...(evidenceIds as string[])]),
  });
  return { claim };
}

/**
 * Validates untrusted Stage-2 model output against the frozen claim
 * contract. Accepts either a JSON string (parsed deterministically)
 * or an already-parsed value (still structurally validated).
 *
 * Never throws for bad model data. Throws `Stage2ValidationError`
 * only for malformed caller envelopes (bad options/scope).
 */
export function validateStage2Output(
  output: unknown,
  options: unknown,
): ValidateStage2OutputResult {
  if (!isPlainObject(options)) {
    throw new Stage2ValidationError("Validation options must be an object.");
  }
  const scopeIds = resolveScopeIds(options.scope);

  let parsed: unknown = output;
  if (typeof output === "string") {
    try {
      parsed = JSON.parse(output);
    } catch {
      return failedResult([], [], "malformed-output");
    }
  }
  if (!Array.isArray(parsed)) {
    return failedResult([], [], "malformed-output");
  }

  const accepted: Stage2Claim[] = [];
  const rejected: Stage2Rejection[] = [];
  parsed.forEach((entry, index) => {
    const { claim, reason } = validateClaimEntry(entry, scopeIds);
    if (claim !== undefined) {
      accepted.push(claim);
    } else {
      rejected.push(Object.freeze({ index, reason: reason ?? "malformed-claim" }));
    }
  });
  return failedResult(accepted, rejected);
}
