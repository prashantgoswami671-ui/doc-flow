import { describe, expect, it } from "vitest";
import type { AiContextChunk } from "../types";
import {
  resolveEvidenceIds,
  resolveEvidenceItemToChunk,
  resolveGroundedEvidence,
  EvidenceResolutionError,
} from "./resolution";
import { EvidenceStore } from "./store";

/**
 * V6-B05 — Unit tests for deterministic evidence-resolution helpers.
 *
 * Pure, dependency-free: hand-built `AiContextChunk` fixtures and a
 * real `EvidenceStore`, no Ollama, no Browser AI, no network, no PDF
 * fixtures, no benchmark artifacts. No Stage-2 claim contract is
 * exercised — none exists yet by design.
 */

function makeChunk(chunkIndex: number, pageNumber: number, text: string): AiContextChunk {
  return { chunkIndex, pageNumber, text, startOffset: 0, endOffset: text.length };
}

function testChunks(): AiContextChunk[] {
  return [
    makeChunk(0, 1, "rural literacy is just 61.11% against 82.26% in urban areas"),
    makeChunk(1, 2, "see Fig. 2 for 2024 estimates across 6 districts"),
  ];
}

function testStore(): EvidenceStore {
  const store = EvidenceStore.create({ chunks: testChunks(), sourcePageCount: 2 });
  store.admit(0, ["rural literacy is just 61.11%", "82.26%"]);
  store.admit(1, ["6 districts"]);
  return store;
}

describe("resolveEvidenceIds", () => {
  it("resolves IDs to frozen items in requested order", () => {
    const result = resolveEvidenceIds({
      store: testStore(),
      evidenceIds: ["chunk-1-e0", "chunk-0-e0"],
    });

    expect(result.missing).toEqual([]);
    expect(result.invalid).toEqual([]);
    expect(result.items.map((item) => item.evidenceId)).toEqual(["chunk-1-e0", "chunk-0-e0"]);
    expect(result.items[0]?.exactText).toBe("6 districts");
    expect(Object.isFrozen(result.items)).toBe(true);
  });

  it("preserves duplicate references positionally", () => {
    const result = resolveEvidenceIds({
      store: testStore(),
      evidenceIds: ["chunk-0-e0", "chunk-0-e0"],
    });

    expect(result.items.map((item) => item.evidenceId)).toEqual(["chunk-0-e0", "chunk-0-e0"]);
  });

  it("reports unknown IDs without throwing", () => {
    const result = resolveEvidenceIds({
      store: testStore(),
      evidenceIds: ["chunk-0-e0", "chunk-0-e9", "chunk-9-e0"],
    });

    expect(result.items.map((item) => item.evidenceId)).toEqual(["chunk-0-e0"]);
    expect(result.missing).toEqual(["chunk-0-e0".replace("e0", "e9"), "chunk-9-e0"]);
    expect(result.invalid).toEqual([]);
  });

  it("reports malformed entries by index without throwing", () => {
    const result = resolveEvidenceIds({
      store: testStore(),
      evidenceIds: ["chunk-0-e0", "nope", 42, null],
    });

    expect(result.items.map((item) => item.evidenceId)).toEqual(["chunk-0-e0"]);
    expect(result.missing).toEqual([]);
    expect(result.invalid).toEqual([1, 2, 3]);
  });

  it("accepts an empty ID list as an empty result", () => {
    expect(resolveEvidenceIds({ store: testStore(), evidenceIds: [] })).toEqual({
      items: [],
      missing: [],
      invalid: [],
    });
  });

  it.each([null, undefined, "chunk-0-e0", 42])("rejects non-object options %s", (options) => {
    expect(() => resolveEvidenceIds(options)).toThrow(EvidenceResolutionError);
  });

  it("rejects a non-store and a non-array ID list fail-loud", () => {
    expect(() =>
      resolveEvidenceIds({ store: { resolve: () => undefined }, evidenceIds: [] }),
    ).toThrow(EvidenceResolutionError);
    expect(() =>
      resolveEvidenceIds({ store: testStore(), evidenceIds: "chunk-0-e0" }),
    ).toThrow(EvidenceResolutionError);
  });

  it("never fuzzy-matches: near-miss IDs are missing, not repaired", () => {
    const result = resolveEvidenceIds({
      store: testStore(),
      evidenceIds: ["CHUNK-0-E0", " chunk-0-e0", "chunk-0-e0 "],
    });

    expect(result.items).toEqual([]);
    expect(result.invalid).toEqual([0, 1, 2]);
  });
});

