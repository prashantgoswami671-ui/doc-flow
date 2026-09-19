/**
 * V6-B03 — Deterministic evidence validation / admission.
 *
 * The gate between Stage-1 evidence acquisition (model-copied candidate
 * spans for one AI-02 chunk) and the future Evidence Store (V6-B04).
 * Pure and dependency-free apart from the local ID primitive and types:
 * no provider, no network, no DOM, no PDF parsing.
 *
 * Admission is per requesting chunk. The caller supplies the request's
 * AI-02 chunks, the source page count, the requesting chunk index, and
 * the model's candidate span pool for that chunk (bare strings — the v1
 * candidate shape carries no metadata; any non-string entry, including
 * objects that could smuggle metadata or binary payloads, is rejected).
 *
 * Fail-closed, two levels (mirrors the `validation.ts` philosophy):
 * - Malformed admission envelope (bad options, bad chunk context, bad
 *   page scope, non-array span pool) is a caller/programmer error and
 *   throws `EvidenceValidationError` fail-loud.
 * - Bad model data (non-string, empty, non-contained spans) never throws:
 *   the item is dropped, counted in `failures` with an index and a
 *   content-free reason, and valid siblings are still admitted. Nothing
 *   is repaired, retried, or normalized — ever.
 *
 * Deterministic decisions owned here (never the model):
 * - evidence IDs, minted post-validation via `createEvidenceId` with a
 *   dense per-chunk sequence over admitted items only;
 * - chunk/page ownership, copied from the owning `AiContextChunk`;
 * - `kind` via the conservative numeric-promotion pattern below.
 *
 * Explicitly NOT here (future work): store uniqueness across chunks,
 * immutable storage (V6-B04), resolution helpers (V6-B05), Stage-2
 * validation/reasoning (V6-C). Duplicate identical spans admitted for
 * the same chunk receive distinct IDs; dedup policy, if ever wanted,
 * belongs to a later layer, not this gate.
 */

import type { AiContextChunk } from "../types";
import { createEvidenceId } from "./ids";
import type { EvidenceItem } from "./types";

/** Thrown for a malformed admission envelope (caller error, fail-loud). */
export class EvidenceValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvidenceValidationError";
  }
}

/**
 * Per-item rejection reasons. Content-free by design (index + reason
 * only — no document text leaks into failure records, per SEC-06 §4).
 */
export type EvidenceFailureReason =
  | "malformed-span"
  | "empty-exactText"
  | "not-contained"
  | "invalid-value";

/** A single rejected candidate span. */
export interface EvidenceFailure {
  /** Position of the rejected span in the input pool. */
  index: number;
  reason: EvidenceFailureReason;
}

/** Valid admission envelope (still runtime-validated — see below). */
export interface AdmitChunkEvidenceOptions {
  /** The request's AI-02 chunks (ownership/provenance source). */
  chunks: AiContextChunk[];
  /** Total pages of the source PDF (page-range authority). */
  sourcePageCount: number;
  /** Requesting chunk whose candidate pool `spans` belongs to. */
  chunkIndex: number;
  /** Model-copied candidate spans for this chunk. Must be an array. */
  spans: unknown;
}

/** Admission outcome: frozen admitted items plus counted rejections. */
export interface AdmitChunkEvidenceResult {
  readonly items: readonly EvidenceItem[];
  readonly failures: readonly EvidenceFailure[];
}

/**
 * Strong numeric surface forms (unchanged v1 behavior): currency-marked
 * (`₹`), decimal (`61.11`), percent (`82%`), or comma-grouped
 * (`1,14,271`) surfaces. Checked before the integer-count rule below.
 */
const STRONG_NUMERIC_VALUE_PATTERN = /₹\s?-?\d[\d,]*(?:\.\d+)?%?|-?\d{1,3}(?:,\d{2,3})+(?:\.\d+)?%?|-?\d+\.\d+%?|-?\d+%/;

/**
 * Integer-count rule (deterministic, model-free).
 *
 * A standalone integer promotes with its digit surface as `value` only
 * when it carries clear count context: whitespace followed by a letter
 * word (`42 people`, `150 households`, `7 districts`). Bare integers
 * with no following word (`2024`, `17`) never promote.
 *
 * Conservative exclusions (checked in order per candidate):
 * - glued digits (`ISO9001`, decimals, comma groups) — the char before
 *   the run must not be a word char, comma, or period;
 * - four-digit runs (`2024`, `1991`) — likely years, not counts
 *   (thousands written Indian-style still promote via the grouped
 *   alternative above);
 * - figure/table-governed references (`Fig. 2 for`, `Table 3 shows`) —
 *   digits immediately governed by a label are references, not counts.
 *
 * First valid candidate wins; `value` is the digit surface only (never
 * parsed into a number, never normalized).
 */
const COUNT_CANDIDATE_SOURCE = "(-?\\d+)\\s+([A-Za-z][A-Za-z-]*)";
const LABEL_GOVERNED_TAIL =
  /\b(fig|figure|tables?|sections?|chapters?|pages?|plates?|equations?|appendix|annex(?:ure)?)\s*\.?\s*$/i;

