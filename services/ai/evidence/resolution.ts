/**
 * V6-B05 — Deterministic evidence-resolution helpers.
 *
 * Generic evidence-reference resolution primitives completing the chain:
 *
 *   evidenceId → immutable EvidenceItem → source chunk
 *
 * (The "claim" end of the roadmap's chain belongs to V6-C: this module
 * deliberately defines NO Stage-2 claim contract, claim schema, or
 * claim validator. It resolves ID references and grounds items against
 * source chunks so a future claim layer can cite IDs without ever
 * handling raw evidence bytes itself.)
 *
 * Pure and provider-agnostic: no provider, no network, no DOM, no PDF
 * parsing. Built only on the committed B02/B03/B04 primitives
 * (`isValidEvidenceId`, `EvidenceItem`, `EvidenceStore`).
 *
 * Fail-closed, two levels (same philosophy as B03/B04):
 * - Malformed envelopes (bad store, non-array ID lists, malformed
 *   items/chunks for source grounding) are caller errors and throw
 *   `EvidenceResolutionError` fail-loud.
 * - Reference problems in well-formed input (malformed ID entries,
 *   well-formed but unknown IDs) never throw: they are reported in
 *   `invalid` / `missing` alongside the successfully resolved items.
 *   Nothing is repaired, guessed, or fuzzy-matched — resolution is
 *   exact-ID equality only.
 */

import type { AiContextChunk } from "../types";
import { isValidEvidenceId } from "./ids";
import { EvidenceStore } from "./store";
import type { EvidenceItem } from "./types";

/** Thrown for malformed resolution input (caller error, fail-loud). */
export class EvidenceResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvidenceResolutionError";
  }
}

/** Valid ID-list resolution envelope (still runtime-validated). */
export interface ResolveEvidenceIdsOptions {
  /** Store to resolve against. */
  store: EvidenceStore;
  /** ID references to resolve, in the caller's order. */
  evidenceIds: unknown;
}

/** ID-list resolution outcome. Requested order (and duplicates) preserved in `items`. */
export interface ResolveEvidenceIdsResult {
  /** Resolved frozen items, in requested order. */
  readonly items: readonly EvidenceItem[];
  /** Well-formed IDs absent from the store (safe identifiers, echoed for diagnostics). */
  readonly missing: readonly string[];
  /** Positions of malformed ID entries (content-free indexes). */
  readonly invalid: readonly number[];
}

/** One grounded evidence reference: frozen item plus its owning source chunk. */
export interface GroundedEvidence {
  readonly item: EvidenceItem;
  readonly chunk: AiContextChunk;
}

/** Full-chain resolution envelope (still runtime-validated). */
export interface ResolveGroundedEvidenceOptions {
  /** Store to resolve IDs against. */
  store: EvidenceStore;
  /** Request's AI-02 chunks (source-grounding authority). */
  chunks: AiContextChunk[];
  /** ID references to ground, in the caller's order. */
  evidenceIds: unknown;
}

