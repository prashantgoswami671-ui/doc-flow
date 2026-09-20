import { describe, expect, it } from "vitest";
import type { AiContextChunk } from "../types";
import { EvidenceStore } from "../evidence/store";
import {
  MAX_STAGE2_CLAIM_TEXT_CHARACTERS,
  MAX_STAGE2_EVIDENCE_IDS_PER_CLAIM,
  Stage2ValidationError,
  validateStage2Output,
} from "./validation";

/**
 * V6-C02 — Unit tests for the deterministic Stage-2 output validator.
 *
 * Pure, dependency-free: hand-built `AiContextChunk` fixtures and real
 * `EvidenceStore` instances. No provider, no network, no PDF fixtures,
 * no Ollama/Browser AI, no orchestration wiring.
 */

function makeChunk(chunkIndex: number, pageNumber: number, text: string): AiContextChunk {
  return { chunkIndex, pageNumber, text, startOffset: 0, endOffset: text.length };
}

function testChunks(): AiContextChunk[] {
  return [
    makeChunk(0, 1, "rural literacy is just 61.11% against 82.26% in urban areas"),
    makeChunk(1, 2, "survey covered 6 districts with 150 households interviewed"),
  ];
}

function testStore(): EvidenceStore {
  const store = EvidenceStore.create({ chunks: testChunks(), sourcePageCount: 2 });
  store.admit(0, ["rural literacy is just 61.11%", "82.26%"]);
  store.admit(1, ["6 districts", "150 households"]);
  return store;
}

function otherStore(): EvidenceStore {
  const chunks = [makeChunk(0, 1, "unrelated alpha content here")];
  const store = EvidenceStore.create({ chunks, sourcePageCount: 1 });
  store.admit(0, ["alpha content"]);
  return store;
}

function snapshotOf(store: EvidenceStore): string {
  return JSON.stringify(store.snapshot());
}

describe("VALID claims", () => {
  it("1. accepts one valid fact claim with one valid evidence ID", () => {
    const result = validateStage2Output(
      [{ kind: "fact", text: "Rural literacy trails urban literacy.", evidenceIds: ["chunk-0-e0"] }],
      { scope: testStore() },
    );
    expect(result.outputError).toBeUndefined();
    expect(result.rejected).toEqual([]);
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0]).toEqual({
      kind: "fact",
      text: "Rural literacy trails urban literacy.",
      evidenceIds: ["chunk-0-e0"],
    });
  });

  it("2. accepts one valid conclusion claim with multiple valid evidence IDs", () => {
    const result = validateStage2Output(
      [
        {
          kind: "conclusion",
          text: "The gap is large.",
          evidenceIds: ["chunk-0-e0", "chunk-0-e1", "chunk-1-e0"],
        },
      ],
      { scope: testStore() },
    );
    expect(result.rejected).toEqual([]);
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0]?.evidenceIds).toEqual(["chunk-0-e0", "chunk-0-e1", "chunk-1-e0"]);
  });

  it("3. accepts multiple valid claims", () => {
    const result = validateStage2Output(
      [
        { kind: "fact", text: "First.", evidenceIds: ["chunk-0-e0"] },
        { kind: "conclusion", text: "Second.", evidenceIds: ["chunk-1-e0"] },
      ],
      { scope: testStore() },
    );
    expect(result.rejected).toEqual([]);
    expect(result.accepted).toHaveLength(2);
  });

  it("4. preserves duplicate evidence ID references without deduplicating", () => {
    const result = validateStage2Output(
      [{ kind: "fact", text: "Dup.", evidenceIds: ["chunk-0-e0", "chunk-0-e0"] }],
      { scope: testStore() },
    );
    expect(result.rejected).toEqual([]);
    expect(result.accepted[0]?.evidenceIds).toEqual(["chunk-0-e0", "chunk-0-e0"]);
  });

  it("5. keeps independently valid siblings when another claim is rejected", () => {
    const result = validateStage2Output(
      [
        { kind: "fact", text: "Good.", evidenceIds: ["chunk-0-e0"] },
        { kind: "bogus", text: "Bad.", evidenceIds: ["chunk-0-e0"] },
        { kind: "conclusion", text: "Also good.", evidenceIds: ["chunk-1-e1"] },
      ],
      { scope: testStore() },
    );
    expect(result.accepted.map((c) => c.text)).toEqual(["Good.", "Also good."]);
    expect(result.rejected).toEqual([{ index: 1, reason: "invalid-kind" }]);
  });

  it("accepts a JSON-string envelope carrying a valid claim array", () => {
    const raw = JSON.stringify([
      { kind: "fact", text: "Via string.", evidenceIds: ["chunk-0-e1"] },
    ]);
    const result = validateStage2Output(raw, { scope: testStore() });
    expect(result.outputError).toBeUndefined();
    expect(result.accepted).toHaveLength(1);
  });

  it("accepts a snapshot-array scope as well as a store scope", () => {
    const store = testStore();
    const result = validateStage2Output(
      [{ kind: "fact", text: "Scoped.", evidenceIds: ["chunk-1-e1"] }],
      { scope: store.snapshot() },
    );
    expect(result.rejected).toEqual([]);
    expect(result.accepted).toHaveLength(1);
  });
});

