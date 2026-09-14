/**
 * T2-03 Fact Card PoC — deterministic validator (PoC-ONLY, isolated).
 *
 * Pure, dependency-free, offline-testable. Mirrors the style of
 * `services/ai/validation.ts` but validates Fact Cards, not AI requests.
 * Rejects malformed cards with machine-checkable `reasons[]` — never throws
 * on invalid card content (throws only on caller misuse, e.g. bad chunk).
 *
 * Provenance rule: every accepted important fact retains chunkIndex +
 * sourcePage + supportingExcerpt, where each excerpt is a verbatim
 * substring of the source chunk text (whitespace-normalized comparison).
 */

import {
  CAUSAL_CONNECTIVES,
  MAX_CLAIMS_PER_CARD,
  MAX_DEFINITIONS_PER_CARD,
  MAX_EXCERPTS_PER_CARD,
  MAX_NUMBERS_PER_CARD,
  MIN_EXCERPT_CHARACTERS,
  expectedCardId,
  type FactCardClaim,
} from "./factCardSchema";

export interface FactCardSourceChunk {
  chunkIndex: number;
  pageNumber: number;
  text: string;
}

export interface FactCardValidationResult {
  ok: boolean;
  reasons: string[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Collapse all whitespace runs so PDF.js spacing quirks don't break matching. */
export function normalizeForMatch(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function containsVerbatim(haystack: string, needle: string): boolean {
  if (normalizeForMatch(needle).length === 0) {
    return false;
  }
  return normalizeForMatch(haystack).includes(normalizeForMatch(needle));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isValidPageList(pages: unknown, sourcePageCount: number): boolean {
  if (!Array.isArray(pages) || pages.length === 0) {
    return false;
  }
  let previous = 0;
  for (const page of pages) {
    if (!Number.isSafeInteger(page) || page < 1 || page > sourcePageCount) {
      return false;
    }
    if (page <= previous) {
      return false; // must be strictly ascending
    }
    previous = page;
  }
  return true;
}

function causalExcerptHasConnective(causalExcerpt: string): boolean {
  const lowered = causalExcerpt.toLowerCase();
  return CAUSAL_CONNECTIVES.some((connective) => lowered.includes(connective));
}

function validateClaim(
  claim: unknown,
  index: number,
  chunkText: string,
  cardSourcePages: number[],
  reasons: string[],
): void {
  const prefix = `claims[${index}]`;
  if (!isPlainObject(claim)) {
    reasons.push(`${prefix} must be an object.`);
    return;
  }
  const typed = claim as unknown as FactCardClaim;
  const validKinds = ["definition", "fact", "comparison", "conclusion"];
  if (!validKinds.includes(typed.kind as string)) {
    reasons.push(`${prefix}.kind must be one of ${validKinds.join(", ")}.`);
  }
  if (!isNonEmptyString(typed.text)) {
    reasons.push(`${prefix}.text must be a non-empty string.`);
  }
  if (!isNonEmptyString(typed.excerpt) || !containsVerbatim(chunkText, typed.excerpt)) {
    reasons.push(`${prefix}.excerpt must be a verbatim substring of the source chunk text.`);
  }
  if (!Array.isArray(typed.pages) || typed.pages.length === 0) {
    reasons.push(`${prefix}.pages must be a non-empty page list.`);
  } else {
    for (const page of typed.pages) {
      if (!cardSourcePages.includes(page as number)) {
        reasons.push(`${prefix}.pages must be a subset of the card sourcePages.`);
        break;
      }
    }
  }
  if (typed.kind === "comparison") {
    if (!isNonEmptyString(typed.excerpt2) || !containsVerbatim(chunkText, typed.excerpt2)) {
      reasons.push(
        `${prefix} is a comparison and requires excerpt2 as a second verbatim substring of the source chunk text (one excerpt per side).`,
      );
    }
  }
  if (typeof typed.causal !== "boolean") {
    reasons.push(`${prefix}.causal must be a boolean evidence-classification flag.`);
    return;
  }
  if (typed.causal) {
    // Evidence classification only: the cited causal phrase must exist
    // verbatim inside the claim excerpt and contain an explicit connective.
    // This is NOT proof the causal relationship is valid — human review decides.
    if (!isNonEmptyString(typed.causalExcerpt)) {
      reasons.push(`${prefix}.causalExcerpt is required when causal is true.`);
    } else if (!containsVerbatim(typed.excerpt ?? "", typed.causalExcerpt)) {
      reasons.push(`${prefix}.causalExcerpt must be a substring of the claim excerpt.`);
    } else if (!causalExcerptHasConnective(typed.causalExcerpt)) {
      reasons.push(
        `${prefix}.causalExcerpt must contain an explicit causal connective for review (${CAUSAL_CONNECTIVES.join(" / ")}). Flagged for human review.`,
      );
    }
  }
}

/**
 * Validates an unknown value as a Fact Card against its source chunk.
 * Returns `{ok, reasons}` — `ok` true only when every rule passes.
 */
export function validateFactCard(
  card: unknown,
  chunk: FactCardSourceChunk,
  sourcePageCount: number,
): FactCardValidationResult {
  const reasons: string[] = [];

  if (!isPlainObject(card)) {
    return { ok: false, reasons: ["Card must be an object."] };
  }
  if (!Number.isSafeInteger(chunk.chunkIndex) || chunk.chunkIndex < 0) {
    throw new Error("chunk.chunkIndex must be a non-negative integer.");
  }
  if (!Number.isSafeInteger(chunk.pageNumber) || chunk.pageNumber < 1) {
    throw new Error("chunk.pageNumber must be a positive integer.");
  }
  if (typeof chunk.text !== "string" || chunk.text.length === 0) {
    throw new Error("chunk.text must be a non-empty string.");
  }
  if (!Number.isSafeInteger(sourcePageCount) || sourcePageCount < 1) {
    throw new Error("sourcePageCount must be a positive integer.");
  }

  const chunkText = chunk.text;

  // 1. Card ID / chunk mapping.
  if (card.cardId !== expectedCardId(chunk.chunkIndex) || card.chunkIndex !== chunk.chunkIndex) {
    reasons.push(
      `cardId must be "${expectedCardId(chunk.chunkIndex)}" with matching chunkIndex ${chunk.chunkIndex}.`,
    );
  }

  // 2. Page provenance.
  if (!isValidPageList(card.sourcePages, sourcePageCount)) {
    reasons.push("sourcePages must be a non-empty ascending list within 1..sourcePageCount.");
  } else if (!(card.sourcePages as number[]).includes(chunk.pageNumber)) {
    reasons.push("sourcePages must include the source chunk pageNumber (1:1 PoC mapping).");
  }
  const cardSourcePages = Array.isArray(card.sourcePages)
    ? (card.sourcePages as number[])
    : [];

  // 3. Evidence set.
  if (!Array.isArray(card.excerpts) || card.excerpts.length === 0) {
    reasons.push("excerpts must be a non-empty array of verbatim source substrings.");
  } else if (card.excerpts.length > MAX_EXCERPTS_PER_CARD) {
    reasons.push(`excerpts must contain at most ${MAX_EXCERPTS_PER_CARD} entries.`);
  } else {
    card.excerpts.forEach((excerpt: unknown, index: number) => {
      if (!isNonEmptyString(excerpt)) {
        reasons.push(`excerpts[${index}] must be a non-empty string.`);
      } else if (normalizeForMatch(excerpt).length < MIN_EXCERPT_CHARACTERS) {
        reasons.push(`excerpts[${index}] must be at least ${MIN_EXCERPT_CHARACTERS} characters.`);
      } else if (!containsVerbatim(chunkText, excerpt)) {
        reasons.push(`excerpts[${index}] must be present verbatim in the source chunk text.`);
      }
    });
  }

  // 4. Definitions.
  if (!Array.isArray(card.definitions)) {
    reasons.push("definitions must be an array.");
  } else if (card.definitions.length > MAX_DEFINITIONS_PER_CARD) {
    reasons.push(`definitions must contain at most ${MAX_DEFINITIONS_PER_CARD} entries.`);
  } else {
    card.definitions.forEach((entry: unknown, index: number) => {
      const prefix = `definitions[${index}]`;
      if (!isPlainObject(entry)) {
        reasons.push(`${prefix} must be an object.`);
        return;
      }
      const typed = entry as unknown as { term: string; definition: string; excerpt: string };
      if (!isNonEmptyString(typed.term)) {
        reasons.push(`${prefix}.term must be a non-empty string.`);
      }
      if (!isNonEmptyString(typed.definition)) {
        reasons.push(`${prefix}.definition must be a non-empty string.`);
      }
      if (!isNonEmptyString(typed.excerpt) || !containsVerbatim(chunkText, typed.excerpt)) {
        reasons.push(`${prefix}.excerpt must be a verbatim substring of the source chunk text.`);
      }
    });
  }

  // 5. Numbers — value must appear inside its own evidence.
  if (!Array.isArray(card.numbers)) {
    reasons.push("numbers must be an array.");
  } else if (card.numbers.length > MAX_NUMBERS_PER_CARD) {
    reasons.push(`numbers must contain at most ${MAX_NUMBERS_PER_CARD} entries.`);
  } else {
    card.numbers.forEach((entry: unknown, index: number) => {
      const prefix = `numbers[${index}]`;
      if (!isPlainObject(entry)) {
        reasons.push(`${prefix} must be an object.`);
        return;
      }
      const typed = entry as unknown as { value: string; unit?: unknown; excerpt: string };
      if (!isNonEmptyString(typed.value)) {
        reasons.push(`${prefix}.value must be a non-empty verbatim string.`);
      }
      if (typed.unit !== undefined && typed.unit !== null && typeof typed.unit !== "string") {
        reasons.push(`${prefix}.unit must be a string or null.`);
      }
      if (!isNonEmptyString(typed.excerpt) || !containsVerbatim(chunkText, typed.excerpt)) {
        reasons.push(`${prefix}.excerpt must be a verbatim substring of the source chunk text.`);
      } else if (
        isNonEmptyString(typed.value) &&
        !containsVerbatim(typed.excerpt, typed.value)
      ) {
        reasons.push(`${prefix}.value must appear inside its own excerpt evidence.`);
      }
    });
  }

  // 6. Claims (facts + comparisons + conclusions).
  if (!Array.isArray(card.claims)) {
    reasons.push("claims must be an array.");
  } else if (card.claims.length > MAX_CLAIMS_PER_CARD) {
    reasons.push(`claims must contain at most ${MAX_CLAIMS_PER_CARD} entries.`);
  } else {
    card.claims.forEach((claim: unknown, index: number) =>
      validateClaim(claim, index, chunkText, cardSourcePages, reasons),
    );
  }

  return { ok: reasons.length === 0, reasons };
}
