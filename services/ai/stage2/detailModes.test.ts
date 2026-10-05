/**
 * V8-A08 — Unit tests for deterministic detail-mode projection.
 *
 * Pure projection over already-grounded claims: no provider, no
 * network, no PDF, no LLM. Fixtures hand-build `GroundedStage2Claim`
 * objects (same shape as C03 output).
 */

import { describe, expect, it } from "vitest";
import {
  DETAIL_MODES,
  projectAllDetailModes,
  projectDetailMode,
  type DetailModeProjection,
} from "./detailModes";
import type { GroundedStage2Claim } from "./projection";

function groundedClaim(
  text: string,
  page: number,
  evidenceId: string,
  chunkIndex = page - 1,
): GroundedStage2Claim {
  const item = Object.freeze({
    evidenceId,
    chunkIndex,
    sourcePages: Object.freeze([page]),
    exactText: `exact bytes ${evidenceId}`,
    kind: "span" as const,
  });
  const chunk = Object.freeze({
    chunkIndex,
    pageNumber: page,
    text: `chunk text carrying exact bytes ${evidenceId} plus context`,
    startOffset: 0,
    endOffset: 60,
  });
  return Object.freeze({
    kind: "fact" as const,
    text,
    evidenceIds: Object.freeze([evidenceId]),
    evidence: Object.freeze([Object.freeze({ item, chunk })]),
  });
}

function multiEvidenceClaim(text: string, ids: string[], pages: number[]): GroundedStage2Claim {
  const evidence = ids.map((id, k) =>
    Object.freeze({
      item: Object.freeze({
        evidenceId: id,
        chunkIndex: k,
        sourcePages: Object.freeze([pages[k] ?? 1]),
        exactText: `exact bytes ${id}`,
        kind: "span" as const,
      }),
      chunk: Object.freeze({
        chunkIndex: k,
        pageNumber: pages[k] ?? 1,
        text: `chunk text carrying exact bytes ${id} plus context`,
        startOffset: 0,
        endOffset: 60,
      }),
    }),
  );
  return Object.freeze({
    kind: "fact" as const,
    text,
    evidenceIds: Object.freeze([...ids]),
    evidence: Object.freeze(evidence),
  });
}

/** Six claims across three pages with one near-duplicate pair. */
function fixtureClaims(): GroundedStage2Claim[] {
  return [
    groundedClaim("The council approved the annual budget for road maintenance.", 1, "chunk-0-e0", 0),
    groundedClaim("The council approved the annual budget for road maintenance works.", 1, "chunk-0-e1", 0),
    groundedClaim("Engineers reported bridge inspection findings with load ratings.", 2, "chunk-1-e0", 1),
    groundedClaim("The water utility published quarterly quality test outcomes for reservoirs.", 2, "chunk-1-e1", 1),
    groundedClaim("The transit authority opened two new park and ride facilities downtown.", 3, "chunk-2-e0", 2),
    multiEvidenceClaim(
      "Overall the report concludes infrastructure spending rose across departments.",
      ["chunk-0-e0", "chunk-1-e0", "chunk-2-e0"],
      [1, 2, 3],
    ),
  ];
}

function baseOptions(claims: GroundedStage2Claim[]) {
  return {
    claims,
    sourcePageCount: 4,
    pagesWithoutText: [4],
    failedSections: [] as number[],
    sourceChars: 10000,
  };
}

describe("V8-A08 detail-mode projection correctness", () => {
  it("is deterministic: same input claim set produces same mode output", () => {
    const claims = fixtureClaims();
    const options = baseOptions(claims);
    for (const mode of DETAIL_MODES) {
      const first = projectDetailMode(options, mode);
      const second = projectDetailMode(options, mode);
      expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    }
    const allFirst = projectAllDetailModes(options);
    const allSecond = projectAllDetailModes(options);
    expect(JSON.stringify(allFirst)).toBe(JSON.stringify(allSecond));
  });

  it("never mutates claim text or evidence IDs and invents nothing", () => {
    const claims = fixtureClaims();
    const before = JSON.stringify(claims);
    const all = projectAllDetailModes(baseOptions(claims));
    // Same object references (identity-preserved, not rewritten).
    for (const mode of DETAIL_MODES) {
      for (const claim of all[mode].claims) {
        expect(claims).toContain(claim);
      }
      // Every displayed ID resolves to an input ID; every page is an input page.
      const inputIds = new Set(claims.flatMap((c) => [...c.evidenceIds]));
      for (const id of all[mode].distinctEvidenceIds) {
        expect(inputIds.has(id)).toBe(true);
      }
      for (const page of all[mode].groundedPages) {
        expect([1, 2, 3]).toContain(page);
      }
      // Character count is the documented sum of displayed text lengths.
      const expected = all[mode].claims.reduce((n, c) => n + c.text.length, 0);
      expect(all[mode].characterCount).toBe(expected);
      // Ratio uses the supplied source denominator.
      expect(all[mode].summarySourceRatio).toBeCloseTo(expected / 10000, 10);
    }
    expect(JSON.stringify(claims)).toBe(before);
  });

  it("rejects malformed envelopes fail-loud", () => {
    const claims = fixtureClaims();
    expect(() => projectDetailMode({ claims, sourcePageCount: 0 }, "concise")).toThrow();
    expect(() => projectDetailMode({ claims, sourcePageCount: 4 }, "other" as never)).toThrow();
    expect(() => projectDetailMode(null, "concise")).toThrow();
  });
});

