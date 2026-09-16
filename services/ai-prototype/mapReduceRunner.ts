/**
 * Checkpoint 2A/2B — sequential Map -> Reduce experiment (PROTOTYPE ONLY).
 *
 * This file does NOT construct a Worker and does NOT call
 * `client.initModel()` — the caller (app/test/browser-ai/page.tsx) is
 * responsible for creating and initializing a `BrowserAiWorkerClient`
 * exactly as the existing single-shot path already does, then passing
 * the already-ready client in here. This file only sequences multiple
 * `client.generate()` calls differently: instead of one prompt
 * containing the entire document, it issues one generation per bounded
 * batch of AI-02 chunks ("Map"), then one final generation over the
 * resulting intermediate summaries ("Reduce").
 *
 * Session reuse: `client` wraps a single Worker instance, and the
 * Worker's `generator` (see browserAiWorker.ts) is a module-level
 * variable set once by `init` and read by every subsequent `generate`
 * message — nothing here or in browserAiWorkerClient.ts tears the
 * Worker/model down between calls, so every Map batch and the Reduce
 * call all run through the SAME already-initialized Qwen session. This
 * file does not change that lifecycle; it only calls `generate()`
 * multiple times against it.
 *
 * Memory note (do not overstate what is actually known): calling
 * `client.generate()` again after a prior call completes reuses the
 * existing ONNX Runtime/WASM session and its allocator — it does not
 * reinitialize the model. Each individual generation's own
 * tensors/request objects go out of scope in JS after that call
 * resolves (ordinary JS garbage collection), but garbage collection does
 * NOT prove the underlying WASM linear-memory allocator has released
 * that memory back to the OS/browser — ONNX Runtime Web's WASM backend
 * manages its own heap inside the WASM instance's memory, and this
 * prototype does not (and, from JS, largely cannot) inspect or force
 * that allocator's internal state. Any conclusion about whether
 * per-generation memory is actually being reclaimed between Map batches
 * must come from observing whether the sequence of batches in this
 * experiment succeeds or fails, not from an assumption that
 * "the same session" implies "memory is fully reclaimed every call."
 *
 * Cancellation: reuses the existing `client.cancel(requestId)` /
 * `InterruptableStoppingCriteria` mechanism as-is — a cancellation
 * during a Map batch or during Reduce is detected via
 * `GenerateResult.cancelled` on that in-flight call. A cancellation
 * requested BETWEEN batches (no generation in flight) is detected via
 * the caller-supplied `isCancelled()` callback, checked before every new
 * batch and before Reduce — this file does not invent a second
 * cancellation architecture.
 */

import type { AiContextChunk } from "@/services/ai/types";
import type { BrowserAiWorkerClient, GenerateResult } from "./browserAiWorkerClient";
import {
  buildMapSummarizePrompt,
  buildReducePrompt,
  type ChatMessage,
  type ReduceSourceEvidence,
} from "./promptBuilder";
import {
  buildEvidenceLedger,
} from "./evidenceLedger";

/**
 * Reduce Limited Source Grounding experiment (PROTOTYPE ONLY, additive).
 *
 * Bounds for the compact excerpt handed to Reduce as source evidence —
 * see `extractSourceEvidence` below. Deliberately small (a per-project
 * choice, not derived from anything else in this file) so a single
 * Reduce call's input grows by roughly 1.2–1.3x rather than reintroducing
 * a full chunk's worth of text (see the experiment's inspection report,
 * §C/§E, for the tradeoff this was chosen against).
 */
const SOURCE_EVIDENCE_EXCERPT_TARGET_LENGTH = 200;
const SOURCE_EVIDENCE_EXCERPT_MAX_LENGTH = 250;

function isAsciiDigit(char: string): boolean {
  return char >= "0" && char <= "9";
}

function countDigits(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (isAsciiDigit(text[i])) count += 1;
  }
  return count;
}

/**
 * Deterministic source-evidence chunk selector (Reduce Limited Source
 * Grounding experiment, §D/strategy #4 of the inspection report): scores
 * each chunk by its raw digit-character count — a simple, zero-dependency
 * proxy for "this chunk is numerically dense," not a semantic ranking.
 * Ties break to the lowest `chunkIndex` so the result never depends on
 * input array order. Returns null only for an empty chunk list.
 */
