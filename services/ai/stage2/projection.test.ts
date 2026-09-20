import { describe, expect, it } from "vitest";
import type { AiContextChunk } from "../types";
import { EvidenceStore } from "../evidence/store";
import { validateStage2Output } from "./validation";
import { Stage2ProjectionError, projectGroundedClaims } from "./projection";

/**
 * V6-C03 — Unit tests for deterministic grounded result projection.
 *
 * Pure, dependency-free: hand-built `AiContextChunk` fixtures and real
 * `EvidenceStore` instances, with validated claims produced by the real
 * V6-C02 validator. No provider, no network, no PDF fixtures, no UI,
 * no orchestration wiring.
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

/** End-to-end helper: raw model output -> C02 -> C03, proving the layers compose. */
function validateAndProject(output: unknown, store: EvidenceStore, chunks: AiContextChunk[]) {
  const validated = validateStage2Output(output, { scope: store });
  if (validated.outputError !== undefined || validated.rejected.length > 0) {
    throw new Error("Fixture output failed C02 validation.");
  }
  return projectGroundedClaims({ claims: validated.accepted, store, chunks });
}

describe("VALID projection", () => {
  it("1. grounds one valid claim to one evidence item", () => {
    const { grounded } = validateAndProject(
      [{ kind: "fact", text: "Rural literacy trails urban literacy.", evidenceIds: ["chunk-0-e0"] }],
      testStore(),
      testChunks(),
    );
    expect(grounded).toHaveLength(1);
    expect(grounded[0]?.evidence).toHaveLength(1);
    expect(grounded[0]?.evidence[0]?.item.evidenceId).toBe("chunk-0-e0");
  });

  it("2. grounds a conclusion to multiple evidence items", () => {
    const { grounded } = validateAndProject(
      [
        {
          kind: "conclusion",
          text: "The gap is large.",
          evidenceIds: ["chunk-0-e0", "chunk-0-e1", "chunk-1-e0"],
        },
      ],
      testStore(),
      testChunks(),
    );
    expect(grounded[0]?.evidence.map((g) => g.item.evidenceId)).toEqual([
      "chunk-0-e0",
      "chunk-0-e1",
      "chunk-1-e0",
    ]);
  });

  it("3. preserves claim order across multiple claims", () => {
    const { grounded } = validateAndProject(
      [
        { kind: "fact", text: "First.", evidenceIds: ["chunk-1-e1"] },
        { kind: "fact", text: "Second.", evidenceIds: ["chunk-0-e0"] },
      ],
      testStore(),
      testChunks(),
    );
    expect(grounded.map((g) => g.text)).toEqual(["First.", "Second."]);
  });

  it("4. preserves evidence order within a claim", () => {
    const { grounded } = validateAndProject(
      [{ kind: "fact", text: "T.", evidenceIds: ["chunk-1-e1", "chunk-0-e0", "chunk-1-e0"] }],
      testStore(),
      testChunks(),
    );
    expect(grounded[0]?.evidence.map((g) => g.item.evidenceId)).toEqual([
      "chunk-1-e1",
      "chunk-0-e0",
      "chunk-1-e0",
    ]);
  });

  it("5. preserves duplicate evidence references", () => {
    const { grounded } = validateAndProject(
      [{ kind: "fact", text: "T.", evidenceIds: ["chunk-0-e0", "chunk-0-e0"] }],
      testStore(),
      testChunks(),
    );
    expect(grounded[0]?.evidence.map((g) => g.item.evidenceId)).toEqual([
      "chunk-0-e0",
      "chunk-0-e0",
    ]);
  });

  it("6. returns evidence from the store, not claim-authored text", () => {
    const store = testStore();
    const { grounded } = validateAndProject(
      [{ kind: "fact", text: "Model restatement here.", evidenceIds: ["chunk-0-e0"] }],
      store,
      testChunks(),
    );
    // Identity with the frozen stored item: the store object itself.
    expect(grounded[0]?.evidence[0]?.item).toBe(store.resolve("chunk-0-e0"));
  });

  it("7. obtains the source chunk through B05 grounding", () => {
    const chunks = testChunks();
    const { grounded } = validateAndProject(
      [{ kind: "fact", text: "T.", evidenceIds: ["chunk-1-e0"] }],
      testStore(),
      chunks,
    );
    expect(grounded[0]?.evidence[0]?.chunk.chunkIndex).toBe(1);
    expect(grounded[0]?.evidence[0]?.chunk.text).toBe(chunks[1]?.text);
  });
});