function extractCountValue(exactText: string): string | null {
  const pattern = new RegExp(COUNT_CANDIDATE_SOURCE, "g");
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(exactText)) !== null) {
    const surface = match[1] as string;
    const digits = surface.startsWith("-") ? surface.slice(1) : surface;
    const start = match.index;
    const prev = start > 0 ? (exactText[start - 1] as string) : " ";
    if (/[\w,.]/.test(prev)) {
      continue;
    }
    if (digits.length === 4) {
      continue;
    }
    if (LABEL_GOVERNED_TAIL.test(exactText.slice(0, start))) {
      continue;
    }
    return surface;
  }
  return null;
}

/** First numeric surface form in `exactText`, or null when it stays a span. */
function extractNumericSurface(exactText: string): string | null {
  const strong = STRONG_NUMERIC_VALUE_PATTERN.exec(exactText);
  if (strong !== null) {
    return strong[0];
  }
  return extractCountValue(exactText);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface ResolvedAdmissionContext {
  owningChunk: AiContextChunk;
  chunkIndex: number;
  spans: unknown[];
}

/** Validates the admission envelope fail-loud; per-item data is never thrown for. */
function resolveAdmissionContext(options: unknown): ResolvedAdmissionContext {
  if (!isPlainObject(options)) {
    throw new EvidenceValidationError("Admission options must be an object.");
  }

  const { chunks, sourcePageCount, chunkIndex, spans } = options;

  if (!Array.isArray(chunks) || chunks.length === 0) {
    throw new EvidenceValidationError("Admission chunks must be a non-empty array.");
  }
  for (const [position, chunk] of chunks.entries()) {
    if (!isPlainObject(chunk)) {
      throw new EvidenceValidationError(`chunks[${position}] must be an object.`);
    }
    if (!Number.isSafeInteger(chunk.chunkIndex) || (chunk.chunkIndex as number) < 0) {
      throw new EvidenceValidationError(
        `chunks[${position}].chunkIndex must be a non-negative integer.`,
      );
    }
    if (!Number.isSafeInteger(chunk.pageNumber) || (chunk.pageNumber as number) < 1) {
      throw new EvidenceValidationError(
        `chunks[${position}].pageNumber must be a positive integer.`,
      );
    }
    if (typeof chunk.text !== "string") {
      throw new EvidenceValidationError(`chunks[${position}].text must be a string.`);
    }
  }

  if (!Number.isSafeInteger(sourcePageCount) || (sourcePageCount as number) < 1) {
    throw new EvidenceValidationError("sourcePageCount must be a positive integer.");
  }

  if (!Number.isSafeInteger(chunkIndex) || (chunkIndex as number) < 0) {
    throw new EvidenceValidationError("chunkIndex must be a non-negative integer.");
  }

  const owningChunk = (chunks as AiContextChunk[]).find(
    (chunk) => chunk.chunkIndex === chunkIndex,
  );
  if (owningChunk === undefined) {
    throw new EvidenceValidationError(
      `chunkIndex ${String(chunkIndex)} does not match any supplied chunk.`,
    );
  }
  if (owningChunk.pageNumber > (sourcePageCount as number)) {
    throw new EvidenceValidationError(
      `Owning chunk page ${owningChunk.pageNumber} is outside the ${String(sourcePageCount)}-page range.`,
    );
  }

  if (!Array.isArray(spans)) {
    throw new EvidenceValidationError("Admission spans must be an array.");
  }

  return { owningChunk, chunkIndex: chunkIndex as number, spans };
}

/**
 * Validates one chunk's candidate span pool and admits the valid items.
 * See the module doc comment for the fail-closed contract.
 */
export function admitChunkEvidence(options: unknown): AdmitChunkEvidenceResult {
  const { owningChunk, chunkIndex, spans } = resolveAdmissionContext(options);

  const items: EvidenceItem[] = [];
  const failures: EvidenceFailure[] = [];
  let sequence = 0;

  spans.forEach((span, index) => {
    if (typeof span !== "string") {
      failures.push({ index, reason: "malformed-span" });
      return;
    }
    if (span.length === 0 || span.trim().length === 0) {
      failures.push({ index, reason: "empty-exactText" });
      return;
    }
    if (!owningChunk.text.includes(span)) {
      failures.push({ index, reason: "not-contained" });
      return;
    }

    const value = extractNumericSurface(span);
    // Dual containment: value ⊆ exactText ⊆ chunk by construction —
    // still asserted explicitly so the invariant never depends on it.
    if (
      value !== null &&
      (!span.includes(value) || !owningChunk.text.includes(value))
    ) {
      failures.push({ index, reason: "invalid-value" });
      return;
    }

    const evidenceId = createEvidenceId(chunkIndex, sequence);
    sequence += 1;

    items.push(
      Object.freeze(
        value === null
          ? {
              evidenceId,
              chunkIndex,
              sourcePages: Object.freeze([owningChunk.pageNumber]),
              exactText: span,
              kind: "span" as const,
            }
          : {
              evidenceId,
              chunkIndex,
              sourcePages: Object.freeze([owningChunk.pageNumber]),
              exactText: span,
              kind: "number" as const,
              value,
            },
      ),
    );
  });

  return { items: Object.freeze(items), failures: Object.freeze(failures) };
}