describe("INVALID top-level", () => {
  it("6. rejects malformed JSON with outputError", () => {
    const result = validateStage2Output("{not json", { scope: testStore() });
    expect(result.outputError).toBe("malformed-output");
    expect(result.accepted).toEqual([]);
    expect(result.rejected).toEqual([]);
  });

  it("7. rejects null with outputError", () => {
    const result = validateStage2Output(null, { scope: testStore() });
    expect(result.outputError).toBe("malformed-output");
    expect(result.accepted).toEqual([]);
  });

  it("8. rejects primitives with outputError", () => {
    for (const primitive of [42, "hello", true]) {
      const result = validateStage2Output(primitive, { scope: testStore() });
      expect(result.outputError).toBe("malformed-output");
    }
  });

  it("9. rejects an object instead of a claim array with outputError", () => {
    const result = validateStage2Output(
      { kind: "fact", text: "Wrapped.", evidenceIds: ["chunk-0-e0"] },
      { scope: testStore() },
    );
    expect(result.outputError).toBe("malformed-output");
    expect(result.accepted).toEqual([]);
  });

  it("10. treats an empty array as deterministically valid with zero claims", () => {
    const result = validateStage2Output([], { scope: testStore() });
    expect(result.outputError).toBeUndefined();
    expect(result.accepted).toEqual([]);
    expect(result.rejected).toEqual([]);
  });

  it("throws Stage2ValidationError for malformed caller envelopes, not model data", () => {
    expect(() => validateStage2Output([], null)).toThrow(Stage2ValidationError);
    expect(() => validateStage2Output([], { scope: "chunk-0-e0" })).toThrow(
      Stage2ValidationError,
    );
    expect(() =>
      validateStage2Output([], { scope: [{ evidenceId: "nope" }] }),
    ).toThrow(Stage2ValidationError);
  });
});