export function selectNumericDensityChunk(chunks: AiContextChunk[]): AiContextChunk | null {
  let best: AiContextChunk | null = null;
  let bestScore = -1;
  for (const chunk of chunks) {
    const score = countDigits(chunk.text);
    if (best === null || score > bestScore || (score === bestScore && chunk.chunkIndex < best.chunkIndex)) {
      best = chunk;
      bestScore = score;
    }
  }
  return best;
}

/**
 * Finds the start index of the `windowSize`-character window with the
 * highest digit-character count in `text`, via an incremental (O(n))
 * sliding-window scan. Ties break to the earliest (lowest) start index.
 * Assumes `text.length > windowSize` — callers only invoke this after
 * checking the short-text case (see `extractSourceEvidence`).
 */
function findDensestDigitWindowStart(text: string, windowSize: number): number {
  let currentCount = 0;
  for (let i = 0; i < windowSize; i += 1) {
    if (isAsciiDigit(text[i])) currentCount += 1;
  }

  let bestStart = 0;
  let bestCount = currentCount;
  for (let start = 1; start + windowSize <= text.length; start += 1) {
    if (isAsciiDigit(text[start - 1])) currentCount -= 1;
    if (isAsciiDigit(text[start + windowSize - 1])) currentCount += 1;
    if (currentCount > bestCount) {
      bestCount = currentCount;
      bestStart = start;
    }
  }
  return bestStart;
}

/**
 * Extracts a compact, verbatim excerpt (Reduce Limited Source Grounding
 * experiment, §E/§G) from a selected chunk: a bounded window around its
 * densest numeric region, sized to roughly
 * `SOURCE_EVIDENCE_EXCERPT_TARGET_LENGTH` characters (well within the
 * 150–250 target). If the chunk is already at or under the max length,
 * the whole chunk is used unmodified rather than windowing it — there is
 * nothing to trim. The excerpt is always an exact substring of the
 * original chunk text (no summarization/paraphrasing), per the task's
 * "do not alter or paraphrase the source text" requirement.
 */
export function extractSourceEvidence(chunk: AiContextChunk): ReduceSourceEvidence {
  const { text, pageNumber } = chunk;
  if (text.length <= SOURCE_EVIDENCE_EXCERPT_MAX_LENGTH) {
    return { pageNumber, text };
  }

  const windowSize = SOURCE_EVIDENCE_EXCERPT_TARGET_LENGTH;
  const start = findDensestDigitWindowStart(text, windowSize);
  const excerpt = text.slice(start, start + windowSize);
  return { pageNumber, text: excerpt };
}

export type MapReduceStage = "map" | "reduce";

/** One row of diagnostics per generation (Map batch or Reduce), in the order generations actually ran. */
export interface MapReduceDiagnosticEntry {
  stage: MapReduceStage;
  /** 1-based count of this generation across the whole run (Map batches then Reduce). */
  generationNumber: number;
  /** Zero-based Map batch index, or null for the Reduce generation. */
  batchIndex: number | null;
  /** Total Map batch count, or null for the Reduce generation. */
  batchCount: number | null;
  /** Chunks in this Map batch, or null for the Reduce generation. */
  chunksInBatch: number | null;
  /** Approximate input character count for this generation's prompt content (document chunk text for Map, concatenated intermediate summaries for Reduce). NOT a token count — see the module doc comment on characters vs. tokens. */
  inputCharacters: number;
  /** The max_new_tokens value actually requested for this generation (Map cap vs. Reduce cap). */
  requestedMaxNewTokens: number;
  inferenceMs: number;
  /** From the worker's own diagnostic, when available (see workerProtocol.ts). Null if the generation errored before a diagnostic was produced. */
  generatedTokenCount: number | null;
  /** From the worker's own diagnostic, when available (see workerProtocol.ts). Null if the generation errored before a diagnostic was produced, or if diagnostic tokenization itself failed. */
  inputTokenCount: number | null;
  outputCharacters: number;
  cancelled: boolean;
  error: string | null;
}

export interface MapReduceProgressEvent {
  stage: MapReduceStage;
  batchIndex: number | null;
  batchCount: number | null;
}

