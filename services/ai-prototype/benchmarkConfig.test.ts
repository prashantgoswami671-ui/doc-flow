/**
 * Unit tests for the benchmark harness config/coverage helpers
 * (PROTOTYPE / BENCHMARK ONLY).
 */
import { describe, expect, it } from "vitest";
import type { AiContextChunk } from "@/services/ai/types";
import {
  BENCHMARK_CANDIDATE_DTYPE,
  BENCHMARK_CANDIDATE_MODEL_ID,
} from "./constants";
import {
  BENCH_QUALITY_CRITERIA,
  BENCH_TARGET_DEVICE,
  BENCH_TARGET_DTYPE,
  BENCH_TARGET_MODEL_ID,
  assertValidMapReduceConfig,
  assertValidSinglePassConfig,
  createEmptyQualityReview,
  createRunRecordSkeleton,
  describeSlicingCoverage,
  pagesOfChunks,
  selectChunksWithinBudget,
} from "./benchmarkConfig";

function chunk(index: number, page: number, text: string): AiContextChunk {
  return {
    chunkIndex: index,
    pageNumber: page,
    text,
    startOffset: 0,
    endOffset: text.length,
  };
}

describe("selectChunksWithinBudget", () => {
  it("keeps whole chunks while they fit and stops at the first overflow", () => {
    const chunks = [chunk(0, 1, "a".repeat(100)), chunk(1, 2, "b".repeat(100)), chunk(2, 3, "c".repeat(100))];
    const slice = selectChunksWithinBudget(chunks, 250);
    expect(slice.included).toHaveLength(2);
    expect(slice.omitted).toHaveLength(1);
    expect(slice.omitted[0].chunkIndex).toBe(2);
    expect(slice.includedChars).toBe(200);
    expect(slice.omittedChars).toBe(100);
  });

  it("never slices a chunk and never skips past an overflowing chunk", () => {
    const chunks = [chunk(0, 1, "a".repeat(500)), chunk(1, 2, "b".repeat(10))];
    const slice = selectChunksWithinBudget(chunks, 100);
    // First chunk overflows immediately; the small second chunk must NOT
    // be picked up past it (deterministic prefix semantics).
    expect(slice.included).toHaveLength(0);
    expect(slice.omitted).toHaveLength(2);
  });

  it("includes everything when the budget covers the full context", () => {
    const chunks = [chunk(0, 1, "hello"), chunk(1, 2, "world")];
    const slice = selectChunksWithinBudget(chunks, 10);
    expect(slice.included).toHaveLength(2);
    expect(slice.omitted).toHaveLength(0);
    expect(slice.includedChars).toBe(10);
  });

  it("rejects non-positive budgets", () => {
    expect(() => selectChunksWithinBudget([], 0)).toThrow();
    expect(() => selectChunksWithinBudget([], -5)).toThrow();
  });
});

describe("describeSlicingCoverage", () => {
  it("reports included/omitted chunks and omitted pages explicitly", () => {
    const all = [chunk(0, 1, "a".repeat(100)), chunk(1, 2, "b".repeat(100)), chunk(2, 4, "c".repeat(100))];
    const slice = selectChunksWithinBudget(all, 150);
    const coverage = describeSlicingCoverage(all, slice);
    expect(coverage.totalChunks).toBe(3);
    expect(coverage.includedChunks).toBe(1);
    expect(coverage.omittedChunks).toBe(2);
    expect(coverage.omittedPages).toEqual([2, 4]);
    expect(coverage.includedPages).toEqual([1]);
    expect(coverage.omittedChars).toBe(200);
  });
});

describe("pagesOfChunks", () => {
  it("returns sorted unique page numbers", () => {
    const chunks = [chunk(0, 3, "x"), chunk(1, 1, "y"), chunk(2, 3, "z")];
    expect(pagesOfChunks(chunks)).toEqual([1, 3]);
  });
});

describe("config validation", () => {
  it("accepts the documented single-pass budgets and caps", () => {
    for (const budget of [4000, 5000, 6000, 7000, 8000, 8500, 9000, 10000]) {
      for (const cap of [64, 128, 256]) {
        expect(() => assertValidSinglePassConfig({ contextBudgetChars: budget, maxNewTokens: cap })).not.toThrow();
      }
    }
  });

  it("rejects off-list single-pass values", () => {
    expect(() => assertValidSinglePassConfig({ contextBudgetChars: 8192, maxNewTokens: 256 })).toThrow();
    expect(() => assertValidSinglePassConfig({ contextBudgetChars: 4000, maxNewTokens: 512 })).toThrow();
  });

  it("accepts batch sizes 2/3/4/6 with Map caps 64/128/256", () => {
    for (const batchSize of [2, 3, 4, 6]) {
      expect(() =>
        assertValidMapReduceConfig({ batchSize, mapMaxNewTokens: 64, reduceMaxNewTokens: 256 }),
      ).not.toThrow();
    }
  });

  it("rejects off-list batch sizes and caps", () => {
    expect(() => assertValidMapReduceConfig({ batchSize: 5, mapMaxNewTokens: 64, reduceMaxNewTokens: 256 })).toThrow();
    expect(() => assertValidMapReduceConfig({ batchSize: 3, mapMaxNewTokens: 32, reduceMaxNewTokens: 256 })).toThrow();
    expect(() => assertValidMapReduceConfig({ batchSize: 3, mapMaxNewTokens: 64, reduceMaxNewTokens: 0 })).toThrow();
  });
});

describe("run record skeleton", () => {
  it("records configuration deterministically with an unreviewed quality checklist", () => {
    const record = createRunRecordSkeleton({
      runId: "bench-test-1",
      startedAtIso: "2026-09-03T00:00:00.000Z",
      mode: "map-reduce",
      source: { kind: "uploaded", filename: "real.pdf", fileSizeBytes: 123 },
      device: BENCH_TARGET_DEVICE,
      modelId: BENCH_TARGET_MODEL_ID,
      dtype: BENCH_TARGET_DTYPE,
      browserLabel: "Brave",
      coldWarm: "cold",
    });
    expect(record.runId).toBe("bench-test-1");
    expect(record.mode).toBe("map-reduce");
    expect(record.source).toEqual({ kind: "uploaded", filename: "real.pdf", fileSizeBytes: 123 });
    expect(record.device).toBe(BENCH_TARGET_DEVICE);
    expect(record.modelId).toBe(BENCHMARK_CANDIDATE_MODEL_ID);
    expect(record.dtype).toBe(BENCHMARK_CANDIDATE_DTYPE);
    expect(record.modelId).toBe(BENCH_TARGET_MODEL_ID);
    expect(record.dtype).toBe(BENCH_TARGET_DTYPE);
    expect(record.success).toBe(false);
    expect(record.quality).toHaveLength(BENCH_QUALITY_CRITERIA.length);
    expect(record.quality.every((q) => q.status === "unreviewed" && q.note === "")).toBe(true);
  });

  it("creates an empty quality review covering every criterion", () => {
    const review = createEmptyQualityReview();
    expect(review).toHaveLength(10);
    expect(review.map((r) => r.criterionId)).toEqual(BENCH_QUALITY_CRITERIA.map((c) => c.id));
  });
});