describe("INVALID claim shapes", () => {
  it("11. rejects a null claim entry", () => {
    const result = validateStage2Output([null], { scope: testStore() });
    expect(result.accepted).toEqual([]);
    expect(result.rejected).toEqual([{ index: 0, reason: "malformed-claim" }]);
  });

  it("12. rejects an array claim entry", () => {
    const result = validateStage2Output([[1, 2]], { scope: testStore() });
    expect(result.rejected).toEqual([{ index: 0, reason: "malformed-claim" }]);
  });

  it("13. rejects a claim missing kind", () => {
    const result = validateStage2Output(
      [{ text: "No kind.", evidenceIds: ["chunk-0-e0"] }],
      { scope: testStore() },
    );
    expect(result.accepted).toEqual([]);
    expect(result.rejected).toHaveLength(1);
  });

  it("14. rejects a claim missing text", () => {
    const result = validateStage2Output(
      [{ kind: "fact", evidenceIds: ["chunk-0-e0"] }],
      { scope: testStore() },
    );
    expect(result.accepted).toEqual([]);
    expect(result.rejected).toHaveLength(1);
  });

  it("15. rejects a claim missing evidenceIds", () => {
    const result = validateStage2Output(
      [{ kind: "fact", text: "No ids." }],
      { scope: testStore() },
    );
    expect(result.accepted).toEqual([]);
    expect(result.rejected).toHaveLength(1);
  });

  it("16. rejects a claim with an extra unknown field", () => {
    const result = validateStage2Output(
      [{ kind: "fact", text: "Extra.", evidenceIds: ["chunk-0-e0"], note: "hi" }],
      { scope: testStore() },
    );
    expect(result.rejected).toEqual([{ index: 0, reason: "unknown-field" }]);
  });

  it("17. rejects claims carrying each forbidden source field", () => {
    const forbidden: Record<string, unknown>[] = [
      { exactText: "rural literacy is just 61.11%" },
      { excerpt: "rural literacy is just 61.11%" },
      { excerpt2: "82.26%" },
      { causalExcerpt: "because of x" },
      { value: "61.11%" },
      { unit: "%" },
      { pages: [1] },
      { sourcePages: [1] },
      { chunkIndex: 0 },
      { evidenceId: "chunk-0-e0" },
      { causal: false },
      { causalEvidenceId: "chunk-0-e0" },
    ];
    for (const extra of forbidden) {
      const result = validateStage2Output(
        [{ kind: "fact", text: "T.", evidenceIds: ["chunk-0-e0"], ...extra }],
        { scope: testStore() },
      );
      expect(result.accepted).toEqual([]);
      expect(result.rejected).toEqual([{ index: 0, reason: "unknown-field" }]);
    }
  });

  it("18. rejects singular evidenceId instead of evidenceIds", () => {
    const result = validateStage2Output(
      [{ kind: "fact", text: "Singular.", evidenceId: "chunk-0-e0" }],
      { scope: testStore() },
    );
    expect(result.accepted).toEqual([]);
    expect(result.rejected).toHaveLength(1);
  });
});

describe("INVALID kind", () => {
  it("19. rejects an arbitrary kind string", () => {
    const result = validateStage2Output(
      [{ kind: "comparison", text: "T.", evidenceIds: ["chunk-0-e0"] }],
      { scope: testStore() },
    );
    expect(result.rejected).toEqual([{ index: 0, reason: "invalid-kind" }]);
  });

  it("20. rejects missing/undefined kind", () => {
    const result = validateStage2Output(
      [{ kind: undefined, text: "T.", evidenceIds: ["chunk-0-e0"] }],
      { scope: testStore() },
    );
    expect(result.rejected).toEqual([{ index: 0, reason: "invalid-kind" }]);
  });

  it("21. rejects a wrong-typed kind", () => {
    const result = validateStage2Output(
      [{ kind: 42, text: "T.", evidenceIds: ["chunk-0-e0"] }],
      { scope: testStore() },
    );
    expect(result.rejected).toEqual([{ index: 0, reason: "invalid-kind" }]);
  });
});

