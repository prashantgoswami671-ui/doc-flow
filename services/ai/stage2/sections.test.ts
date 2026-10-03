/**
 * V8-A07 — Unit tests for deterministic section partitioning.
 *
 * Pure tests: no provider, no network, no Ollama, no PDF parsing.
 * Fitness functions for the partitionExact invariant and the
 * page-contiguous grouping contract.
 */

import { describe, expect, it } from "vitest";
import type { EvidenceItem } from "../evidence/types";
import type { Stage2EvidenceView } from "./types";
import {
  isPartitionExact,
  partitionSelectedEvidence,
  SECTION_MAX_ITEMS,
  SECTION_MAX_PROMPT_CHARS,
  SectionPartitionError,
} from "./sections";

function item(
  evidenceId: string,
  chunkIndex: number,
  page: number,
  text = "exact span text for sizing",
): EvidenceItem {
  return Object.freeze({
    evidenceId,
    chunkIndex,
    sourcePages: Object.freeze([page]),
    exactText: text,
    kind: "span" as const,
  });
}

function viewOf(entry: EvidenceItem): Stage2EvidenceView {
  return Object.freeze({
    evidenceId: entry.evidenceId,
    exactText: entry.exactText,
    kind: entry.kind,
    sourcePage: (entry.sourcePages as readonly number[])[0] as number,
    chunk: entry.chunkIndex,
  });
}

function pool(pages: number[], perPage: number): { items: EvidenceItem[]; views: Stage2EvidenceView[] } {
  const items: EvidenceItem[] = [];
  let chunk = 0;
  for (const page of pages) {
    for (let k = 0; k < perPage; k += 1) {
      items.push(item(`chunk-${chunk}-e${k}`, chunk, page));
    }
    chunk += 1;
  }
  return { items, views: items.map(viewOf) };
}

function partitionIds(sections: readonly { evidenceIds: readonly string[] }[]): string[] {
  return sections.flatMap((s) => [...s.evidenceIds]);
}

