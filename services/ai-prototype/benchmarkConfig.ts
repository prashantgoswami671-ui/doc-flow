/**
 * Brave Benchmark Harness — configuration, coverage, and result-record
 * helpers (PROTOTYPE / BENCHMARK ONLY).
 *
 * Pure, dependency-free, synchronous. No Worker, no model, no PDF.js, no
 * network, no DOM. Safe to unit-test in Node.
 *
 * This module defines the controlled benchmark parameter sets
 * (context budgets, output caps, batch sizes, synthetic sizes), the
 * deterministic whole-chunk budget slicer used by the single-pass
 * benchmark, coverage describers, and the structured run-record shape
 * the harness exports for paste-into-ChatGPT reporting.
 *
 * It deliberately does NOT import production runtime code
 * (`services/ai/browser/*`) — benchmark-only logic stays decoupled from
 * production. It only uses the shared `AiContextChunk` shape from AI-01.
 */

import type { AiContextChunk } from "@/services/ai/types";
import {
  BENCHMARK_CANDIDATE_DTYPE,
  BENCHMARK_CANDIDATE_MODEL_ID,
} from "./constants";

/** Benchmark target — mirrors the pinned benchmark candidate, never production. */
export const BENCH_TARGET_MODEL_ID = BENCHMARK_CANDIDATE_MODEL_ID;
export const BENCH_TARGET_DTYPE = BENCHMARK_CANDIDATE_DTYPE;
export const BENCH_TARGET_DEVICE = "wasm" as const;
export const BENCH_TRANSFORMERS_VERSION = "4.2.0";

/** Single-pass experimental context budgets (raw characters). Prototype-only — never touches the production 8192 cap. */
export const BENCH_SINGLE_PASS_CONTEXT_BUDGETS = [
  4000, 5000, 6000, 7000, 8000, 8500, 9000, 10000,
] as const;
export type BenchContextBudget =
  (typeof BENCH_SINGLE_PASS_CONTEXT_BUDGETS)[number];

/** Generation output caps (max_new_tokens). */
export const BENCH_OUTPUT_CAPS = [64, 128, 256] as const;
export type BenchOutputCap = (typeof BENCH_OUTPUT_CAPS)[number];

/** Map batch sizes (source chunks grouped into one Map generation — sequential, not parallel). */
export const BENCH_BATCH_SIZES = [1, 2, 3, 4, 6] as const;
export type BenchBatchSize = (typeof BENCH_BATCH_SIZES)[number];

/** Synthetic fixture page counts. */
export const BENCH_SYNTHETIC_PAGE_COUNTS = [1, 5, 10, 20, 40, 41, 50] as const;
export type BenchSyntheticPageCount =
  (typeof BENCH_SYNTHETIC_PAGE_COUNTS)[number];

/** Reduce-stage default output cap. The harness may configure Reduce too, but never below this without an explicit user choice. */
export const BENCH_REDUCE_DEFAULT_CAP: BenchOutputCap = 256;

export type BenchmarkMode = "single-pass" | "map-reduce";

export type BenchmarkDocSource =
  | { kind: "synthetic"; pageCount: number }
  | { kind: "uploaded"; filename: string; fileSizeBytes: number };

export interface SinglePassBenchmarkConfig {
  contextBudgetChars: number;
  maxNewTokens: number;
}

export interface MapReduceBenchmarkConfig {
  batchSize: number;
  mapMaxNewTokens: number;
  reduceMaxNewTokens: number;
}

export type ColdWarm = "cold" | "warm";

/** Qualitative review criteria (checklist, NOT a score). */
export const BENCH_QUALITY_CRITERIA = [
  { id: "topics", label: "Major topics preserved" },
  { id: "conclusions", label: "Main conclusions preserved" },
  { id: "numbers", label: "Important numbers/statistics preserved" },
  { id: "coverage", label: "Beginning/middle/end coverage" },
  { id: "caveats", label: "Important caveats/qualifications preserved" },
  { id: "chronology", label: "Chronology/order where relevant" },
  { id: "terminology", label: "Key terminology preserved" },
  { id: "hallucination", label: "No hallucination/unsupported claims" },
  { id: "omissions", label: "No important omissions" },
  { id: "duplication", label: "No excessive duplication" },
] as const;
export type BenchQualityCriterionId =
  (typeof BENCH_QUALITY_CRITERIA)[number]["id"];
export type BenchQualityStatus =
  | "unreviewed"
  | "yes"
  | "partial"
  | "no"
  | "n/a";

