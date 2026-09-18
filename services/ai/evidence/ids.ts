/**
 * V6-B02 — Deterministic evidence-ID primitive.
 *
 * Local, provider-agnostic ID generation for the future production
 * Evidence Store (Roadmap v6 Phase V6-B). IDs encode the owning chunk
 * (`chunk-<chunkIndex>-e<per-chunk-sequence>`) and are assigned locally
 * AFTER validation/admission — never taken from model output.
 *
 * Properties (per the approved V6-B01 design review):
 * - deterministic, pure, side-effect free;
 * - independent of provider, model output, document contents, time,
 *   randomness, and global mutable state — the sequence is supplied by
 *   the caller (the future V6-B03 admission stage owns counting);
 * - request/session-local; NOT a persistence key; NOT a content hash.
 *
 * Actual assignment of IDs to admitted evidence belongs to V6-B03.
 * The model must never become the authority for evidence identity.
 */

/** Thrown when an evidence-ID input or ID string is malformed. */
export class EvidenceIdError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvidenceIdError";
  }
}

/** Canonical evidence-ID shape: `chunk-<chunkIndex>-e<sequence>`. */
const EVIDENCE_ID_PATTERN = /^chunk-(\d+)-e(\d+)$/;

function assertValidComponent(
  value: unknown,
  name: "chunkIndex" | "sequence",
): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new EvidenceIdError(
      `Evidence-ID ${name} must be a non-negative safe integer (received ${formatReceived(value)}).`,
    );
  }
}

function formatReceived(value: unknown): string {
  if (typeof value === "string") {
    return `"${value}"`;
  }
  if (value === null) {
    return "null";
  }
  if (typeof value === "undefined") {
    return "undefined";
  }
  if (typeof value === "number") {
    if (Number.isNaN(value)) {
      return "NaN";
    }
    return String(value);
  }
  return typeof value;
}

/**
 * Creates a deterministic evidence ID for the given owning chunk and
 * per-chunk sequence number. Both inputs must be non-negative safe
 * integers — strings, floats, NaN, Infinity, null, undefined, and
 * booleans are rejected, never coerced.
 *
 * createEvidenceId(0, 0) → "chunk-0-e0"
 * createEvidenceId(0, 1) → "chunk-0-e1"
 * createEvidenceId(1, 0) → "chunk-1-e0"
 * createEvidenceId(4, 7) → "chunk-4-e7"
 */
export function createEvidenceId(chunkIndex: unknown, sequence: unknown): string {
  assertValidComponent(chunkIndex, "chunkIndex");
  assertValidComponent(sequence, "sequence");
  return `chunk-${chunkIndex}-e${sequence}`;
}

/** Structured components of a parsed evidence ID. */
export interface EvidenceIdComponents {
  chunkIndex: number;
  sequence: number;
}

/**
 * Parses a canonical evidence-ID string into its components. Verifies
 * `^chunk-(\d+)-e(\d+)$` and that both segments are safe integers.
 * This is an ID-shape check only — it does not verify source-chunk
 * existence, pages, evidence text, store uniqueness, or anything
 * belonging to V6-B03/B04/B05.
 */
export function parseEvidenceId(id: unknown): EvidenceIdComponents {
  if (typeof id !== "string") {
    throw new EvidenceIdError(
      `Evidence ID must be a string (received ${formatReceived(id)}).`,
    );
  }
  const match = EVIDENCE_ID_PATTERN.exec(id);
  if (match === null) {
    throw new EvidenceIdError(
      `Malformed evidence ID "${id}". Expected "chunk-<chunkIndex>-e<sequence>".`,
    );
  }
  const chunkIndex = Number(match[1]);
  const sequence = Number(match[2]);
  if (!Number.isSafeInteger(chunkIndex) || !Number.isSafeInteger(sequence)) {
    throw new EvidenceIdError(`Malformed evidence ID "${id}". Segments must be safe integers.`);
  }
  return { chunkIndex, sequence };
}

/**
 * Narrowing shape check for evidence-ID strings. Same acceptance as
 * `parseEvidenceId` but boolean instead of throwing.
 */
export function isValidEvidenceId(id: unknown): id is string {
  if (typeof id !== "string") {
    return false;
  }
  const match = EVIDENCE_ID_PATTERN.exec(id);
  if (match === null) {
    return false;
  }
  return Number.isSafeInteger(Number(match[1])) && Number.isSafeInteger(Number(match[2]));
}
