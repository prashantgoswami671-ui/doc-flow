/**
 * V6-B04 — Immutable production Evidence Store.
 *
 * Owns validated `EvidenceItem`s admitted through the V6-B03 gate and
 * guarantees no later stage can silently rewrite them. Pure and
 * provider-agnostic: no provider, no network, no DOM, no PDF parsing.
 *
 * Trust chain: the ONLY way items enter is `admit()`, which delegates
 * per-chunk validation to `admitChunkEvidence()` (V6-B03) and then
 * enforces whole-store invariants below. There is no `addItems`,
 * no raw-item import, and no update/remove path — by design.
 *
 * Whole-store invariants (checked on every admission):
 * 1. Every item already satisfies the B03 per-item invariants
 *    (containment, ownership, local IDs, dual-contained values).
 * 2. IDs are unique across the WHOLE store, not just per chunk.
 * 3. Each chunk is admitted at most once (prevents silent ID reuse
 *    from re-admitting the same chunk).
 * 4. Admitted chunks belong to this store's context and page range
 *    (enforced by the B03 gate with this store's context).
 *
 * Immutability (all four B01 layers):
 * - TypeScript: only `readonly` views escape (`items`, `snapshot()`).
 * - Runtime: admitted items arrive frozen from B03; the internal
 *   collection is replaced (never mutated) with a frozen array on
 *   every admission; snapshots are fresh frozen copies.
 * - Architectural: Stage 2 (V6-C) will receive `snapshot()` output —
 *   never a writable path to this store.
 * - Defensive copying: `snapshot()` copies; `resolve()` returns the
 *   frozen item itself, which is safe to share precisely because it
 *   is frozen.
 *
 * The `resolve()` lookup is the minimum resolution mechanism the
 * store itself needs (`claim → evidenceId → item`); richer
 * resolution helpers belong to V6-B05 and are NOT built here.
 */

import type { AiContextChunk } from "../types";
import type { EvidenceItem } from "./types";
import { admitChunkEvidence, type EvidenceFailure } from "./validation";

/** Thrown for store misuse (caller error, fail-loud). */
export class EvidenceStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvidenceStoreError";
  }
}

/** Valid store-construction envelope (still runtime-validated). */
export interface CreateEvidenceStoreOptions {
  /** The request's AI-02 chunks (ownership/provenance authority). */
  chunks: AiContextChunk[];
  /** Total pages of the source PDF (page-range authority). */
  sourcePageCount: number;
}

/** Per-chunk admission outcome: newly stored items plus B03 failures. */
export interface AdmitChunkSpansResult {
  readonly admitted: readonly EvidenceItem[];
  readonly failures: readonly EvidenceFailure[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class EvidenceStore {
  private readonly chunks: AiContextChunk[];
  private readonly sourcePageCount: number;
  private stored: readonly EvidenceItem[] = Object.freeze([]);
  private readonly admittedChunks = new Set<number>();

  private constructor(chunks: AiContextChunk[], sourcePageCount: number) {
    this.chunks = chunks;
    this.sourcePageCount = sourcePageCount;
  }

  /**
   * Creates an empty store bound to one request's chunk context.
   * The context is validated fail-loud; per-chunk data enters later
   * only through `admit()`.
   */
  static create(options: unknown): EvidenceStore {
    if (!isPlainObject(options)) {
      throw new EvidenceStoreError("Store options must be an object.");
    }
    const { chunks, sourcePageCount } = options;
    if (!Array.isArray(chunks) || chunks.length === 0) {
      throw new EvidenceStoreError("Store chunks must be a non-empty array.");
    }
    if (!Number.isSafeInteger(sourcePageCount) || (sourcePageCount as number) < 1) {
      throw new EvidenceStoreError("sourcePageCount must be a positive integer.");
    }
    for (const [position, chunk] of chunks.entries()) {
      if (!isPlainObject(chunk)) {
        throw new EvidenceStoreError(`chunks[${position}] must be an object.`);
      }
      if (!Number.isSafeInteger(chunk.chunkIndex) || (chunk.chunkIndex as number) < 0) {
        throw new EvidenceStoreError(
          `chunks[${position}].chunkIndex must be a non-negative integer.`,
        );
      }
      if (!Number.isSafeInteger(chunk.pageNumber) || (chunk.pageNumber as number) < 1) {
        throw new EvidenceStoreError(
          `chunks[${position}].pageNumber must be a positive integer.`,
        );
      }
      if (typeof chunk.text !== "string") {
        throw new EvidenceStoreError(`chunks[${position}].text must be a string.`);
      }
      if ((chunk.pageNumber as number) > (sourcePageCount as number)) {
        throw new EvidenceStoreError(
          `chunks[${position}].pageNumber is outside the page range.`,
        );
      }
    }
    return new EvidenceStore(
      chunks as AiContextChunk[],
      sourcePageCount as number,
    );
  }

  /** Number of stored items. */
  get size(): number {
    return this.stored.length;
  }

  /** Frozen read-only view of all stored items, in admission order. */
  get items(): readonly EvidenceItem[] {
    return this.stored;
  }

  /** Chunk indexes admitted so far, in admission order. */
  get admittedChunkIndexes(): readonly number[] {
    return [...this.admittedChunks];
  }

  /**
   * Validates one chunk's candidate span pool through the B03 gate and
   * stores the admitted items. A chunk may be admitted at most once;
   * unknown chunks and malformed pools fail loud via the gate or the
   * checks below. Rejected spans are reported in `failures` — never
   * repaired, never stored.
   */
  admit(chunkIndex: unknown, spans: unknown): AdmitChunkSpansResult {
    if (!Number.isSafeInteger(chunkIndex) || (chunkIndex as number) < 0) {
      throw new EvidenceStoreError("chunkIndex must be a non-negative integer.");
    }
    const owned = chunkIndex as number;
    if (this.admittedChunks.has(owned)) {
      throw new EvidenceStoreError(
        `Chunk ${owned} has already been admitted and cannot be re-admitted.`,
      );
    }

    const { items, failures } = admitChunkEvidence({
      chunks: this.chunks,
      sourcePageCount: this.sourcePageCount,
      chunkIndex: owned,
      spans,
    });

    const seen = new Set<string>(this.stored.map((item) => item.evidenceId));
    for (const item of items) {
      if (seen.has(item.evidenceId)) {
        throw new EvidenceStoreError(
          `Duplicate evidence ID "${item.evidenceId}" across the store.`,
        );
      }
      seen.add(item.evidenceId);
    }

    this.admittedChunks.add(owned);
    const admitted = Object.freeze([...items]);
    this.stored = Object.freeze([...this.stored, ...items]);
    return { admitted, failures };
  }

  /**
   * Minimum resolution mechanism: ID → frozen item. Returns undefined
   * for unknown or non-string IDs. The returned item is frozen and
   * safe to share.
   */
  resolve(evidenceId: unknown): EvidenceItem | undefined {
    if (typeof evidenceId !== "string") {
      return undefined;
    }
    return this.stored.find((item) => item.evidenceId === evidenceId);
  }

  /**
   * Fresh frozen copy of all stored items for handoff to later stages.
   * Mutating the snapshot (were it possible — it is frozen) can never
   * affect this store.
   */
  snapshot(): readonly EvidenceItem[] {
    return Object.freeze([...this.stored]);
  }
}
