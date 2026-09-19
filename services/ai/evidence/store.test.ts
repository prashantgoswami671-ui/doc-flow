import { describe, expect, it } from "vitest";
import type { AiContextChunk } from "../types";
import { EvidenceStore, EvidenceStoreError } from "./store";

/**
 * V6-B04 — Unit tests for the immutable production Evidence Store.
 *
 * Pure, dependency-free: hand-built `AiContextChunk` fixtures, no Ollama,
 * no Browser AI, no network, no PDF fixtures, no benchmark artifacts.
 */

function makeChunk(chunkIndex: number, pageNumber: number, text: string): AiContextChunk {
  return { chunkIndex, pageNumber, text, startOffset: 0, endOffset: text.length };
}

function testChunks(): AiContextChunk[] {
  return [
    makeChunk(0, 1, "rural literacy is just 61.11% against 82.26% in urban areas"),
    makeChunk(1, 2, "see Fig. 2 for 2024 estimates across 6 districts"),
    makeChunk(2, 3, "allocation of ₹ 1,14,271 crore was announced (approx.)"),
  ];
}

function testStore(): EvidenceStore {
  return EvidenceStore.create({ chunks: testChunks(), sourcePageCount: 3 });
}

describe("EvidenceStore.create", () => {
  it("creates an empty store bound to the chunk context", () => {
    const store = testStore();

    expect(store.size).toBe(0);
    expect(store.items).toEqual([]);
    expect(store.admittedChunkIndexes).toEqual([]);
  });

  it.each([null, undefined, "store", 42, []])("rejects non-object options %s", (options) => {
    expect(() => EvidenceStore.create(options)).toThrow(EvidenceStoreError);
  });

  it("rejects an empty chunk list and a bad page count", () => {
    expect(() => EvidenceStore.create({ chunks: [], sourcePageCount: 3 })).toThrow(
      EvidenceStoreError,
    );
    expect(() => EvidenceStore.create({ chunks: testChunks(), sourcePageCount: 0 })).toThrow(
      EvidenceStoreError,
    );
  });

  it("rejects chunks outside the page range", () => {
    expect(() =>
      EvidenceStore.create({ chunks: [makeChunk(0, 5, "text")], sourcePageCount: 3 }),
    ).toThrow(EvidenceStoreError);
  });
});

describe("EvidenceStore.admit", () => {
  it("admits one chunk's spans with chunk-scoped IDs", () => {
    const store = testStore();
    const result = store.admit(0, ["rural literacy is just 61.11%", "82.26%"]);

    expect(result.failures).toEqual([]);
    expect(result.admitted.map((item) => item.evidenceId)).toEqual(["chunk-0-e0", "chunk-0-e1"]);
    expect(store.size).toBe(2);
    expect(store.admittedChunkIndexes).toEqual([0]);
  });

  it("accumulates admissions across chunks with namespaced IDs", () => {
    const store = testStore();
    store.admit(0, ["82.26%"]);
    store.admit(2, ["allocation of ₹ 1,14,271 crore was announced (approx.)"]);

    expect(store.size).toBe(2);
    expect(store.items.map((item) => item.evidenceId)).toEqual(["chunk-0-e0", "chunk-2-e0"]);
    expect(store.admittedChunkIndexes).toEqual([0, 2]);
  });

  it("counts rejections without storing them", () => {
    const store = testStore();
    const result = store.admit(0, ["82.26%", "", "not in the chunk"]);

    expect(result.admitted).toHaveLength(1);
    expect(result.failures).toEqual([
      { index: 1, reason: "empty-exactText" },
      { index: 2, reason: "not-contained" },
    ]);
    expect(store.size).toBe(1);
  });

  it("rejects re-admitting the same chunk", () => {
    const store = testStore();
    store.admit(0, ["82.26%"]);

    expect(() => store.admit(0, ["61.11%"])).toThrow(EvidenceStoreError);
    expect(store.size).toBe(1);
  });

  it("rejects unknown chunks and malformed pools fail-loud", () => {
    const store = testStore();

    expect(() => store.admit(9, ["anything"])).toThrow();
    expect(() => store.admit(0, "not-an-array")).toThrow();
    expect(() => store.admit(-1, [])).toThrow(EvidenceStoreError);
    expect(store.size).toBe(0);
  });

  it("keeps IDs unique across the whole store", () => {
    const store = testStore();
    store.admit(0, ["82.26%"]);
    store.admit(1, ["6 districts"]);

    const ids = store.items.map((item) => item.evidenceId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("EvidenceStore.resolve", () => {
  it("resolves claim → evidenceId → immutable item", () => {
    const store = testStore();
    store.admit(0, ["rural literacy is just 61.11%"]);

    const item = store.resolve("chunk-0-e0");
    expect(item?.exactText).toBe("rural literacy is just 61.11%");
    expect(item?.chunkIndex).toBe(0);
    expect(item?.sourcePages).toEqual([1]);
    expect(Object.isFrozen(item)).toBe(true);
  });

  it.each(["chunk-0-e9", "chunk-9-e0", "", "evidence-1", null, undefined, 42])(
    "returns undefined for %s",
    (id) => {
      const store = testStore();
      store.admit(0, ["82.26%"]);
      expect(store.resolve(id)).toBeUndefined();
    },
  );
});

describe("EvidenceStore immutability", () => {
  it("freezes items, views, and snapshots", () => {
    const store = testStore();
    store.admit(0, ["82.26%"]);

    expect(Object.isFrozen(store.items)).toBe(true);
    const snapshot = store.snapshot();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(snapshot).toEqual(store.items);
  });

  it("snapshot copies cannot affect the store", () => {
    const store = testStore();
    store.admit(0, ["82.26%"]);

    const snapshot = store.snapshot();
    expect(snapshot).not.toBe(store.items);
    expect(store.size).toBe(1);
    expect(store.resolve("chunk-0-e0")?.exactText).toBe("82.26%");
  });
});
