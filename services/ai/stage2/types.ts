/**
 * V6-C02 — Frozen production Stage-2 types (provider-agnostic).
 *
 * This module is the TYPE-ONLY transcription of the approved V6-C01
 * frozen contract. It must not be extended here: V6-C02 validates
 * this shape, V6-C03 projects it, and neither layer may invent the
 * contract. No provider, no network, no DOM, no PDF parsing.
 *
 * Deliberately absent (fail-closed in validation):
 * `pages`, `sourcePages`, `chunkIndex`, `sourcePageCount`, `exactText`,
 * `excerpt`, `excerpt2`, `causalExcerpt`, `value`, `unit`, singular
 * `evidenceId`, `causal`, `causalEvidenceId`, comparison fields,
 * attribution fields, arbitrary metadata, and raw `AiContextChunk.text`.
 */

import type { EvidenceKind } from "../evidence/types";

/** Closed local task vocabulary for v1. The task selects claim style only. */
export type Stage2TaskId = "summarize";

/** Allowed claim classifications for v1. Comparison/attribution are UNSUPPORTED. */
export type Stage2ClaimKind = "fact" | "conclusion";

/**
 * Model-visible evidence projection (snapshot copy, not the stored item).
 * Provenance (`sourcePages`, `chunkIndex`) and page-range authority
 * (`sourcePageCount`) stay local in the Evidence Store / validator
 * context and are NOT visible to the model.
 */
export interface Stage2EvidenceView {
  readonly evidenceId: string;
  readonly exactText: string;
  readonly kind: EvidenceKind;
  readonly value?: string;
}

/**
 * Exact model-visible Stage-2 input. Raw chunk text is NOT included.
 * The task identifier must never authorize source-excerpt emission.
 */
export interface Stage2Input {
  readonly evidence: readonly Stage2EvidenceView[];
  readonly task: Stage2TaskId;
}

/**
 * The complete v1 production claim contract. Exactly these three keys.
 * The model cites evidence IDs; it never mints identity, wording,
 * ownership, numeric surfaces, or provenance.
 */
export interface Stage2Claim {
  readonly kind: Stage2ClaimKind;
  readonly text: string;
  readonly evidenceIds: readonly string[];
}