describe("resolveEvidenceItemToChunk", () => {
  it("grounds an item against its owning source chunk", () => {
    const store = testStore();
    const item = store.resolve("chunk-0-e1");

    const chunk = resolveEvidenceItemToChunk(item, testChunks());
    expect(chunk.chunkIndex).toBe(0);
    expect(chunk.pageNumber).toBe(1);
    expect(chunk.text.includes("82.26%")).toBe(true);
  });

  it("throws when the owning chunk is absent", () => {
    const store = testStore();
    const item = store.resolve("chunk-1-e0");

    expect(() => resolveEvidenceItemToChunk(item, [testChunks()[0]])).toThrow(
      EvidenceResolutionError,
    );
  });

  it("throws when containment is broken (tampered bytes)", () => {
    const tampered = {
      evidenceId: "chunk-0-e0",
      chunkIndex: 0,
      sourcePages: [1],
      exactText: "invented wording",
      kind: "span",
    };

    expect(() => resolveEvidenceItemToChunk(tampered, testChunks())).toThrow(
      EvidenceResolutionError,
    );
  });

  it.each([null, undefined, "chunk-0-e0", 42, {}, { chunkIndex: 0 }])(
    "rejects malformed items %s",
    (item) => {
      expect(() => resolveEvidenceItemToChunk(item, testChunks())).toThrow(
        EvidenceResolutionError,
      );
    },
  );

  it("rejects a missing or empty chunk list", () => {
    const store = testStore();
    const item = store.resolve("chunk-0-e0");

    expect(() => resolveEvidenceItemToChunk(item, [])).toThrow(EvidenceResolutionError);
    expect(() => resolveEvidenceItemToChunk(item, "chunks")).toThrow(EvidenceResolutionError);
  });
});

describe("resolveGroundedEvidence", () => {
  it("delivers the full chain: IDs → items → source chunks", () => {
    const result = resolveGroundedEvidence({
      store: testStore(),
      chunks: testChunks(),
      evidenceIds: ["chunk-0-e0", "chunk-1-e0"],
    });

    expect(result.missing).toEqual([]);
    expect(result.invalid).toEqual([]);
    expect(result.grounded).toHaveLength(2);
    expect(result.grounded[0]?.item.exactText).toBe("rural literacy is just 61.11%");
    expect(result.grounded[0]?.chunk.pageNumber).toBe(1);
    expect(result.grounded[1]?.item.exactText).toBe("6 districts");
    expect(result.grounded[1]?.chunk.pageNumber).toBe(2);
    expect(Object.isFrozen(result.grounded)).toBe(true);
  });

  it("propagates missing/invalid references without grounding them", () => {
    const result = resolveGroundedEvidence({
      store: testStore(),
      chunks: testChunks(),
      evidenceIds: ["chunk-0-e0", "chunk-0-e9", "bogus"],
    });

    expect(result.grounded).toHaveLength(1);
    expect(result.missing).toEqual(["chunk-0-e9"]);
    expect(result.invalid).toEqual([2]);
  });

  it("rejects malformed envelopes fail-loud", () => {
    expect(() => resolveGroundedEvidence(null)).toThrow(EvidenceResolutionError);
    expect(() =>
      resolveGroundedEvidence({ store: testStore(), chunks: [], evidenceIds: [] }),
    ).toThrow(EvidenceResolutionError);
    expect(() =>
      resolveGroundedEvidence({ store: testStore(), chunks: testChunks(), evidenceIds: "x" }),
    ).toThrow(EvidenceResolutionError);
  });
});
