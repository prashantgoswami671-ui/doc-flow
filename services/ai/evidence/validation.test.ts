import { describe, expect, it } from "vitest";
import type { AiContextChunk } from "../types";
import { admitChunkEvidence } from "./validation";
import { EvidenceValidationError } from "./validation";

/**
 * V6-B03 — Unit tests for deterministic evidence validation / admission.
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

function admit(chunkIndex: number, spans: unknown, overrides: Record<string, unknown> = {}) {
  return admitChunkEvidence({
    chunks: testChunks(),
    sourcePageCount: 3,
    chunkIndex,
    spans,
    ...overrides,
  });
}

describe("admitChunkEvidence — admission", () => {
  it("admits exact spans with chunk-scoped IDs in output order", () => {
    const result = admit(0, ["rural literacy is just 61.11%", "82.26% in urban areas"]);

    expect(result.failures).toEqual([]);
    expect(result.items).toHaveLength(2);
    expect(result.items[0]?.evidenceId).toBe("chunk-0-e0");
    expect(result.items[1]?.evidenceId).toBe("chunk-0-e1");
    expect(result.items[0]?.chunkIndex).toBe(0);
    expect(result.items[0]?.sourcePages).toEqual([1]);
    expect(result.items[0]?.exactText).toBe("rural literacy is just 61.11%");
  });

  it("sequences IDs densely over admitted items only", () => {
    const result = admit(0, ["rural literacy is just 61.11%", "not in the chunk", "82.26%"]);

    expect(result.items.map((item) => item.evidenceId)).toEqual(["chunk-0-e0", "chunk-0-e1"]);
    expect(result.failures).toEqual([{ index: 1, reason: "not-contained" }]);
  });

  it("accepts an empty span pool as an empty result without throwing", () => {
    expect(admit(0, [])).toEqual({ items: [], failures: [] });
  });

  it("admits duplicate identical spans with distinct IDs", () => {
    const result = admit(0, ["82.26%", "82.26%"]);

    expect(result.failures).toEqual([]);
    expect(result.items.map((item) => item.evidenceId)).toEqual(["chunk-0-e0", "chunk-0-e1"]);
  });

  it("does not mutate the input span pool", () => {
    const spans = ["82.26%", "not in the chunk"];
    admit(0, spans);
    expect(spans).toEqual(["82.26%", "not in the chunk"]);
  });
});

describe("admitChunkEvidence — fail-closed model data", () => {
  it("rejects empty and whitespace-only spans but still admits valid siblings", () => {
    const result = admit(0, ["", "   ", "82.26%"]);

    expect(result.items.map((item) => item.evidenceId)).toEqual(["chunk-0-e0"]);
    expect(result.failures).toEqual([
      { index: 0, reason: "empty-exactText" },
      { index: 1, reason: "empty-exactText" },
    ]);
  });

  it("rejects non-string entries without throwing", () => {
    const result = admit(0, [42, null, { text: "82.26%" }, "82.26%"]);

    expect(result.items).toHaveLength(1);
    expect(result.failures).toEqual([
      { index: 0, reason: "malformed-span" },
      { index: 1, reason: "malformed-span" },
      { index: 2, reason: "malformed-span" },
    ]);
  });

  it("rejects spans that are not exact substrings — no normalization", () => {
    const result = admit(0, [
      "Rural literacy is just 61.11%", // case differs
      "rural literacy is  just 61.11%", // double space differs
      "rural literacy is just 61.11%  ", // double trailing space differs
    ]);

    expect(result.items).toEqual([]);
    expect(result.failures).toEqual([
      { index: 0, reason: "not-contained" },
      { index: 1, reason: "not-contained" },
      { index: 2, reason: "not-contained" },
    ]);
  });

  it("keeps failure records content-free (index + reason only)", () => {
    const result = admit(0, ["not in the chunk"]);

    expect(result.failures).toHaveLength(1);
    expect(Object.keys(result.failures[0] ?? {}).sort()).toEqual(["index", "reason"]);
  });
});

describe("admitChunkEvidence — deterministic numeric promotion", () => {
  it("promotes percent/decimal spans with the exact surface value", () => {
    const result = admit(0, ["rural literacy is just 61.11%"]);

    expect(result.failures).toEqual([]);
    expect(result.items[0]?.kind).toBe("number");
    expect(result.items[0]?.value).toBe("61.11%");
  });

  it("promotes currency and comma-grouped spans with the exact surface value", () => {
    const result = admit(2, ["allocation of ₹ 1,14,271 crore was announced (approx.)"]);

    expect(result.failures).toEqual([]);
    expect(result.items[0]?.kind).toBe("number");
    expect(result.items[0]?.value).toBe("₹ 1,14,271");
  });

  it.each([
    ["7 districts", "7"],
    ["42 people attended the meeting", "42"],
    ["150 households were surveyed", "150"],
    ["3 hospitals serve the block", "3"],
    ["12 cases were reported", "12"],
  ])("promotes integer count %s with value %s", (span, value) => {
    const chunks = [makeChunk(0, 1, `context: ${span} end`)];
    const result = admitChunkEvidence({ chunks, sourcePageCount: 1, chunkIndex: 0, spans: [span] });

    expect(result.failures).toEqual([]);
    expect(result.items[0]?.kind).toBe("number");
    expect(result.items[0]?.value).toBe(value);
  });

  it.each(["2024", "1991", "Fig. 2", "Table 3", "ISO9001 certified", "17", "see Fig. 2", "in 2024"])(
    "keeps %s as a span with no value",
    (span) => {
      const chunks = [makeChunk(0, 1, `context: ${span} end`)];
      const result = admitChunkEvidence({
        chunks,
        sourcePageCount: 1,
        chunkIndex: 0,
        spans: [span],
      });

      expect(result.failures).toEqual([]);
      expect(result.items[0]?.kind).toBe("span");
      expect(result.items[0]?.value).toBeUndefined();
    },
  );

  it("keeps figure-governed references as spans even with a following word", () => {
    const chunks = [makeChunk(0, 1, "see Fig. 2 for details and Table 3 shows growth")];
    const result = admitChunkEvidence({
      chunks,
      sourcePageCount: 1,
      chunkIndex: 0,
      spans: ["see Fig. 2 for details", "Table 3 shows growth"],
    });

    expect(result.failures).toEqual([]);
    expect(result.items.map((item) => item.kind)).toEqual(["span", "span"]);
  });

  it("keeps year-led spans as spans while promoting a later valid count", () => {
    // First valid candidate wins: "2024 estimates" is year-guarded, "6 districts" promotes.
    const result = admit(1, ["see Fig. 2 for 2024 estimates across 6 districts"]);

    expect(result.failures).toEqual([]);
    expect(result.items[0]?.kind).toBe("number");
    expect(result.items[0]?.value).toBe("6");
  });

  it("holds dual containment for every admitted numeric value", () => {
    for (const chunkIndex of [0, 1, 2]) {
      const chunks = testChunks();
      const chunk = chunks[chunkIndex] as AiContextChunk;
      const result = admitChunkEvidence({
        chunks,
        sourcePageCount: 3,
        chunkIndex,
        spans: [chunk.text],
      });
      for (const item of result.items) {
        if (item.kind === "number") {
          expect(chunk.text.includes(item.value as string)).toBe(true);
          expect(item.exactText.includes(item.value as string)).toBe(true);
        }
      }
    }
  });
});

describe("admitChunkEvidence — envelope errors throw fail-loud", () => {
  it.each([null, undefined, "spans", 42, []])("rejects non-object options %s", (options) => {
    expect(() => admitChunkEvidence(options)).toThrow(EvidenceValidationError);
  });

  it("rejects an unknown chunkIndex", () => {
    expect(() => admit(9, ["anything"])).toThrow(EvidenceValidationError);
  });

  it.each([-1, 1.5, NaN, Infinity, "0"])("rejects bad chunkIndex %s", (chunkIndex) => {
    expect(() =>
      admitChunkEvidence({ chunks: testChunks(), sourcePageCount: 3, chunkIndex, spans: [] }),
    ).toThrow(EvidenceValidationError);
  });

  it.each([0, -3, 1.5, NaN, "3"])("rejects bad sourcePageCount %s", (sourcePageCount) => {
    expect(() =>
      admitChunkEvidence({ chunks: testChunks(), sourcePageCount, chunkIndex: 0, spans: [] }),
    ).toThrow(EvidenceValidationError);
  });

  it("rejects a chunk whose page is outside the page range", () => {
    expect(() =>
      admitChunkEvidence({
        chunks: [makeChunk(0, 5, "text")],
        sourcePageCount: 3,
        chunkIndex: 0,
        spans: [],
      }),
    ).toThrow(EvidenceValidationError);
  });

  it.each([undefined, "span", 42, { spans: [] }])("rejects non-array spans %s", (spans) => {
    expect(() => admit(0, spans)).toThrow(EvidenceValidationError);
  });

  it("rejects malformed chunk shapes", () => {
    expect(() =>
      admitChunkEvidence({
        chunks: [{ chunkIndex: 0, pageNumber: 0, text: "x" }],
        sourcePageCount: 1,
        chunkIndex: 0,
        spans: [],
      }),
    ).toThrow(EvidenceValidationError);
  });
});

describe("admitChunkEvidence — immutability", () => {
  it("freezes admitted items, sourcePages, and the result arrays", () => {
    const result = admit(0, ["82.26%"]);

    expect(result.items).toHaveLength(1);
    const item = result.items[0] as unknown as Record<string, unknown>;
    expect(Object.isFrozen(result.items)).toBe(true);
    expect(Object.isFrozen(result.failures)).toBe(true);
    expect(Object.isFrozen(item)).toBe(true);
    expect(Object.isFrozen(item["sourcePages"])).toBe(true);
  });
});
