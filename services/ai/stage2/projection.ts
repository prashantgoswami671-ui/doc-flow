/**
 * V6-C03 — Deterministic grounded result projection.
 *
 * Converts already-validated `Stage2Claim[]` (V6-C02) plus the request's
 * `EvidenceStore` and source chunks into locally grounded result
 * objects. Pure and provider-agnostic: no provider, no network, no
 * DOM, no PDF parsing, no UI.
 *
 * Architectural rule: the model is NOT the source of truth for
 * displayed evidence. Displayed evidence comes exclusively from the
 * B05 resolution path (`resolveGroundedEvidence`); the model's
 * `claim.text` is carried through as a restatement only and is never
 * treated, copied, or displayed as source evidence.
 *
 * Fail-closed: any claim that cannot be fully grounded throws
 * `Stage2ProjectionError`. There are no partial claims, no fallback
 * evidence, and no synthetic summaries. An empty claim collection
 * projects to an empty grounded collection (the user-facing
 * limited/unsupported state belongs to a later layer, not here).
 */

import type { AiContextChunk } from "../types";
import type { GroundedEvidence } from "../evidence/resolution";
import { EvidenceResolutionError, resolveGroundedEvidence } from "../evidence/resolution";
import { EvidenceStore } from "../evidence/store";
import type { Stage2Claim, Stage2ClaimKind } from "./types";

/** Thrown when projection cannot fully ground (caller/store inconsistency). */
export class Stage2ProjectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Stage2ProjectionError";
  }
}

/**
 * One locally grounded claim.
 *
 * - `kind` / `text` / `evidenceIds`: carried from the validated claim
 *   (`text` is the model restatement, never source evidence).
 * - `evidence`: B05-grounded store evidence in `evidenceIds` order,
 *   duplicates preserved. The ONLY source-evidence carrier.
 */
export interface GroundedStage2Claim {
  readonly kind: Stage2ClaimKind;
  readonly text: string;
  readonly evidenceIds: readonly string[];
  readonly evidence: readonly GroundedEvidence[];
}

/** Projection envelope (still runtime-validated — see below). */
export interface ProjectGroundedClaimsOptions {
  /** Already-validated Stage2Claim array (V6-C02 output). */
  claims: unknown;
  /** The request's EvidenceStore — the sole evidence authority. */
  store: unknown;
  /** The request's source chunks for B05 defensive grounding. */
  chunks: unknown;
}

/** Projection outcome: frozen grounded claims in input order. */
export interface ProjectGroundedClaimsResult {
  readonly grounded: readonly GroundedStage2Claim[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Re-checks one validated-claim entry fail-loud. Projection never
 * trusts its input blindly: shape drift, forbidden fields, or
 * non-string IDs are caller errors, not something to repair.
 * Messages are content-free (index + category only).
 */
function assertValidatedClaimShape(entry: unknown, index: number): asserts entry is Stage2Claim {
  if (!isPlainObject(entry)) {
    throw new Stage2ProjectionError(`Claim ${index} is malformed.`);
  }
  const keys = Object.keys(entry);
  if (keys.length !== 3 || !(keys.includes("kind") && keys.includes("text") && keys.includes("evidenceIds"))) {
    throw new Stage2ProjectionError(`Claim ${index} has an invalid field set.`);
  }
  const { kind, text, evidenceIds } = entry;
  if (kind !== "fact" && kind !== "conclusion") {
    throw new Stage2ProjectionError(`Claim ${index} has an invalid kind.`);
  }
  if (typeof text !== "string" || text.length === 0 || text.trim().length === 0) {
    throw new Stage2ProjectionError(`Claim ${index} has invalid text.`);
  }
  if (!Array.isArray(evidenceIds) || evidenceIds.length === 0) {
    throw new Stage2ProjectionError(`Claim ${index} has invalid evidenceIds.`);
  }
  for (const id of evidenceIds) {
    if (typeof id !== "string") {
      throw new Stage2ProjectionError(`Claim ${index} has a malformed evidence reference.`);
    }
  }
}

/**
 * Projects validated claims to store-grounded results. Order and
 * duplicates are preserved end to end via B05; nothing is
 * deduplicated, reordered, normalized, or fuzzy-matched.
 */
export function projectGroundedClaims(options: unknown): ProjectGroundedClaimsResult {
  if (!isPlainObject(options)) {
    throw new Stage2ProjectionError("Projection options must be an object.");
  }
  const { claims, store, chunks } = options;
  if (!(store instanceof EvidenceStore)) {
    throw new Stage2ProjectionError("Projection store must be an EvidenceStore.");
  }
  if (!Array.isArray(chunks) || chunks.length === 0) {
    throw new Stage2ProjectionError("Projection chunks must be a non-empty array.");
  }
  if (!Array.isArray(claims)) {
    throw new Stage2ProjectionError("Projection claims must be an array.");
  }

  const grounded: GroundedStage2Claim[] = claims.map((entry, index) => {
    assertValidatedClaimShape(entry, index);
    let resolved: readonly GroundedEvidence[];
    try {
      const outcome = resolveGroundedEvidence({
        store,
        chunks: chunks as AiContextChunk[],
        evidenceIds: entry.evidenceIds,
      });
      if (outcome.missing.length > 0 || outcome.invalid.length > 0) {
        throw new Stage2ProjectionError(
          `Claim ${index} references evidence outside the permitted scope.`,
        );
      }
      resolved = outcome.grounded;
    } catch (error) {
      if (error instanceof Stage2ProjectionError) {
        throw error;
      }
      if (error instanceof EvidenceResolutionError) {
        throw new Stage2ProjectionError(
          `Claim ${index} failed source grounding and was not projected.`,
        );
      }
      throw error;
    }
    return Object.freeze({
      kind: entry.kind,
      text: entry.text,
      evidenceIds: Object.freeze([...entry.evidenceIds]),
      evidence: resolved,
    });
  });

  return { grounded: Object.freeze(grounded) };
}