describe("INTEGRITY of grounded evidence", () => {
  it("8. evidence exactText is the store value", () => {
    const { grounded } = validateAndProject(
      [{ kind: "fact", text: "T.", evidenceIds: ["chunk-0-e0"] }],
      testStore(),
      testChunks(),
    );
    expect(grounded[0]?.evidence[0]?.item.exactText).toBe("rural literacy is just 61.11%");
  });

  it("9. evidence kind/value are store-authoritative", () => {
    const { grounded } = validateAndProject(
      [{ kind: "fact", text: "T.", evidenceIds: ["chunk-0-e0"] }],
      testStore(),
      testChunks(),
    );
    expect(grounded[0]?.evidence[0]?.item.kind).toBe("number");
    expect(grounded[0]?.evidence[0]?.item.value).toBe("61.11%");
  });

  it("10. source pages come from the store item", () => {
    const { grounded } = validateAndProject(
      [{ kind: "fact", text: "T.", evidenceIds: ["chunk-1-e0"] }],
      testStore(),
      testChunks(),
    );
    expect(grounded[0]?.evidence[0]?.item.sourcePages).toEqual([2]);
  });

  it("11. the model claim carries no source-evidence field", () => {
    const { grounded } = validateAndProject(
      [{ kind: "fact", text: "T.", evidenceIds: ["chunk-0-e0"] }],
      testStore(),
      testChunks(),
    );
    const claim = grounded[0] as unknown as Record<string, unknown>;
    expect("exactText" in claim).toBe(false);
    expect("excerpt" in claim).toBe(false);
    expect("value" in claim).toBe(false);
    expect("item" in claim).toBe(false);
  });

  it("12. model claim text remains only the restatement", () => {
    const { grounded } = validateAndProject(
      [{ kind: "fact", text: "My restatement.", evidenceIds: ["chunk-0-e0"] }],
      testStore(),
      testChunks(),
    );
    expect(grounded[0]?.text).toBe("My restatement.");
    expect(grounded[0]?.evidence[0]?.item.exactText).not.toBe("My restatement.");
  });
});

describe("FAILURE behavior", () => {
  it("13. missing ID during projection throws without fallback", () => {
    expect(() =>
      projectGroundedClaims({
        claims: [{ kind: "fact", text: "T.", evidenceIds: ["chunk-0-e9"] }],
        store: testStore(),
        chunks: testChunks(),
      }),
    ).toThrow(Stage2ProjectionError);
  });

  it("14. malformed ID during projection throws without fallback", () => {
    expect(() =>
      projectGroundedClaims({
        claims: [{ kind: "fact", text: "T.", evidenceIds: ["bogus"] }],
        store: testStore(),
        chunks: testChunks(),
      }),
    ).toThrow(Stage2ProjectionError);
  });

  it("15. missing owning chunk throws", () => {
    const partialChunks = [testChunks()[0] as AiContextChunk];
    expect(() =>
      projectGroundedClaims({
        claims: [{ kind: "fact", text: "T.", evidenceIds: ["chunk-1-e0"] }],
        store: testStore(),
        chunks: partialChunks,
      }),
    ).toThrow(Stage2ProjectionError);
  });

  it("16. broken exactText containment throws", () => {
    const tampered = [
      makeChunk(0, 1, "completely different text with no overlap"),
      makeChunk(1, 2, "survey covered 6 districts with 150 households interviewed"),
    ];
    expect(() =>
      projectGroundedClaims({
        claims: [{ kind: "fact", text: "T.", evidenceIds: ["chunk-0-e0"] }],
        store: testStore(),
        chunks: tampered,
      }),
    ).toThrow(Stage2ProjectionError);
  });

  it("17. inconsistent store/chunk state throws", () => {
    const mismatched = [makeChunk(0, 1, "rural literacy is just 61.11% against 82.26% in urban areas")];
    expect(() =>
      projectGroundedClaims({
        claims: [{ kind: "fact", text: "T.", evidenceIds: ["chunk-1-e0"] }],
        store: testStore(),
        chunks: mismatched,
      }),
    ).toThrow(Stage2ProjectionError);
  });

  it("18. wrong store/scope throws", () => {
    const otherChunks = [makeChunk(0, 1, "unrelated alpha content here")];
    const other = EvidenceStore.create({ chunks: otherChunks, sourcePageCount: 1 });
    other.admit(0, ["alpha content"]);
    expect(() =>
      projectGroundedClaims({
        claims: [{ kind: "fact", text: "T.", evidenceIds: ["chunk-0-e0"] }],
        store: other,
        chunks: testChunks(),
      }),
    ).toThrow(Stage2ProjectionError);
  });

  it("19. empty claim collection projects to an empty collection", () => {
    const result = projectGroundedClaims({ claims: [], store: testStore(), chunks: testChunks() });
    expect(result.grounded).toEqual([]);
  });

  it("20. a claim with duplicated IDs stays duplicated after grounding", () => {
    const result = projectGroundedClaims({
      claims: [{ kind: "fact", text: "T.", evidenceIds: ["chunk-1-e1", "chunk-1-e1"] }],
      store: testStore(),
      chunks: testChunks(),
    });
    expect(result.grounded[0]?.evidence).toHaveLength(2);
    expect(result.grounded[0]?.evidence[0]?.item).toBe(result.grounded[0]?.evidence[1]?.item);
  });

  it("rejects malformed caller envelopes fail-loud", () => {
    expect(() => projectGroundedClaims(null)).toThrow(Stage2ProjectionError);
    expect(() =>
      projectGroundedClaims({ claims: [], store: {}, chunks: testChunks() }),
    ).toThrow(Stage2ProjectionError);
    expect(() =>
      projectGroundedClaims({ claims: {}, store: testStore(), chunks: testChunks() }),
    ).toThrow(Stage2ProjectionError);
    expect(() =>
      projectGroundedClaims({ claims: [], store: testStore(), chunks: [] }),
    ).toThrow(Stage2ProjectionError);
  });
});

