import { describe, expect, it } from "vitest";
import type { AiContextChunk } from "../types";
import { EvidenceStore } from "./store";
import type { EvidenceItem } from "./types";
import {
  EvidenceSelectionError,
  selectCoverageBalancedEvidence,
} from "./selection";

/**
 * V7-A02 — Unit tests for deterministic coverage-balanced selection.
 *
 * Pure, dependency-free apart from the real B03/B04 admission path:
 * fixtures are genuine `EvidenceItem`s admitted through
 * `EvidenceStore.admit` (exact containment), so grouping, identity,
 * and immutability assertions exercise authoritative objects — no
 * hand-minted evidence, no Ollama, no network.
 */

function makeChunk(chunkIndex: number, pageNumber: number, tokens: string[]): AiContextChunk {
  const text = tokens.join(" ");
  return { chunkIndex, pageNumber, text, startOffset: 0, endOffset: text.length };
}

function tokens(page: number, count: number): string[] {
  return Array.from({ length: count }, (_, i) => `p${page}t${i}value`);
}

/**
 * Builds a store with one chunk per page; each page admits
 * `counts[p]` spans (in order). Returns the store plus its snapshot
 * (admission order).
 */

function buildSnapshot(counts: number[]): {
  store: EvidenceStore;
  snapshot: readonly EvidenceItem[];
} {
  const chunks = counts.map((_, page) =>
    makeChunk(page, page + 1, tokens(page + 1, Math.max(counts[page] as number, 1))),
  );
  const store = EvidenceStore.create({ chunks, sourcePageCount: counts.length });
  counts.forEach((count, page) => {
    const spans = tokens(page + 1, count);
    if (spans.length > 0) {
      store.admit(page, spans);
    } else {
      // Admit an empty pool so the chunk is still recorded without items.
      store.admit(page, []);
    }
  });
  return { store, snapshot: store.snapshot() };
}

function pagesOf(items: readonly EvidenceItem[]): number[] {
  return items.map((item) => (item.sourcePages as readonly number[])[0] as number);
}

describe("selectCoverageBalancedEvidence envelope", () => {
  it("1. empty input returns an empty frozen selection", () => {
    const out = selectCoverageBalancedEvidence([], 24);
    expect(out).toEqual([]);
    expect(Object.isFrozen(out)).toBe(true);
  });

  it("2. fewer items than max returns every item in order", () => {
    const { snapshot } = buildSnapshot([3, 2]);
    const out = selectCoverageBalancedEvidence(snapshot, 24);
    expect(out).toHaveLength(5);
    expect([...out]).toEqual([...snapshot]);
  });

  it("3. exactly max items returns every item", () => {
    const { snapshot } = buildSnapshot([4, 4]);
    const out = selectCoverageBalancedEvidence(snapshot, 8);
    expect(out).toHaveLength(8);
    expect([...out]).toEqual([...snapshot]);
  });

  it("9. maxItems = 1 takes the earliest item of the lowest page", () => {
    const { snapshot } = buildSnapshot([5, 5, 5]);
    const out = selectCoverageBalancedEvidence(snapshot, 1);
    expect(out).toHaveLength(1);
    expect(out[0]).toBe(snapshot[0]);
    expect((out[0]?.sourcePages as readonly number[])[0]).toBe(1);
  });

  it("rejects malformed envelopes fail-loud", () => {
    const { snapshot } = buildSnapshot([2]);
    expect(() => selectCoverageBalancedEvidence("x", 24)).toThrow(EvidenceSelectionError);
    expect(() => selectCoverageBalancedEvidence(null, 24)).toThrow(EvidenceSelectionError);
    for (const bad of [0, -1, 1.5, Number.NaN, "24", undefined]) {
      expect(() => selectCoverageBalancedEvidence(snapshot, bad)).toThrow(
        EvidenceSelectionError,
      );
    }
  });

  it("4 (TASK 4). items that cannot be grouped fail safely, never rewritten", () => {
    const { snapshot } = buildSnapshot([2]);
    const badEmptyPages = [
      { ...snapshot[0], sourcePages: Object.freeze([]) },
    ];
    expect(() => selectCoverageBalancedEvidence(badEmptyPages, 24)).toThrow(
      EvidenceSelectionError,
    );
    const badChunk = [{ ...snapshot[0], chunkIndex: -1 }];
    expect(() => selectCoverageBalancedEvidence(badChunk, 24)).toThrow(
      EvidenceSelectionError,
    );
    expect(() => selectCoverageBalancedEvidence([42], 24)).toThrow(EvidenceSelectionError);
  });
});