export interface RunMapReduceOptions {
  /** Must already be initialized (initModel() already resolved) — see module doc comment. */
  client: BrowserAiWorkerClient;
  /** Full ordered chunk list for the document (e.g. from buildAiTextContext()). */
  chunks: AiContextChunk[];
  /** Conservative: prefer 2–4 AI-02 chunks per Map batch (see checkpoint spec). */
  batchSize: number;
  /** Generation limit for the Reduce-stage call. Also used for Map-stage calls when `mapMaxNewTokens` is omitted — i.e. omitting `mapMaxNewTokens` reproduces the exact prior single-value behavior. */
  maxNewTokens: number;
  /** Optional, additive: generation limit for Map-stage calls only (Experiment 4 — Map output-length control). Defaults to `maxNewTokens` when omitted, so existing callers/experiments that don't set this see no behavior change. Reduce always uses `reduceMaxNewTokens ?? maxNewTokens`, never this value. */
  mapMaxNewTokens?: number;
  /**
   * Optional, additive (benchmark harness): generation limit for the
   * Reduce-stage call. Defaults to `maxNewTokens` when omitted, so
   * existing callers see no behavior change. The benchmark harness sets
   * this explicitly so Map and Reduce caps are recorded independently.
   */
  reduceMaxNewTokens?: number;
  /**
   * Optional, additive (benchmark harness): when true, a failed Map-batch
   * generation is recorded (diagnostics + `failedBatchIndexes`) and the
   * run continues with the remaining batches instead of throwing, so a
   * partially-completed benchmark still yields coverage and a Reduce over
   * the successful batches. Defaults to false, which preserves the exact
   * prior behavior (throw on the first non-cancellation generation
   * error). Reduce-stage failures always throw `MapReduceRunError` —
   * a single Reduce call cannot be "continued".
   */
  continueOnMapError?: boolean;
  hasPagesWithoutText: boolean;
  wasTruncated: boolean;
  onProgress?: (event: MapReduceProgressEvent) => void;
  onDiagnostic?: (entry: MapReduceDiagnosticEntry) => void;
  /** Called with the requestId of whichever generation is currently in flight (or null when none is), so the caller's existing cancel button can target it — mirrors the single-shot path's activeRequestId. */
  onActiveRequestId?: (requestId: string | null) => void;
  /** Checked before starting every new batch and before Reduce, so a cancellation requested between generations still stops the run without starting another one. */
  isCancelled?: () => boolean;
  /**
   * Optional, additive (Worker lifecycle reset experiment): when
   * provided, called to obtain a freshly-initialized `BrowserAiWorkerClient`
   * after each Map batch's generation has fully settled, and once more
   * after the Map loop finishes and before Reduce. The returned client
   * replaces the one used for all subsequent calls. Never invoked while
   * a `generate()` call is in flight — see the module doc comment on
   * `BrowserAiWorkerClient.terminate()` not settling pending promises.
   * Omitting this preserves the exact prior single-session behavior.
   */
  resetClient?: () => Promise<BrowserAiWorkerClient>;
}

export interface RunMapReduceResult {
  finalSummary: string | null;
  cancelled: boolean;
  /** Map-stage outputs, in batch order. Populated even if the run is later cancelled during Reduce. */
  intermediateSummaries: string[];
  /** Zero-based Map batch indexes that completed, in batch order. Aligns 1:1 with `intermediateSummaries` (entry N came from batch `completedBatchIndexes[N]`). */
  completedBatchIndexes: number[];
  /** Zero-based Map batch indexes whose generation failed (only non-empty when `continueOnMapError` is true). */
  failedBatchIndexes: number[];
  /** Chunk/batch/page coverage for this run — nothing is silently omitted. */
  coverage: MapReduceCoverage;
  /** Every generation attempted, in run order — includes a cancelled/errored final entry if applicable. */
  diagnostics: MapReduceDiagnosticEntry[];
  totalElapsedMs: number;
  /** False when cancelled, when any Map batch failed, or when Reduce failed. */
  success: boolean;
  /** True when at least one Map batch completed but the run did not fully succeed. */
  partial: boolean;
  /** Reduce-stage error message when Reduce itself failed (null otherwise). */
  reduceError: string | null;
}

/** Chunk/batch/page coverage for a Map -> Reduce run. */
export interface MapReduceCoverage {
  totalChunks: number;
  /** Chunks in batches that were started (completed + failed). Batches never started (e.g. cancelled before them) are excluded. */
  attemptedChunks: number;
  completedChunks: number;
  failedChunks: number;
  batchesAttempted: number;
  batchesCompleted: number;
  batchesFailed: number;
  /** Sorted unique 1-based page numbers represented by completed Map batches. */
  pagesRepresented: number[];
}

/**
 * Thrown (instead of the raw generation error) when a Map batch fails
 * with `continueOnMapError: false`, or when Reduce fails. Carries the
 * partial run data so the benchmark harness can record a FAILED run
 * with full coverage instead of losing everything to a bare throw.
 * The original error is preserved as `cause`.
 */