export interface BenchQualityEntry {
  criterionId: BenchQualityCriterionId;
  status: BenchQualityStatus;
  note: string;
}

export function createEmptyQualityReview(): BenchQualityEntry[] {
  return BENCH_QUALITY_CRITERIA.map((c) => ({
    criterionId: c.id,
    status: "unreviewed" as const,
    note: "",
  }));
}

/**
 * Structured per-run record — the paste-into-ChatGPT export shape.
 * All timings in milliseconds. Token counts are null when the worker
 * diagnostic did not provide them (never fabricated).
 */
export interface BenchmarkRunRecord {
  runId: string;
  startedAtIso: string;
  mode: BenchmarkMode;
  source: BenchmarkDocSource;
  device: string;
  modelId: string;
  dtype: string;
  browserLabel: string;
  coldWarm: ColdWarm;
  pages: number | null;
  extractedCharacters: number;
  chunks: number;
  pagesWithoutText: number[];
  ai02Truncated: boolean;
  extractionMs: number;
  initializationMs: number | null;
  // Single-pass fields (null for map-reduce).
  contextBudgetChars: number | null;
  actualContextChars: number | null;
  requestedMaxNewTokens: number | null;
  inputTokens: number | null;
  generatedTokens: number | null;
  // Map->Reduce fields (null/zero for single-pass).
  batchSize: number | null;
  mapMaxNewTokens: number | null;
  reduceMaxNewTokens: number | null;
  mapCalls: number;
  reduceCalls: number;
  totalCalls: number;
  mapInputTokensTotal: number | null;
  reduceInputTokens: number | null;
  mapGeneratedTokensTotal: number | null;
  reduceGeneratedTokens: number | null;
  mapMsTotal: number;
  reduceMs: number;
  inferenceMsTotal: number;
  attemptedChunks: number;
  completedChunks: number;
  failedChunks: number;
  failedBatchIndexes: number[];
  completedBatchIndexes: number[];
  pagesRepresented: number[];
  omittedPages: number[];
  outputCharacters: number;
  truncated: boolean;
  cancelled: boolean;
  cancelRequestedAtIso: string | null;
  cancelObservedMs: number | null;
  runtimeReusableAfterCancel: boolean | null;
  partial: boolean;
  success: boolean;
  error: string | null;
  visibilityAtStart: string | null;
  visibilityAtEnd: string | null;
  visibilityChangesDuringRun: number;
  // Inspectable outputs (never scored automatically).
  summary: string | null;
  mapSummaries: string[] | null;
  quality: BenchQualityEntry[];
}

export function createRunRecordSkeleton(options: {
  runId: string;
  startedAtIso: string;
  mode: BenchmarkMode;
  source: BenchmarkDocSource;
  device: string;
  modelId: string;
  dtype: string;
  browserLabel: string;
  coldWarm: ColdWarm;
}): BenchmarkRunRecord {
  return {
    runId: options.runId,
    startedAtIso: options.startedAtIso,
    mode: options.mode,
    source: options.source,
    device: options.device,
    modelId: options.modelId,
    dtype: options.dtype,
    browserLabel: options.browserLabel,
    coldWarm: options.coldWarm,
    pages: null,
    extractedCharacters: 0,
    chunks: 0,
    pagesWithoutText: [],
    ai02Truncated: false,
    extractionMs: 0,
    initializationMs: null,
    contextBudgetChars: null,
    actualContextChars: null,
    requestedMaxNewTokens: null,
    inputTokens: null,
    generatedTokens: null,
    batchSize: null,
    mapMaxNewTokens: null,
    reduceMaxNewTokens: null,
    mapCalls: 0,
    reduceCalls: 0,
    totalCalls: 0,
    mapInputTokensTotal: null,
    reduceInputTokens: null,
    mapGeneratedTokensTotal: null,
    reduceGeneratedTokens: null,
    mapMsTotal: 0,
    reduceMs: 0,
    inferenceMsTotal: 0,
    attemptedChunks: 0,
    completedChunks: 0,
    failedChunks: 0,
    failedBatchIndexes: [],
    completedBatchIndexes: [],
    pagesRepresented: [],
    omittedPages: [],
    outputCharacters: 0,
    truncated: false,
    cancelled: false,
    cancelRequestedAtIso: null,
    cancelObservedMs: null,
    runtimeReusableAfterCancel: null,
    partial: false,
    success: false,
    error: null,
    visibilityAtStart: null,
    visibilityAtEnd: null,
    visibilityChangesDuringRun: 0,
    summary: null,
    mapSummaries: null,
    quality: createEmptyQualityReview(),
  };
}