describe("V8-A08 concise", () => {
  it("removes lower-priority redundant material, one representative per page", () => {
    const claims = fixtureClaims();
    const projection: DetailModeProjection = projectDetailMode(baseOptions(claims), "concise");
    // Three grounded pages → three representatives (not first-N: index 5 conclusion
    // spans all pages and competes, near-duplicate index 1 suppressed).
    expect(projection.claims.length).toBeLessThan(claims.length);
    expect(projection.groundedPages).toEqual([1, 2, 3]);
    expect(projection.representedSections).toEqual([1, 2, 3]);
    // Omitted claims are recorded as intentional omission, not source gaps.
    expect(projection.omittedIndexes.length).toBeGreaterThan(0);
    expect([...projection.selectedIndexes, ...projection.omittedIndexes].sort((a, b) => a - b)).toEqual([
      0, 1, 2, 3, 4, 5,
    ]);
    // Output preserves original order.
    expect([...projection.selectedIndexes].sort((a, b) => a - b)).toEqual(projection.selectedIndexes);
  });

  it("preserves broad section representation where possible", () => {
    const claims = fixtureClaims();
    const projection = projectDetailMode(baseOptions(claims), "concise");
    // Every grounded page still represented despite suppression.
    expect(projection.omittedPages).toEqual([]);
  });
});

describe("V8-A08 detailed / very-detailed", () => {
  it("detailed contains more grounded information than concise and preserves provenance", () => {
    const claims = fixtureClaims();
    const concise = projectDetailMode(baseOptions(claims), "concise");
    const detailed = projectDetailMode(baseOptions(claims), "detailed");
    expect(detailed.claims.length).toBeGreaterThan(concise.claims.length);
    expect(detailed.characterCount).toBeGreaterThan(concise.characterCount);
    // Near-duplicate suppressed exactly once (6 → 5).
    expect(detailed.claims.length).toBe(claims.length - 1);
    for (const claim of detailed.claims) {
      expect(claims).toContain(claim);
    }
    expect(detailed.distinctEvidenceIds.length).toBeGreaterThanOrEqual(
      concise.distinctEvidenceIds.length,
    );
  });

  it("very-detailed maximizes coverage without fabrication", () => {
    const claims = fixtureClaims();
    const detailed = projectDetailMode(baseOptions(claims), "detailed");
    const very = projectDetailMode(baseOptions(claims), "very-detailed");
    expect(very.claims.length).toBe(claims.length);
    expect(very.characterCount).toBeGreaterThanOrEqual(detailed.characterCount);
    expect(very.omittedIndexes).toEqual([]);
    expect(very.omittedPages).toEqual([]);
    expect(very.fullGroundedPages).toEqual([1, 2, 3]);
  });
});

describe("V8-A08 cross-mode invariants", () => {
  it("all modes share the same assembled claim set and full grounded pages", () => {
    const claims = fixtureClaims();
    const all = projectAllDetailModes(baseOptions(claims));
    for (const mode of DETAIL_MODES) {
      expect(all[mode].fullGroundedPages).toEqual([1, 2, 3]);
    }
    // Monotonic information density: concise ⊆ detailed ⊆ very-detailed in chars.
    expect(all.concise.characterCount).toBeLessThanOrEqual(all.detailed.characterCount);
    expect(all.detailed.characterCount).toBeLessThanOrEqual(all["very-detailed"].characterCount);
  });

  it("projection performs no Stage-2 work: pure sync over the same array", () => {
    const claims = fixtureClaims();
    const options = baseOptions(claims);
    // projectAllDetailModes is synchronous (returns value, not a promise):
    // no generation call can occur inside a sync projection.
    const all = projectAllDetailModes(options);
    expect(all.concise.claims.every((c) => claims.includes(c))).toBe(true);
    expect(all.detailed.claims.every((c) => claims.includes(c))).toBe(true);
    expect(all["very-detailed"].claims.every((c) => claims.includes(c))).toBe(true);
  });

  it("omitted information is distinguishable from unavailable source coverage", () => {
    const claims = fixtureClaims();
    const concise = projectDetailMode(baseOptions(claims), "concise");
    // Intentional omission (pages 1-3 have claims but some claims dropped).
    expect(concise.omittedIndexes.length).toBeGreaterThan(0);
    // Source gaps labeled separately: page 4 is image-only, never claimed covered.
    expect(concise.imageOnlyPages).toEqual([4]);
    expect(concise.groundedPages).not.toContain(4);
    expect(concise.evidencelessPages).toEqual([]);
    expect(concise.failedSections).toEqual([]);
    // Contiguous gaps reflect only pages with no DISPLAYED claim (page 4 here).
    expect(concise.contiguousPageGaps).toEqual([[4]]);
  });

  it("evidenceless pages are reported without manufacturing evidence", () => {
    const claims = [groundedClaim("Only page one has evidence.", 1, "chunk-0-e0", 0)];
    const projection = projectDetailMode(
      { claims, sourcePageCount: 3, pagesWithoutText: [] },
      "very-detailed",
    );
    expect(projection.groundedPages).toEqual([1]);
    expect(projection.evidencelessPages).toEqual([2, 3]);
    expect(projection.distinctEvidenceIds).toEqual(["chunk-0-e0"]);
  });

  it("explicit sections drive represented/omitted section reporting", () => {
    const claims = fixtureClaims();
    const sections = [
      { sectionIndex: 0, pageRange: [1], evidenceIds: ["chunk-0-e0", "chunk-0-e1"] },
      { sectionIndex: 1, pageRange: [2], evidenceIds: ["chunk-1-e0", "chunk-1-e1"] },
      { sectionIndex: 2, pageRange: [3], evidenceIds: ["chunk-2-e0"] },
    ] as const;
    const concise = projectDetailMode({ ...baseOptions(claims), sections: [...sections] }, "concise");
    // All three sections still represented by the concise representatives.
    expect(concise.representedSections).toEqual([0, 1, 2]);
    expect(concise.omittedSections).toEqual([]);
  });
});