export class MapReduceRunError extends Error {
  readonly stage: MapReduceStage;
  readonly diagnostics: MapReduceDiagnosticEntry[];
  readonly intermediateSummaries: string[];
  readonly completedBatchIndexes: number[];
  readonly failedBatchIndexes: number[];
  readonly coverage: MapReduceCoverage;

  constructor(
    stage: MapReduceStage,
    message: string,
    partial: {
      diagnostics: MapReduceDiagnosticEntry[];
      intermediateSummaries: string[];
      completedBatchIndexes: number[];
      failedBatchIndexes: number[];
      coverage: MapReduceCoverage;
    },
    options?: { cause?: unknown },
  ) {
    super(message);
    this.name = "MapReduceRunError";
    this.stage = stage;
    this.diagnostics = partial.diagnostics;
    this.intermediateSummaries = partial.intermediateSummaries;
    this.completedBatchIndexes = partial.completedBatchIndexes;
    this.failedBatchIndexes = partial.failedBatchIndexes;
    this.coverage = partial.coverage;
    if (options && "cause" in options) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

function batchChunks(chunks: AiContextChunk[], batchSize: number): AiContextChunk[][] {
  const batches: AiContextChunk[][] = [];
  for (let start = 0; start < chunks.length; start += batchSize) {
    batches.push(chunks.slice(start, start + batchSize));
  }
  return batches;
}

function sumCharacters(values: string[]): number {
  return values.reduce((total, value) => total + value.length, 0);
}

/** Builds chunk/batch/page coverage from the batches and the started-batch indexes. Batches never started are excluded from attempted counts. */
export function buildCoverage(
  batches: AiContextChunk[][],
  completedBatchIndexes: number[],
  failedBatchIndexes: number[],
): MapReduceCoverage {
  const completed = new Set(completedBatchIndexes);
  const failed = new Set(failedBatchIndexes);
  let attemptedChunks = 0;
  let completedChunks = 0;
  let failedChunks = 0;
  const pages = new Set<number>();

  batches.forEach((batch, batchIndex) => {
    if (completed.has(batchIndex)) {
      attemptedChunks += batch.length;
      completedChunks += batch.length;
      for (const chunk of batch) pages.add(chunk.pageNumber);
    } else if (failed.has(batchIndex)) {
      attemptedChunks += batch.length;
      failedChunks += batch.length;
    }
  });

  return {
    totalChunks: batches.reduce((total, batch) => total + batch.length, 0),
    attemptedChunks,
    completedChunks,
    failedChunks,
    batchesAttempted: completed.size + failed.size,
    batchesCompleted: completed.size,
    batchesFailed: failed.size,
    pagesRepresented: [...pages].sort((a, b) => a - b),
  };
}

/** A cancelled/pre-cancelled result shape, factored out so every early-return site stays consistent. */
function cancelledResult(
  batches: AiContextChunk[][],
  intermediateSummaries: string[],
  completedBatchIndexes: number[],
  failedBatchIndexes: number[],
  diagnostics: MapReduceDiagnosticEntry[],
  overallStart: number,
): RunMapReduceResult {
  return {
    finalSummary: null,
    cancelled: true,
    intermediateSummaries,
    completedBatchIndexes,
    failedBatchIndexes,
    coverage: buildCoverage(batches, completedBatchIndexes, failedBatchIndexes),
    diagnostics,
    totalElapsedMs: performance.now() - overallStart,
    success: false,
    partial: completedBatchIndexes.length > 0,
    reduceError: null,
  };
}

/**
 * Runs one sequential Map -> Reduce pass. Does not catch/report to a UI
 * itself — by default (continueOnMapError: false) it throws a
 * `MapReduceRunError` on a non-cancellation generation error, carrying
 * the partial diagnostics/summaries/coverage so the caller can record a
 * FAILED benchmark instead of losing everything. With
 * `continueOnMapError: true`, failed Map batches are recorded and the
 * run continues, yielding a PARTIAL result.
 */
export async function runMapReduceSummarize(
  options: RunMapReduceOptions,
): Promise<RunMapReduceResult> {
  const {
    chunks,
    batchSize,
    maxNewTokens,
    mapMaxNewTokens,
    reduceMaxNewTokens,
    continueOnMapError = false,
    hasPagesWithoutText,
    wasTruncated,
    onProgress,
    onDiagnostic,
    onActiveRequestId,
    isCancelled,
    resetClient,
  } = options;
  // Mutable so `resetClient` (below) can swap in a freshly-initialized
  // client mid-run — `runOneGeneration` reads this via closure, so
  // reassigning it here is picked up by every subsequent call.
  let client = options.client;

  if (chunks.length === 0) {
    throw new Error("No chunks to run Map -> Reduce over.");
  }
  if (!Number.isSafeInteger(batchSize) || batchSize < 1) {
    throw new Error("batchSize must be a positive integer.");
  }

  const overallStart = performance.now();
  const batches = batchChunks(chunks, batchSize);
  const batchCount = batches.length;
  const diagnostics: MapReduceDiagnosticEntry[] = [];
  const intermediateSummaries: string[] = [];
  const completedBatchIndexes: number[] = [];
  const failedBatchIndexes: number[] = [];
  let generationNumber = 0;

  function partialSnapshot(): {
    diagnostics: MapReduceDiagnosticEntry[];
    intermediateSummaries: string[];
    completedBatchIndexes: number[];
    failedBatchIndexes: number[];
    coverage: MapReduceCoverage;
  } {
    return {
      diagnostics: [...diagnostics],
      intermediateSummaries: [...intermediateSummaries],
      completedBatchIndexes: [...completedBatchIndexes],
      failedBatchIndexes: [...failedBatchIndexes],
      coverage: buildCoverage(batches, completedBatchIndexes, failedBatchIndexes),
    };
  }

  async function runOneGeneration(
    stage: MapReduceStage,
    batchIndex: number | null,
    inputCharacters: number,
    messages: ChatMessage[],
    maxNewTokensForThisCall: number,
  ): Promise<GenerateResult> {
    generationNumber += 1;
    // Measured around client.generate() (not just the happy path) so a
    // rejection's diagnostic entry reflects real elapsed time instead of
    // an assumed 0 — see the Batch 4 diagnosis: inferenceMs: 0 on failure
    // previously meant "we didn't measure it", not "it failed instantly".
    const generationStart = performance.now();
    const { requestId, result } = client.generate(messages, maxNewTokensForThisCall);
    onActiveRequestId?.(requestId);

    let generation: GenerateResult;
    try {
      generation = await result;
    } catch (error) {
      diagnostics.push({
        stage,
        generationNumber,
        batchIndex,
        batchCount: stage === "map" ? batchCount : null,
        chunksInBatch: batchIndex !== null ? batches[batchIndex].length : null,
        inputCharacters,
        requestedMaxNewTokens: maxNewTokensForThisCall,
        inferenceMs: performance.now() - generationStart,
        generatedTokenCount: null,
        inputTokenCount: null,
        outputCharacters: 0,
        cancelled: false,
        error: error instanceof Error ? error.message : String(error),
      });
      onDiagnostic?.(diagnostics[diagnostics.length - 1]);
      throw error;
    } finally {
      onActiveRequestId?.(null);
    }

    diagnostics.push({
      stage,
      generationNumber,
      batchIndex,
      batchCount: stage === "map" ? batchCount : null,
      chunksInBatch: batchIndex !== null ? batches[batchIndex].length : null,
      inputCharacters,
      requestedMaxNewTokens: maxNewTokensForThisCall,
      inferenceMs: generation.inferenceMs,
      generatedTokenCount: generation.diagnostic?.generatedTokenCount ?? null,
      inputTokenCount: generation.diagnostic?.inputTokenCount ?? null,
      outputCharacters: generation.outputCharacters,
      cancelled: generation.cancelled,
      error: null,
    });
    onDiagnostic?.(diagnostics[diagnostics.length - 1]);

    return generation;
  }

  // ---- Map stage ----
  for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
    if (isCancelled?.()) {
      return cancelledResult(
        batches,
        intermediateSummaries,
        completedBatchIndexes,
        failedBatchIndexes,
        diagnostics,
        overallStart,
      );
    }

    const batch = batches[batchIndex];
    const inputCharacters = sumCharacters(batch.map((c) => c.text));
    onProgress?.({ stage: "map", batchIndex, batchCount });

    const messages = buildMapSummarizePrompt({
      chunks: batch,
      batchIndex,
      batchCount,
      hasPagesWithoutText,
      wasTruncated,
    });

    let generation: GenerateResult;
    try {
      generation = await runOneGeneration(
        "map",
        batchIndex,
        inputCharacters,
        messages,
        mapMaxNewTokens ?? maxNewTokens,
      );
    } catch (error) {
      if (!continueOnMapError) {
        const message =
          error instanceof Error ? error.message : String(error);
        // Record the attempted batch as failed before throwing so the
        // error's coverage reflects the attempt (nothing silently lost).
        failedBatchIndexes.push(batchIndex);
        throw new MapReduceRunError(
          "map",
          `Map batch ${batchIndex + 1}/${batchCount} failed: ${message}`,
          partialSnapshot(),
          { cause: error },
        );
      }
      // Benchmark mode: record the failed batch and continue — the final
      // result is marked PARTIAL/FAILED, never silently complete.
      failedBatchIndexes.push(batchIndex);
      // Reset experiment: the rejected generate() call above has already
      // fully settled (its promise resolved to a rejection) before this
      // line runs, so this can never race an in-flight generate().
      if (resetClient) {
        client = await resetClient();
      }
      continue;
    }

    if (generation.cancelled) {
      return cancelledResult(
        batches,
        intermediateSummaries,
        completedBatchIndexes,
        failedBatchIndexes,
        diagnostics,
        overallStart,
      );
    }

    intermediateSummaries.push(generation.text);
    completedBatchIndexes.push(batchIndex);

    // Reset experiment: `generation` above is the already-resolved
    // result of `await runOneGeneration(...)`, so no generate() call is
    // in flight when this runs.
    if (resetClient) {
      client = await resetClient();
    }
  }

  if (isCancelled?.()) {
    return cancelledResult(
      batches,
      intermediateSummaries,
      completedBatchIndexes,
      failedBatchIndexes,
      diagnostics,
      overallStart,
    );
  }

  // ---- Reduce stage ----
  // With continueOnMapError, Reduce runs over whichever batches succeeded.
  // With zero successes there is nothing to combine — report FAILED, not
  // an empty Reduce call.
  if (intermediateSummaries.length === 0) {
    return {
      finalSummary: null,
      cancelled: false,
      intermediateSummaries,
      completedBatchIndexes,
      failedBatchIndexes,
      coverage: buildCoverage(batches, completedBatchIndexes, failedBatchIndexes),
      diagnostics,
      totalElapsedMs: performance.now() - overallStart,
      success: false,
      partial: false,
      reduceError: null,
    };
  }

  // Reset experiment: one more reset between the Map stage and Reduce.
  // The Map loop above only returns here after its last iteration's
  // `runOneGeneration`/reset (if any) has fully settled, so this is also
  // a safe, non-concurrent boundary.
  if (resetClient) {
    client = await resetClient();
  }

  onProgress?.({ stage: "reduce", batchIndex: null, batchCount: null });

  // Stage A — Deterministic Evidence Ledger (PROTOTYPE ONLY).
  // Build a bounded set of verbatim source spans from the original chunks
  // to ground Reduce, replacing the single numeric-density excerpt.
  const ledger = buildEvidenceLedger(chunks);
  const sourceEvidence = ledger.map((entry) => ({
    pageNumber: entry.pageNumber,
    text: entry.text,
  }));

  const reduceMessages = buildReducePrompt({ summaries: intermediateSummaries, sourceEvidence });
  const reduceInputCharacters =
    sumCharacters(intermediateSummaries) +
    (sourceEvidence ? sumCharacters(sourceEvidence.map((evidence) => evidence.text)) : 0);

  let reduceGeneration: GenerateResult;
  try {
    reduceGeneration = await runOneGeneration(
      "reduce",
      null,
      reduceInputCharacters,
      reduceMessages,
      reduceMaxNewTokens ?? maxNewTokens,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new MapReduceRunError(
      "reduce",
      `Reduce failed: ${message}`,
      partialSnapshot(),
      { cause: error },
    );
  }

  if (reduceGeneration.cancelled) {
    return cancelledResult(
      batches,
      intermediateSummaries,
      completedBatchIndexes,
      failedBatchIndexes,
      diagnostics,
      overallStart,
    );
  }

  const runFailed = failedBatchIndexes.length > 0;
  return {
    finalSummary: reduceGeneration.text,
    cancelled: false,
    intermediateSummaries,
    completedBatchIndexes,
    failedBatchIndexes,
    coverage: buildCoverage(batches, completedBatchIndexes, failedBatchIndexes),
    diagnostics,
    totalElapsedMs: performance.now() - overallStart,
    success: !runFailed,
    partial: runFailed && completedBatchIndexes.length > 0,
    reduceError: null,
  };
}