export interface ChunkBudgetSlice {
  included: AiContextChunk[];
  omitted: AiContextChunk[];
  includedChars: number;
  omittedChars: number;
}

/**
 * Deterministically bounds chunks to a raw-character budget: keeps whole
 * chunks in the given order while they fit, stops at the first chunk that
 * would overflow, never slices a chunk. Same semantics as production
 * `boundContextChunks` (kept local so the prototype never imports the
 * production runtime module).
 */
export function selectChunksWithinBudget(
  chunks: AiContextChunk[],
  budgetChars: number,
): ChunkBudgetSlice {
  if (!Number.isSafeInteger(budgetChars) || budgetChars < 1) {
    throw new Error("budgetChars must be a positive integer.");
  }
  const included: AiContextChunk[] = [];
  const omitted: AiContextChunk[] = [];
  let includedChars = 0;
  let omittedChars = 0;
  let overflowing = false;
  for (const chunk of chunks) {
    if (!overflowing && includedChars + chunk.text.length <= budgetChars) {
      included.push(chunk);
      includedChars += chunk.text.length;
    } else {
      overflowing = true;
      omitted.push(chunk);
      omittedChars += chunk.text.length;
    }
  }
  return { included, omitted, includedChars, omittedChars };
}

export interface SlicingCoverage {
  totalChunks: number;
  includedChunks: number;
  omittedChunks: number;
  includedChars: number;
  omittedChars: number;
  /** Sorted unique 1-based page numbers with no included text. */
  omittedPages: number[];
  /** Sorted unique 1-based page numbers with at least one included chunk. */
  includedPages: number[];
}

/** Derives single-pass coverage from a budget slice — nothing is silently dropped. */
export function describeSlicingCoverage(
  allChunks: AiContextChunk[],
  slice: ChunkBudgetSlice,
): SlicingCoverage {
  const includedPages = new Set<number>();
  for (const chunk of slice.included) includedPages.add(chunk.pageNumber);
  const allPages = new Set<number>();
  for (const chunk of allChunks) allPages.add(chunk.pageNumber);
  const omittedPages = [...allPages]
    .filter((p) => !includedPages.has(p))
    .sort((a, b) => a - b);
  return {
    totalChunks: allChunks.length,
    includedChunks: slice.included.length,
    omittedChunks: slice.omitted.length,
    includedChars: slice.includedChars,
    omittedChars: slice.omittedChars,
    omittedPages,
    includedPages: [...includedPages].sort((a, b) => a - b),
  };
}

/** Sorted unique 1-based page numbers represented by the given chunks. */
export function pagesOfChunks(chunks: AiContextChunk[]): number[] {
  return [...new Set(chunks.map((c) => c.pageNumber))].sort((a, b) => a - b);
}

export function assertValidSinglePassConfig(
  config: SinglePassBenchmarkConfig,
): void {
  if (
    !BENCH_SINGLE_PASS_CONTEXT_BUDGETS.includes(
      config.contextBudgetChars as BenchContextBudget,
    )
  ) {
    throw new Error(
      `contextBudgetChars must be one of ${BENCH_SINGLE_PASS_CONTEXT_BUDGETS.join(", ")}.`,
    );
  }
  if (!BENCH_OUTPUT_CAPS.includes(config.maxNewTokens as BenchOutputCap)) {
    throw new Error(
      `maxNewTokens must be one of ${BENCH_OUTPUT_CAPS.join(", ")}.`,
    );
  }
}

export function assertValidMapReduceConfig(
  config: MapReduceBenchmarkConfig,
): void {
  if (!BENCH_BATCH_SIZES.includes(config.batchSize as BenchBatchSize)) {
    throw new Error(
      `batchSize must be one of ${BENCH_BATCH_SIZES.join(", ")}.`,
    );
  }
  if (!BENCH_OUTPUT_CAPS.includes(config.mapMaxNewTokens as BenchOutputCap)) {
    throw new Error(
      `mapMaxNewTokens must be one of ${BENCH_OUTPUT_CAPS.join(", ")}.`,
    );
  }
  if (
    !Number.isSafeInteger(config.reduceMaxNewTokens) ||
    config.reduceMaxNewTokens < 1
  ) {
    throw new Error("reduceMaxNewTokens must be a positive integer.");
  }
}