/** Full-chain resolution outcome. */
export interface ResolveGroundedEvidenceResult {
  /** Grounded pairs, in requested order. */
  readonly grounded: readonly GroundedEvidence[];
  /** Well-formed IDs absent from the store. */
  readonly missing: readonly string[];
  /** Positions of malformed ID entries. */
  readonly invalid: readonly number[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertValidStore(store: unknown): asserts store is EvidenceStore {
  if (!(store instanceof EvidenceStore)) {
    throw new EvidenceResolutionError("Resolution store must be an EvidenceStore.");
  }
}

function assertValidIdList(evidenceIds: unknown): asserts evidenceIds is unknown[] {
  if (!Array.isArray(evidenceIds)) {
    throw new EvidenceResolutionError("evidenceIds must be an array.");
  }
}

/**
 * Resolves ID references against a store. Exact-ID equality only —
 * no normalization, no fuzzy matching, no repair.
 */
export function resolveEvidenceIds(options: unknown): ResolveEvidenceIdsResult {
  if (!isPlainObject(options)) {
    throw new EvidenceResolutionError("Resolution options must be an object.");
  }
  assertValidStore(options.store);
  assertValidIdList(options.evidenceIds);

  const items: EvidenceItem[] = [];
  const missing: string[] = [];
  const invalid: number[] = [];

  options.evidenceIds.forEach((entry, index) => {
    if (!isValidEvidenceId(entry)) {
      invalid.push(index);
      return;
    }
    const item = (options.store as EvidenceStore).resolve(entry);
    if (item === undefined) {
      missing.push(entry);
      return;
    }
    items.push(item);
  });

  return {
    items: Object.freeze(items),
    missing: Object.freeze(missing),
    invalid: Object.freeze(invalid),
  };
}

/**
 * Grounds one evidence item against its owning source chunk.
 * Re-verifies `exactText` containment defensively: the returned chunk
 * is guaranteed to still contain the item's exact bytes at call time.
 * Anything inconsistent (malformed item, unknown chunk, broken
 * containment) throws — a stored item failing this check means store
 * or context corruption, never something to repair here.
 */
export function resolveEvidenceItemToChunk(
  item: unknown,
  chunks: unknown,
): AiContextChunk {
  if (!isPlainObject(item)) {
    throw new EvidenceResolutionError("Evidence item must be an object.");
  }
  if (typeof item.evidenceId !== "string" || item.evidenceId.length === 0) {
    throw new EvidenceResolutionError("Evidence item must carry a non-empty evidenceId.");
  }
  if (!Number.isSafeInteger(item.chunkIndex) || (item.chunkIndex as number) < 0) {
    throw new EvidenceResolutionError("Evidence item must carry a valid chunkIndex.");
  }
  if (typeof item.exactText !== "string" || (item.exactText as string).length === 0) {
    throw new EvidenceResolutionError("Evidence item must carry a non-empty exactText.");
  }
  if (!Array.isArray(chunks) || chunks.length === 0) {
    throw new EvidenceResolutionError("Resolution chunks must be a non-empty array.");
  }

  const owningChunk = (chunks as AiContextChunk[]).find(
    (chunk) =>
      isPlainObject(chunk) && chunk.chunkIndex === (item.chunkIndex as number),
  );
  if (owningChunk === undefined) {
    throw new EvidenceResolutionError(
      `No source chunk matches chunkIndex ${String(item.chunkIndex)}.`,
    );
  }
  if (
    typeof owningChunk.text !== "string" ||
    !owningChunk.text.includes(item.exactText as string)
  ) {
    throw new EvidenceResolutionError(
      `Evidence "${item.evidenceId as string}" is not contained in its source chunk.`,
    );
  }
  return owningChunk;
}

/**
 * Full deterministic chain: IDs → frozen items → owning source chunks.
 * Reference problems (`missing`/`invalid`) are reported exactly as in
 * `resolveEvidenceIds`; source-grounding runs only over resolved items
 * and throws on inconsistency (see `resolveEvidenceItemToChunk`).
 */
export function resolveGroundedEvidence(
  options: unknown,
): ResolveGroundedEvidenceResult {
  if (!isPlainObject(options)) {
    throw new EvidenceResolutionError("Resolution options must be an object.");
  }
  assertValidStore(options.store);
  if (!Array.isArray(options.chunks) || options.chunks.length === 0) {
    throw new EvidenceResolutionError("Resolution chunks must be a non-empty array.");
  }
  assertValidIdList(options.evidenceIds);

  const { items, missing, invalid } = resolveEvidenceIds({
    store: options.store,
    evidenceIds: options.evidenceIds,
  });

  const grounded = items.map((item) => ({
    item,
    chunk: resolveEvidenceItemToChunk(item, options.chunks),
  }));

  return { grounded: Object.freeze(grounded), missing, invalid };
}