describe("INVALID text", () => {
  it("22. rejects empty string text", () => {
    const result = validateStage2Output(
      [{ kind: "fact", text: "", evidenceIds: ["chunk-0-e0"] }],
      { scope: testStore() },
    );
    expect(result.rejected).toEqual([{ index: 0, reason: "empty-claim-text" }]);
  });

  it("23. rejects whitespace-only text", () => {
    const result = validateStage2Output(
      [{ kind: "fact", text: "   \n\t  ", evidenceIds: ["chunk-0-e0"] }],
      { scope: testStore() },
    );
    expect(result.rejected).toEqual([{ index: 0, reason: "empty-claim-text" }]);
  });

  it("24. rejects non-string text", () => {
    const result = validateStage2Output(
      [{ kind: "fact", text: 42, evidenceIds: ["chunk-0-e0"] }],
      { scope: testStore() },
    );
    expect(result.rejected).toEqual([{ index: 0, reason: "invalid-claim-text" }]);
  });

  it("25. accepts exactly-at-boundary text length", () => {
    const text = "a".repeat(MAX_STAGE2_CLAIM_TEXT_CHARACTERS);
    const result = validateStage2Output(
      [{ kind: "fact", text, evidenceIds: ["chunk-0-e0"] }],
      { scope: testStore() },
    );
    expect(result.rejected).toEqual([]);
    expect(result.accepted).toHaveLength(1);
  });

  it("26. rejects over-bound text length without truncating", () => {
    const text = "a".repeat(MAX_STAGE2_CLAIM_TEXT_CHARACTERS + 1);
    const result = validateStage2Output(
      [{ kind: "fact", text, evidenceIds: ["chunk-0-e0"] }],
      { scope: testStore() },
    );
    expect(result.accepted).toEqual([]);
    expect(result.rejected).toEqual([{ index: 0, reason: "claim-text-too-long" }]);
  });
});

describe("INVALID evidenceIds", () => {
  it("27. rejects an empty evidenceIds array", () => {
    const result = validateStage2Output(
      [{ kind: "fact", text: "T.", evidenceIds: [] }],
      { scope: testStore() },
    );
    expect(result.rejected).toEqual([{ index: 0, reason: "empty-evidenceIds" }]);
  });

  it("28. rejects a non-array evidenceIds", () => {
    const result = validateStage2Output(
      [{ kind: "fact", text: "T.", evidenceIds: "chunk-0-e0" }],
      { scope: testStore() },
    );
    expect(result.rejected).toEqual([{ index: 0, reason: "invalid-evidenceIds" }]);
  });

  it("29. rejects a non-string entry", () => {
    const result = validateStage2Output(
      [{ kind: "fact", text: "T.", evidenceIds: [42] }],
      { scope: testStore() },
    );
    expect(result.rejected).toEqual([{ index: 0, reason: "malformed-evidence-id" }]);
  });

  it("30. rejects a malformed ID", () => {
    const result = validateStage2Output(
      [{ kind: "fact", text: "T.", evidenceIds: ["not-an-id"] }],
      { scope: testStore() },
    );
    expect(result.rejected).toEqual([{ index: 0, reason: "malformed-evidence-id" }]);
  });

  it("31. rejects a syntactically valid but missing ID", () => {
    const result = validateStage2Output(
      [{ kind: "fact", text: "T.", evidenceIds: ["chunk-0-e9"] }],
      { scope: testStore() },
    );
    expect(result.rejected).toEqual([{ index: 0, reason: "unknown-evidence-id" }]);
  });

  it("32. rejects a claim mixing valid and invalid IDs as a whole", () => {
    const result = validateStage2Output(
      [{ kind: "fact", text: "T.", evidenceIds: ["chunk-0-e0", "bogus"] }],
      { scope: testStore() },
    );
    expect(result.accepted).toEqual([]);
    expect(result.rejected).toEqual([{ index: 0, reason: "malformed-evidence-id" }]);
  });

  it("33. rejects too many evidence IDs", () => {
    const ids = new Array(MAX_STAGE2_EVIDENCE_IDS_PER_CLAIM + 1).fill("chunk-0-e0");
    const result = validateStage2Output(
      [{ kind: "fact", text: "T.", evidenceIds: ids }],
      { scope: testStore() },
    );
    expect(result.rejected).toEqual([{ index: 0, reason: "evidenceIds-too-many" }]);
  });
});

