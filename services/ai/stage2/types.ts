/**
 * V6-C02 — Frozen production Stage-2 types (provider-agnostic).
 *
 * This module is the TYPE-ONLY transcription of the approved V6-C01
 * frozen contract. It must not be extended here: V6-C02 validates
 * this shape, V6-C03 projects it, and neither layer may invent the
 * contract. No provider, no network, no DOM, no PDF parsing.
 *
 * V7-A04 extension (descriptive model-visible context only): each
 * evidence view additionally carries the owning `sourcePage` /
 * `chunk` locators, and the input carries `sourcePageCount`, so
 * Stage-2 can reason with document-coverage awareness. These values
 * are copied from authoritative local sources (the EvidenceItem and
 * the request context) — the model may read them but must never
 * emit them: the claim contract below is unchanged, and C02 still
 * rejects any sourcePage/chunk/sourcePageCount claim field as unknown.
 * (V7-A04.2: the locator is named `sourcePage`, not `page` — the
 * short `page` key deterministically perturbed exact evidence-ID
 * copying in the local model per the V7-A04.1 stability study.)
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
 * `sourcePage` / `chunk` are descriptive locators copied from the item's
 * authoritative `sourcePages` / `chunkIndex` (see tier2Summarize.ts):
 * the model may use them for coverage awareness but must never emit
 * them — the claim contract below admits no such fields. Raw chunk
 * text, multi-page provenance arrays, and page-range authority
 * (`sourcePageCount`) stay local, except that `sourcePageCount` is
 * additionally surfaced once at the input level (V7-A04) as the
 * document denominator.
 */
export interface Stage2EvidenceView {
  readonly evidenceId: string;
  readonly exactText: string;
  readonly kind: EvidenceKind;
  readonly value?: string;
  /** One-based owning page (descriptive context only). */
  readonly sourcePage: number;
  /** Owning chunk index (descriptive context only). */
  readonly chunk: number;
}

/**
 * Exact model-visible Stage-2 input. Raw chunk text is NOT included.
 * The task identifier must never authorize source-excerpt emission.
 * `sourcePageCount` is the document denominator for coverage
 * awareness (descriptive context only — never a claim field).
 */
export interface Stage2Input {
  readonly evidence: readonly Stage2EvidenceView[];
  readonly task: Stage2TaskId;
  readonly sourcePageCount: number;
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
