/**
 * T2-04 Evidence Handoff — offline POC fixture (NO Ollama calls).
 *
 * Demonstrates the core grounding invariant of the two-stage design:
 *   claim.evidenceIds → deterministic resolution → immutable validated exactText
 * plus fail-closed negatives (unknown ID, Stage-2-emitted excerpt, non-verbatim
 * Stage-1 text). All logic here is fixture-local; it does not modify the T2-03
 * validators or any production code.
 */

import { describe, expect, it } from "vitest";

interface EvidenceItem {
  evidenceId: string;
  chunkIndex: number;
  sourcePages: number[];
  exactText: string;
  kind: "span" | "number";
  value?: string;
  unit?: string | null;
}

interface HandoffClaim {
  kind: "fact" | "comparison" | "conclusion";
  text: string;
  evidenceIds: string[];
  pages: number[];
  causal: boolean;
}

/** Stage-1 gate: exact-substring containment, no normalization. */
export function validateEvidenceItem(
  item: EvidenceItem,
  chunkText: string,
  chunkIndex: number,
): string[] {
  const reasons: string[] = [];
  if (item.chunkIndex !== chunkIndex) {
    reasons.push("chunkIndex mismatch.");
  }
  if (item.exactText.length === 0 || !chunkText.includes(item.exactText)) {
    reasons.push("exactText must be an exact substring of the source chunk.");
  }
  if (item.kind === "number") {
    if (!item.value || !chunkText.includes(item.value)) {
      reasons.push("value must be an exact substring of the source chunk.");
    } else if (!item.exactText.includes(item.value)) {
      reasons.push("value must appear inside its own exactText.");
    }
  }
  return reasons;
}

/** Stage-2 gate: ID existence + scope + no free-text evidence. */
export function validateHandoffClaim(
  claim: HandoffClaim & { excerpt?: unknown; excerpt2?: unknown },
  store: Map<string, EvidenceItem>,
  chunkIndex: number,
): string[] {
  const reasons: string[] = [];
  if (claim.excerpt !== undefined || claim.excerpt2 !== undefined) {
    reasons.push("Stage 2 must not emit its own excerpts; cite evidenceIds only.");
  }
  if (claim.evidenceIds.length === 0) {
    reasons.push("at least one evidenceId is required.");
  }
  for (const id of claim.evidenceIds) {
    const item = store.get(id);
    if (!item) {
      reasons.push(`unknown evidenceId: ${id}.`);
    } else if (item.chunkIndex !== chunkIndex) {
      reasons.push(`evidenceId ${id} belongs to another chunk.`);
    }
  }
  if (claim.kind === "comparison" && new Set(claim.evidenceIds).size < 2) {
    reasons.push("comparison claims require at least two distinct evidenceIds.");
  }
  if (typeof claim.causal !== "boolean") {
    reasons.push("causal must be a boolean.");
  }
  return reasons;
}

/** Deterministic resolution: IDs → immutable exact texts. */
export function resolveEvidenceTexts(claim: HandoffClaim, store: Map<string, EvidenceItem>): string[] {
  return claim.evidenceIds.map((id) => {
    const item = store.get(id);
    if (!item) {
      throw new Error(`Cannot resolve unknown evidenceId: ${id}.`);
    }
    return item.exactText;
  });
}

const CHUNK_TEXT = "rural literacy is just 61.11% against 82.26% in urban areas (Census 2011).";

function buildStore(): Map<string, EvidenceItem> {
  const items: EvidenceItem[] = [
    {
      evidenceId: "chunk-4-e0",
      chunkIndex: 4,
      sourcePages: [5],
      exactText: "rural literacy is just 61.11% against 82.26% in urban areas",
      kind: "number",
      value: "61.11%",
      unit: "%",
    },
    {
      evidenceId: "chunk-4-e1",
      chunkIndex: 4,
      sourcePages: [5],
      exactText: "rural literacy is just 61.11% against 82.26% in urban areas",
      kind: "number",
      value: "82.26%",
      unit: "%",
    },
  ];
  for (const item of items) {
    expect(validateEvidenceItem(item, CHUNK_TEXT, 4)).toEqual([]);
  }
  return new Map(items.map((item) => [item.evidenceId, item]));
}

describe("t2-04 evidence handoff (offline)", () => {
  it("resolves claim evidenceIds to exact validated text", () => {
    const store = buildStore();
    const claim: HandoffClaim = {
      kind: "comparison",
      text: "Rural literacy is below urban literacy.",
      evidenceIds: ["chunk-4-e0", "chunk-4-e1"],
      pages: [5],
      causal: false,
    };
    expect(validateHandoffClaim(claim, store, 4)).toEqual([]);
    expect(resolveEvidenceTexts(claim, store)).toEqual([
      "rural literacy is just 61.11% against 82.26% in urban areas",
      "rural literacy is just 61.11% against 82.26% in urban areas",
    ]);
  });

  it("rejects a nonexistent evidenceId (fail-closed)", () => {
    const store = buildStore();
    const claim: HandoffClaim = {
      kind: "fact",
      text: "Something.",
      evidenceIds: ["chunk-4-e99"],
      pages: [5],
      causal: false,
    };
    const reasons = validateHandoffClaim(claim, store, 4);
    expect(reasons).toContain("unknown evidenceId: chunk-4-e99.");
    expect(() => resolveEvidenceTexts(claim, store)).toThrow(
      "Cannot resolve unknown evidenceId: chunk-4-e99.",
    );
  });

  it("rejects Stage-2-emitted excerpts and non-verbatim Stage-1 text", () => {
    const store = buildStore();
    const withExcerpt = validateHandoffClaim(
      {
        kind: "fact",
        text: "Something.",
        evidenceIds: ["chunk-4-e0"],
        pages: [5],
        causal: false,
        excerpt: "free text the model copied again",
      },
      store,
      4,
    );
    expect(withExcerpt).toContain("Stage 2 must not emit its own excerpts; cite evidenceIds only.");
    expect(
      validateEvidenceItem(
        {
          evidenceId: "chunk-4-e9",
          chunkIndex: 4,
          sourcePages: [5],
          exactText: "paraphrased literacy gap statement",
          kind: "span",
        },
        CHUNK_TEXT,
        4,
      ),
    ).toContain("exactText must be an exact substring of the source chunk.");
  });
});