describe("selectCoverageBalancedEvidence balancing", () => {
  it("5. one page with many items keeps the first max in order", () => {
    const { snapshot } = buildSnapshot([40]);
    const out = selectCoverageBalancedEvidence(snapshot, 24);
    expect(out).toHaveLength(24);
    expect([...out]).toEqual([...snapshot.slice(0, 24)]);
  });

  it("6. many pages with one item each are all kept (no starvation)", () => {
    const { snapshot } = buildSnapshot([1, 1, 1, 1, 1, 1]);
    const out = selectCoverageBalancedEvidence(snapshot, 4);
    expect(out).toHaveLength(4);
    expect(pagesOf(out)).toEqual([1, 2, 3, 4]);
  });

  it("4+7. dense pages do not starve thin pages past the budget", () => {
    // Page 1 holds 20 items; pages 2 and 3 hold 1 each. First-6 would
    // be all page 1; balanced must include the thin pages.
    const { snapshot } = buildSnapshot([20, 1, 1]);
    const out = selectCoverageBalancedEvidence(snapshot, 6);
    expect(out).toHaveLength(6);
    expect(pagesOf(out)).toContain(2);
    expect(pagesOf(out)).toContain(3);
    // Quota is 2/2/2, then the 2 unused thin-page slots redistribute
    // to page 1: four page-1 spans plus both thin pages, input order.
    expect(pagesOf(out)).toEqual([1, 1, 1, 1, 2, 3]);
  });

  it("10. evidence order within each group is admission order", () => {
    const { snapshot } = buildSnapshot([10, 10]);
    const out = selectCoverageBalancedEvidence(snapshot, 6);
    // Quota 3/3: first three spans of each page, output in input order.
    expect([...out]).toEqual([...snapshot.slice(0, 3), ...snapshot.slice(10, 13)]);
  });

  it("8. repeated calls are deterministic", () => {
    const { snapshot } = buildSnapshot([20, 1, 7, 3]);
    const first = selectCoverageBalancedEvidence(snapshot, 12);
    const second = selectCoverageBalancedEvidence(snapshot, 12);
    const third = selectCoverageBalancedEvidence(snapshot, 12);
    expect(second.map((i) => i.evidenceId)).toEqual(first.map((i) => i.evidenceId));
    expect(third.map((i) => i.evidenceId)).toEqual(first.map((i) => i.evidenceId));
  });

  it("11. input array is never mutated", () => {
    const { snapshot } = buildSnapshot([20, 1, 7]);
    const before = [...snapshot];
    const out = selectCoverageBalancedEvidence(snapshot, 10);
    expect([...snapshot]).toEqual(before);
    expect(out).not.toBe(snapshot);
  });

  it("12. store objects are untouched and identities preserved", () => {
    const { store, snapshot } = buildSnapshot([20, 1, 7]);
    const sizeBefore = store.size;
    const itemsBefore = [...store.items];
    const out = selectCoverageBalancedEvidence(snapshot, 10);
    expect(store.size).toBe(sizeBefore);
    expect([...store.items]).toEqual(itemsBefore);
    for (const item of out) {
      expect(snapshot).toContain(item);
    }
  });

  it("13. sourcePages groups multi-chunk pages together", () => {
    // Two chunks on page 1 plus one chunk on page 2: page 1 is ONE group.
    const chunks = [
      makeChunk(0, 1, tokens(1, 6).slice(0, 3)),
      makeChunk(1, 1, tokens(1, 6).slice(3)),
      makeChunk(2, 2, tokens(2, 2)),
    ];
    const store = EvidenceStore.create({ chunks, sourcePageCount: 2 });
    store.admit(0, tokens(1, 6).slice(0, 3));
    store.admit(1, tokens(1, 6).slice(3));
    store.admit(2, tokens(2, 2));
    const snapshot = store.snapshot();
    const out = selectCoverageBalancedEvidence(snapshot, 4);
    expect(out).toHaveLength(4);
    // Quota 2/2 across pages {1},{2}: page-2 keeps both spans.
    expect(pagesOf(out).filter((p) => p === 2)).toHaveLength(2);
    expect(pagesOf(out).filter((p) => p === 1)).toHaveLength(2);
  });

  it("14. chunk/page ordering is deterministic (lowest page first)", () => {
    const { snapshot } = buildSnapshot([1, 1, 1, 1, 1]);
    // base 0, remainder 2 → pages 1 and 2 take one each.
    const out = selectCoverageBalancedEvidence(snapshot, 2);
    expect(pagesOf(out)).toEqual([1, 2]);
  });

  it("15. unused quota is redistributed to groups with remaining items", () => {
    // Page 1 holds 1 item (quota 3, uses 1, leaves 2); page 2 holds 10.
    const { snapshot } = buildSnapshot([1, 10]);
    const out = selectCoverageBalancedEvidence(snapshot, 6);
    expect(out).toHaveLength(6);
    expect(pagesOf(out).filter((p) => p === 1)).toHaveLength(1);
    expect(pagesOf(out).filter((p) => p === 2)).toHaveLength(5);
    expect([...out]).toEqual([snapshot[0], ...snapshot.slice(1, 6)]);
  });

  it("output preserves original input order, not grouped order", () => {
    const { snapshot } = buildSnapshot([6, 6, 6]);
    const out = selectCoverageBalancedEvidence(snapshot, 9);
    const positions = out.map((item) => snapshot.indexOf(item));
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });
});
