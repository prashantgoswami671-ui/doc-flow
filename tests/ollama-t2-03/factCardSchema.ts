/**
 * T2-03 Fact Card PoC — schema (PoC-ONLY, isolated).
 *
 * Minimal structured intermediate representation between AI-02 chunks and
 * the final summary. This file is intentionally self-contained: it does not
 * import or modify `services/ai/*`. Production constants (endpoint, model)
 * are reused by `factCardClient.ts` via read-only import — never forked.
 *
 * Granularity: exactly 1 Fact Card per AI-02 chunk (`cardId ===
 * "chunk-"+chunkIndex`). Section-level or multi-card-per-chunk splitting is
 * out of PoC scope.
 *
 * The `causal` flag is an EVIDENCE CLASSIFICATION, not a validity proof:
 * `causal:true` means "the model claims this excerpt asserts cause", and
 * deterministic validation only checks that the cited causal excerpt exists
 * verbatim in the source. Human review remains the authority for whether
 * the causal relationship is actually supported.
 */

export type FactCardClaimKind = "fact" | "comparison" | "conclusion";

export interface FactCardDefinition {
  term: string;
  definition: string;
  /** Verbatim substring of the source chunk text supporting this definition. */
  excerpt: string;
}

export interface FactCardNumber {
  /** Verbatim surface form, e.g. "84.78%" — never normalized by the model. */
  value: string;
  /** Verbatim unit or null, e.g. "%". */
  unit?: string | null;
  /** Verbatim substring of the source chunk text containing `value`. */
  excerpt: string;
}

export interface FactCardClaim {
  kind: FactCardClaimKind;
  /** Concise restatement of the claim. */
  text: string;
  /** Verbatim substring of the source chunk text supporting this claim. */
  excerpt: string;
  /**
   * Second supporting excerpt. REQUIRED when kind === "comparison"
   * (one excerpt per side of the comparison); optional otherwise.
   */
  excerpt2?: string | null;
  /** Subset of the card's sourcePages covering this claim. Non-empty. */
  pages: number[];
  /**
   * Evidence classification only. True ONLY when the model asserts the
   * excerpt itself states causation. Never treated as proof of causality.
   */
  causal: boolean;
  /**
   * Required when causal === true: the verbatim causal phrase inside
   * `excerpt` (e.g. containing "because", "led to"). Must be a substring
   * of `excerpt`.
   */
  causalExcerpt?: string | null;
}

export interface FactCard {
  /** Deterministic: "chunk-"+chunkIndex. */
  cardId: string;
  /** Source AiContextChunk.chunkIndex. */
  chunkIndex: number;
  /** Normally [N] for the 1:1 PoC; non-empty, ascending, in 1..sourcePageCount. */
  sourcePages: number[];
  /** The card's closed evidence set: 1..MAX_EXCERPTS_PER_CARD verbatim substrings. */
  excerpts: string[];
  definitions: FactCardDefinition[];
  numbers: FactCardNumber[];
  claims: FactCardClaim[];
}

/** Bounds for the PoC (not production limits). */
export const MAX_EXCERPTS_PER_CARD = 8;
export const MIN_EXCERPT_CHARACTERS = 24;
export const MAX_NUMBERS_PER_CARD = 24;
export const MAX_CLAIMS_PER_CARD = 24;
export const MAX_DEFINITIONS_PER_CARD = 12;

/**
 * Closed list of causal connectives. Used ONLY to require that a
 * `causal:true` claim cites an explicit causal phrase verbatim — NOT as
 * semantic proof that causation is valid.
 */
export const CAUSAL_CONNECTIVES = [
  "because",
  "caused",
  "led to",
  "due to",
  "resulted in",
  "driven by",
  "as a result",
] as const;

export function expectedCardId(chunkIndex: number): string {
  return `chunk-${chunkIndex}`;
}
