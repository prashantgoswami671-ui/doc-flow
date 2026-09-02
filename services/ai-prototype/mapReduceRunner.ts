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
import { buildMapSummarizePrompt, buildReducePrompt, type ChatMessage } from "./promptBuilder";

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
  /** Optional, additive: generation limit for Map-stage calls only (Experiment 4 — Map output-length control). Defaults to `maxNewTokens` when omitted, so existing callers/experiments that don't set this see no behavior change. Reduce always uses `maxNewTokens`, never this value. */
  mapMaxNewTokens?: number;
  hasPagesWithoutText: boolean;
  wasTruncated: boolean;
  onProgress?: (event: MapReduceProgressEvent) => void;
  onDiagnostic?: (entry: MapReduceDiagnosticEntry) => void;
  /** Called with the requestId of whichever generation is currently in flight (or null when none is), so the caller's existing cancel button can target it — mirrors the single-shot path's activeRequestId. */
  onActiveRequestId?: (requestId: string | null) => void;
  /** Checked before starting every new batch and before Reduce, so a cancellation requested between generations still stops the run without starting another one. */
  isCancelled?: () => boolean;
}

export interface RunMapReduceResult {
  finalSummary: string | null;
  cancelled: boolean;
  /** Map-stage outputs, in batch order. Populated even if the run is later cancelled during Reduce. */
  intermediateSummaries: string[];
  /** Every generation attempted, in run order — includes a cancelled/errored final entry if applicable. */
  diagnostics: MapReduceDiagnosticEntry[];
  totalElapsedMs: number;
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

/** A cancelled/pre-cancelled result shape, factored out so every early-return site stays consistent. */
function cancelledResult(
  intermediateSummaries: string[],
  diagnostics: MapReduceDiagnosticEntry[],
  overallStart: number,
): RunMapReduceResult {
  return {
    finalSummary: null,
    cancelled: true,
    intermediateSummaries,
    diagnostics,
    totalElapsedMs: performance.now() - overallStart,
  };
}

/**
 * Runs one sequential Map -> Reduce pass. Does not catch/report to a UI
 * itself — throws on a non-cancellation generation error, exactly as
 * `client.generate()`'s own result promise does, so the caller's
 * existing try/catch (see the test harness page's `runWithDocument`)
 * handles it the same way it already handles a single-shot failure.
 */
export async function runMapReduceSummarize(
  options: RunMapReduceOptions,
): Promise<RunMapReduceResult> {
  const {
    client,
    chunks,
    batchSize,
    maxNewTokens,
    mapMaxNewTokens,
    hasPagesWithoutText,
    wasTruncated,
    onProgress,
    onDiagnostic,
    onActiveRequestId,
    isCancelled,
  } = options;

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
  let generationNumber = 0;

  async function runOneGeneration(
    stage: MapReduceStage,
    batchIndex: number | null,
    inputCharacters: number,
    messages: ChatMessage[],
    maxNewTokensForThisCall: number,
  ): Promise<GenerateResult> {
    generationNumber += 1;
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
        inferenceMs: 0,
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
      return cancelledResult(intermediateSummaries, diagnostics, overallStart);
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

    const generation = await runOneGeneration(
      "map",
      batchIndex,
      inputCharacters,
      messages,
      mapMaxNewTokens ?? maxNewTokens,
    );

    if (generation.cancelled) {
      return cancelledResult(intermediateSummaries, diagnostics, overallStart);
    }

    intermediateSummaries.push(generation.text);
  }

  if (isCancelled?.()) {
    return cancelledResult(intermediateSummaries, diagnostics, overallStart);
  }

  // ---- Reduce stage ----
  onProgress?.({ stage: "reduce", batchIndex: null, batchCount: null });
  const reduceMessages = buildReducePrompt({ summaries: intermediateSummaries });
  const reduceInputCharacters = sumCharacters(intermediateSummaries);

  const reduceGeneration = await runOneGeneration(
    "reduce",
    null,
    reduceInputCharacters,
    reduceMessages,
    maxNewTokens,
  );

  if (reduceGeneration.cancelled) {
    return cancelledResult(intermediateSummaries, diagnostics, overallStart);
  }

  return {
    finalSummary: reduceGeneration.text,
    cancelled: false,
    intermediateSummaries,
    diagnostics,
    totalElapsedMs: performance.now() - overallStart,
  };
}