describe("FORBIDDEN capabilities", () => {
  it.each([
    ["34. excerpt", { excerpt: "rural literacy is just 61.11%" }],
    ["35. exactText", { exactText: "rural literacy is just 61.11%" }],
    ["36a. pages", { pages: [1] }],
    ["36b. sourcePages", { sourcePages: [1] }],
    ["37. chunkIndex", { chunkIndex: 0 }],
    ["38a. value", { value: "61.11%" }],
    ["38b. unit", { unit: "%" }],
    ["39a. causal", { causal: true }],
    ["39b. causalEvidenceId", { causalEvidenceId: "chunk-0-e0" }],
    ["40. comparison field", { comparisonBasis: "gap" }],
    ["41. attribution field", { attribution: "World Bank" }],
  ])("%s is rejected, not stripped", (_label, extra) => {
    const result = validateStage2Output(
      [{ kind: "fact", text: "T.", evidenceIds: ["chunk-0-e0"], ...extra }],
      { scope: testStore() },
    );
    expect(result.accepted).toEqual([]);
    expect(result.rejected).toEqual([{ index: 0, reason: "unknown-field" }]);
  });

  it("42. rejects multiple forbidden fields simultaneously", () => {
    const result = validateStage2Output(
      [
        {
          kind: "fact",
          text: "T.",
          evidenceIds: ["chunk-0-e0"],
          exactText: "rural literacy is just 61.11%",
          pages: [1],
          causal: false,
        },
      ],
      { scope: testStore() },
    );
    expect(result.accepted).toEqual([]);
    expect(result.rejected).toEqual([{ index: 0, reason: "unknown-field" }]);
  });
});

describe("SECURITY / INTEGRITY", () => {
  it("43. rejects a File-like object injection field", () => {
    const result = validateStage2Output(
      [{ kind: "fact", text: "T.", evidenceIds: ["chunk-0-e0"], file: { name: "x.pdf" } }],
      { scope: testStore() },
    );
    expect(result.rejected).toEqual([{ index: 0, reason: "unknown-field" }]);
  });

  it("44. rejects a Blob-like field", () => {
    const result = validateStage2Output(
      [{ kind: "fact", text: "T.", evidenceIds: ["chunk-0-e0"], blob: { size: 1 } }],
      { scope: testStore() },
    );
    expect(result.rejected).toEqual([{ index: 0, reason: "unknown-field" }]);
  });

  it("45. rejects an ArrayBuffer-like field", () => {
    const result = validateStage2Output(
      [{ kind: "fact", text: "T.", evidenceIds: ["chunk-0-e0"], arrayBuffer: [0, 1] }],
      { scope: testStore() },
    );
    expect(result.rejected).toEqual([{ index: 0, reason: "unknown-field" }]);
  });

  it("46. rejects a metadata field", () => {
    const result = validateStage2Output(
      [{ kind: "fact", text: "T.", evidenceIds: ["chunk-0-e0"], metadata: { a: 1 } }],
      { scope: testStore() },
    );
    expect(result.rejected).toEqual([{ index: 0, reason: "unknown-field" }]);
  });

  it("47. rejects a raw PDF-like field", () => {
    const result = validateStage2Output(
      [{ kind: "fact", text: "T.", evidenceIds: ["chunk-0-e0"], fileBytes: "JVBERi0" }],
      { scope: testStore() },
    );
    expect(result.rejected).toEqual([{ index: 0, reason: "unknown-field" }]);
  });

  it("48. does not mutate the input object", () => {
    const input = [
      { kind: "fact", text: "Stable.", evidenceIds: ["chunk-0-e0"] },
      { kind: "bogus", text: "Bad.", evidenceIds: ["chunk-0-e0"] },
    ];
    const before = JSON.stringify(input);
    validateStage2Output(input, { scope: testStore() });
    expect(JSON.stringify(input)).toBe(before);
  });

  it("49. does not mutate the store snapshot", () => {
    const store = testStore();
    const before = snapshotOf(store);
    validateStage2Output(
      [{ kind: "fact", text: "T.", evidenceIds: ["chunk-0-e0"] }],
      { scope: store },
    );
    validateStage2Output(
      [{ kind: "fact", text: "T.", evidenceIds: ["chunk-9-e9"] }],
      { scope: store },
    );
    expect(snapshotOf(store)).toBe(before);
    expect(store.size).toBe(4);
  });

  it("50. returns frozen/readonly accepted and rejected structures", () => {
    const result = validateStage2Output(
      [
        { kind: "fact", text: "Frozen.", evidenceIds: ["chunk-0-e0"] },
        { kind: "bogus", text: "Bad.", evidenceIds: ["chunk-0-e0"] },
      ],
      { scope: testStore() },
    );
    expect(Object.isFrozen(result.accepted)).toBe(true);
    expect(Object.isFrozen(result.rejected)).toBe(true);
    expect(Object.isFrozen(result.accepted[0])).toBe(true);
    expect(Object.isFrozen(result.accepted[0]?.evidenceIds)).toBe(true);
    expect(Object.isFrozen(result.rejected[0])).toBe(true);
  });
});