describe("partitionSelectedEvidence", () => {
  it("rejects malformed envelopes fail-loud", () => {
    const { items, views } = pool([1], 2);
    expect(() => partitionSelectedEvidence(undefined)).toThrow(SectionPartitionError);
    expect(() => partitionSelectedEvidence({ items: [], views: [], sourcePageCount: 1 })).toThrow(
      SectionPartitionError,
    );
    expect(() =>
      partitionSelectedEvidence({ items, views: views.slice(0, 1), sourcePageCount: 1 }),
    ).toThrow(SectionPartitionError);
    expect(() => partitionSelectedEvidence({ items, views, sourcePageCount: 0 })).toThrow(
      SectionPartitionError,
    );
    expect(() =>
      partitionSelectedEvidence({ items, views, sourcePageCount: 1, maxItemsPerSection: 0 }),
    ).toThrow(SectionPartitionError);
  });

  it("rejects items without a positive owning page", () => {
    const bad = Object.freeze({
      evidenceId: "chunk-0-e0",
      chunkIndex: 0,
      sourcePages: Object.freeze([]),
      exactText: "x",
      kind: "span" as const,
    }) as EvidenceItem;
    const views = [viewOf(item("chunk-0-e0", 0, 1))];
    expect(() =>
      partitionSelectedEvidence({ items: [bad], views, sourcePageCount: 1 }),
    ).toThrow(SectionPartitionError);
  });

  it("packs a small pool into one page-ordered section", () => {
    const { items, views } = pool([3, 1, 2], 2);
    const sections = partitionSelectedEvidence({ items, views, sourcePageCount: 3 });
    expect(sections).toHaveLength(1);
    expect(sections[0]?.sectionIndex).toBe(0);
    expect(sections[0]?.pageRange).toEqual([1, 2, 3]);
    expect(sections[0]?.evidenceIds).toHaveLength(6);
    expect(isPartitionExact(sections, items.map((i) => i.evidenceId))).toBe(true);
  });

  it("cuts at page boundaries to respect the item budget", () => {
    const { items, views } = pool([1, 2, 3, 4], 10);
    const sections = partitionSelectedEvidence({
      items,
      views,
      sourcePageCount: 4,
      maxItemsPerSection: 16,
    });
    // 10-item atomic pages: greedy packs can never merge two pages here.
    expect(sections).toHaveLength(4);
    expect(sections.map((s) => s.pageRange)).toEqual([[1], [2], [3], [4]]);
    for (const section of sections) {
      expect(section.evidenceIds).toHaveLength(10);
    }
    expect(isPartitionExact(sections, items.map((i) => i.evidenceId))).toBe(true);
  });

  it("merges thin pages up to the budget", () => {
    const { items, views } = pool([1, 2, 3, 4, 5], 3);
    const sections = partitionSelectedEvidence({
      items,
      views,
      sourcePageCount: 5,
      maxItemsPerSection: 16,
    });
    expect(sections).toHaveLength(1);
    expect(sections[0]?.pageRange).toEqual([1, 2, 3, 4, 5]);
  });

  it("keeps an oversized atomic page whole instead of splitting it", () => {
    const { items, views } = pool([1, 2], 20);
    const sections = partitionSelectedEvidence({
      items,
      views,
      sourcePageCount: 2,
      maxItemsPerSection: 16,
    });
    expect(sections).toHaveLength(2);
    expect(sections[0]?.evidenceIds).toHaveLength(20);
    expect(sections[1]?.evidenceIds).toHaveLength(20);
    expect(isPartitionExact(sections, items.map((i) => i.evidenceId))).toBe(true);
  });

  it("splits prompt-oversize sections at page boundaries", () => {
    const { items, views } = pool([1, 2, 3, 4], 4);
    const sections = partitionSelectedEvidence({
      items,
      views,
      sourcePageCount: 4,
      maxItemsPerSection: 16,
      maxPromptChars: 1,
    });
    // Every page boundary becomes a cut: 4 single-page sections.
    expect(sections).toHaveLength(4);
    expect(sections.map((s) => s.pageRange)).toEqual([[1], [2], [3], [4]]);
  });

  it("is deterministic across repeated calls", () => {
    const { items, views } = pool([5, 1, 4, 2, 3], 7);
    const first = partitionSelectedEvidence({ items, views, sourcePageCount: 5 });
    const second = partitionSelectedEvidence({ items, views, sourcePageCount: 5 });
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("never mutates the input", () => {
    const { items, views } = pool([2, 1, 3], 5);
    const before = JSON.stringify(items.map((i) => i.evidenceId));
    partitionSelectedEvidence({ items, views, sourcePageCount: 3 });
    expect(JSON.stringify(items.map((i) => i.evidenceId))).toBe(before);
  });

  it("treats the 64-item production budget shape: ≤16 per section, exact union", () => {
    const pages = Array.from({ length: 20 }, (_, i) => i + 1);
    const { items, views } = pool(pages, 3);
    const sections = partitionSelectedEvidence({
      items,
      views,
      sourcePageCount: 22,
      maxItemsPerSection: SECTION_MAX_ITEMS,
      maxPromptChars: SECTION_MAX_PROMPT_CHARS,
    });
    expect(sections.length).toBeGreaterThan(1);
    for (const section of sections) {
      expect(section.evidenceIds.length).toBeLessThanOrEqual(SECTION_MAX_ITEMS);
    }
    expect(isPartitionExact(sections, items.map((i) => i.evidenceId))).toBe(true);
    // Page ranges are contiguous and non-overlapping across sections.
    const covered = sections.flatMap((s) => [...s.pageRange]);
    expect(covered).toEqual([...covered].sort((a, b) => a - b));
    expect(new Set(covered).size).toBe(covered.length);
  });
});

describe("isPartitionExact", () => {
  it("detects dropped IDs", () => {
    const { items, views } = pool([1, 2], 2);
    const sections = partitionSelectedEvidence({ items, views, sourcePageCount: 2 });
    expect(isPartitionExact(sections, [...items.map((i) => i.evidenceId), "chunk-9-e9"])).toBe(
      false,
    );
  });

  it("detects duplicated IDs", () => {
    const { items } = pool([1], 2);
    const duplicated = [
      Object.freeze({
        sectionIndex: 0,
        pageRange: Object.freeze([1]),
        evidenceIds: Object.freeze([items[0]?.evidenceId as string]),
      }),
      Object.freeze({
        sectionIndex: 1,
        pageRange: Object.freeze([1]),
        evidenceIds: Object.freeze([items[0]?.evidenceId as string]),
      }),
    ];
    expect(isPartitionExact(duplicated, items.map((i) => i.evidenceId))).toBe(false);
  });

  it("accepts the exact union", () => {
    const { items, views } = pool([1, 2, 3], 4);
    const sections = partitionSelectedEvidence({ items, views, sourcePageCount: 3 });
    expect(isPartitionExact(sections, partitionIds(sections))).toBe(true);
  });
});