describe("NO FALLBACK", () => {
  it("21. missing evidence never becomes model-text evidence", () => {
    let result: unknown = null;
    try {
      result = projectGroundedClaims({
        claims: [{ kind: "fact", text: "Model text.", evidenceIds: ["chunk-0-e9"] }],
        store: testStore(),
        chunks: testChunks(),
      });
    } catch (error) {
      expect(error).toBeInstanceOf(Stage2ProjectionError);
    }
    expect(result).toBeNull();
  });

  it("22. broken grounding never creates synthetic evidence", () => {
    const tampered = [makeChunk(0, 1, "nothing overlapping here")];
    expect(() =>
      projectGroundedClaims({
        claims: [{ kind: "fact", text: "T.", evidenceIds: ["chunk-0-e0"] }],
        store: testStore(),
        chunks: tampered,
      }),
    ).toThrow(Stage2ProjectionError);
  });

  it("23. no raw source text is reconstructed from claim text", () => {
    const store = testStore();
    const { grounded } = validateAndProject(
      [{ kind: "fact", text: "rural literacy is just 61.11%", evidenceIds: ["chunk-0-e0"] }],
      store,
      testChunks(),
    );
    // Even when the restatement happens to match, the evidence object
    // is still the frozen store item — never a copy built from the text.
    expect(grounded[0]?.evidence[0]?.item).toBe(store.resolve("chunk-0-e0"));
    expect(grounded[0]?.text).toBe("rural literacy is just 61.11%");
  });
});

describe("IMMUTABILITY", () => {
  it("24. output is frozen/readonly", () => {
    const { grounded } = validateAndProject(
      [{ kind: "fact", text: "T.", evidenceIds: ["chunk-0-e0"] }],
      testStore(),
      testChunks(),
    );
    expect(Object.isFrozen(grounded)).toBe(true);
    expect(Object.isFrozen(grounded[0])).toBe(true);
  });

  it("25. nested evidence structures are frozen/readonly", () => {
    const { grounded } = validateAndProject(
      [{ kind: "fact", text: "T.", evidenceIds: ["chunk-0-e0"] }],
      testStore(),
      testChunks(),
    );
    expect(Object.isFrozen(grounded[0]?.evidence)).toBe(true);
    expect(Object.isFrozen(grounded[0]?.evidenceIds)).toBe(true);
  });

  it("26. input claim is unchanged", () => {
    const claims = [{ kind: "fact", text: "Stable.", evidenceIds: ["chunk-0-e0"] }];
    const before = JSON.stringify(claims);
    projectGroundedClaims({ claims, store: testStore(), chunks: testChunks() });
    expect(JSON.stringify(claims)).toBe(before);
  });

  it("27. store is unchanged", () => {
    const store = testStore();
    const before = JSON.stringify(store.snapshot());
    projectGroundedClaims({
      claims: [{ kind: "fact", text: "T.", evidenceIds: ["chunk-0-e0"] }],
      store,
      chunks: testChunks(),
    });
    expect(JSON.stringify(store.snapshot())).toBe(before);
    expect(store.size).toBe(4);
  });

  it("28. chunk context is unchanged", () => {
    const chunks = testChunks();
    const before = JSON.stringify(chunks);
    projectGroundedClaims({
      claims: [{ kind: "fact", text: "T.", evidenceIds: ["chunk-0-e0"] }],
      store: testStore(),
      chunks,
    });
    expect(JSON.stringify(chunks)).toBe(before);
  });
});

describe("SECURITY boundary", () => {
  it.each([
    ["29. File-like field", { file: { name: "x.pdf" } }],
    ["30. Blob-like field", { blob: { size: 1 } }],
    ["31. ArrayBuffer-like field", { arrayBuffer: [0, 1] }],
    ["32. metadata-like field", { metadata: { author: "x" } }],
  ])("%s is rejected and never propagated", (_label, extra) => {
    expect(() =>
      projectGroundedClaims({
        claims: [{ kind: "fact", text: "T.", evidenceIds: ["chunk-0-e0"], ...extra }],
        store: testStore(),
        chunks: testChunks(),
      }),
    ).toThrow(Stage2ProjectionError);
  });
});