describe("SCOPE isolation", () => {
  it("51. passes a valid ID from the correct store", () => {
    const result = validateStage2Output(
      [{ kind: "fact", text: "T.", evidenceIds: ["chunk-0-e0"] }],
      { scope: testStore() },
    );
    expect(result.accepted).toHaveLength(1);
  });

  it("52. fails a syntactically valid ID from another store/request", () => {
    const other = otherStore();
    const otherId = other.snapshot()[0]?.evidenceId ?? "chunk-0-e0";
    // Same ID string exists in both stores here; use an ID unique to the other scope
    // by validating the main store's unknown-but-valid ID against the other store.
    const cross = validateStage2Output(
      [{ kind: "fact", text: "T.", evidenceIds: ["chunk-1-e0"] }],
      { scope: other },
    );
    expect(cross.rejected).toEqual([{ index: 0, reason: "unknown-evidence-id" }]);
    // And the reverse direction: the other store's item is unknown to a scope
    // that does not contain it (empty scope).
    const emptyScope = validateStage2Output(
      [{ kind: "fact", text: "T.", evidenceIds: [otherId] }],
      { scope: [] },
    );
    expect(emptyScope.rejected).toEqual([{ index: 0, reason: "unknown-evidence-id" }]);
  });
});

describe("NO REPAIR", () => {
  it("53. rejects a whitespace-padded ID instead of normalizing it", () => {
    const result = validateStage2Output(
      [{ kind: "fact", text: "T.", evidenceIds: [" chunk-0-e0"] }],
      { scope: testStore() },
    );
    expect(result.rejected).toEqual([{ index: 0, reason: "malformed-evidence-id" }]);
  });

  it("54. rejects a case-modified ID", () => {
    const result = validateStage2Output(
      [{ kind: "fact", text: "T.", evidenceIds: ["CHUNK-0-E0"] }],
      { scope: testStore() },
    );
    expect(result.rejected).toEqual([{ index: 0, reason: "malformed-evidence-id" }]);
  });

  it("55. rejects a near-match ID", () => {
    const result = validateStage2Output(
      [{ kind: "fact", text: "T.", evidenceIds: ["chunk-0-e00"] }],
      { scope: testStore() },
    );
    expect(result.rejected).toEqual([{ index: 0, reason: "unknown-evidence-id" }]);
  });

  it("56. rejects a forbidden field instead of removing it", () => {
    const input = [{ kind: "fact", text: "T.", evidenceIds: ["chunk-0-e0"], unit: "%" }];
    const result = validateStage2Output(input, { scope: testStore() });
    expect(result.accepted).toEqual([]);
    expect(result.rejected).toEqual([{ index: 0, reason: "unknown-field" }]);
    // The validator must not have stripped the field to "fix" the claim.
    expect("unit" in (input[0] as Record<string, unknown>)).toBe(true);
  });
});
