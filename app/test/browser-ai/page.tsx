"use client";

/*
 * Brave Benchmark Harness — Browser AI prototype benchmark
 * (PROTOTYPE / BENCHMARK ONLY — not production).
 *
 * Enhances the Checkpoint 2A harness so controlled single-pass and
 * Map->Reduce benchmarks can be run in a real browser (Brave is the
 * documented target) with explicit parameters instead of source edits:
 *
 * - Single-pass: context budget (4K-10K chars) x output cap (64/128/256)
 * - Map->Reduce: batch size (2/3/4/6) x Map cap (64/128/256) x Reduce cap
 * - Document source: synthetic fixture (1-50 pages) OR uploaded real PDF
 *   (uploaded PDFs work in BOTH modes — the prior harness limitation).
 * - Cold vs warm: explicit model init, runs reuse the same Worker/session.
 * - Cancellation, foreground/background visibility tracking, coverage,
 *   inspectable outputs, qualitative review checklist, JSON export.
 *
 * Local-only: no API calls, no telemetry, no uploads. The only network
 * activity is the pre-existing Hugging Face model-asset download
 * performed internally by @huggingface/transformers (see
 * services/ai-prototype/README.md and tests/network-egress.test.ts).
 *
 * This page intentionally does NOT import production runtime code
 * (services/ai/browser/*) — it drives the prototype stack only.
 * AI-02 context building (services/ai/pipeline.ts) is reused read-only
 * for benchmark input preparation; no production file is modified.
 */

import { useEffect, useRef, useState } from "react";
import { buildAiTextContext, type BuildAiTextContextResult } from "@/services/ai/pipeline";
import {
  buildTextVectorPdfBytes,
  toFile,
} from "@/services/pdf/__fixtures__/pdf";
import { buildSummarizePrompt } from "@/services/ai-prototype/promptBuilder";
import { BrowserAiWorkerClient } from "@/services/ai-prototype/browserAiWorkerClient";
import {
  MapReduceRunError,
  runMapReduceSummarize,
  type MapReduceDiagnosticEntry,
} from "@/services/ai-prototype/mapReduceRunner";
import {
  BENCHMARK_CANDIDATE_DTYPE,
  BENCHMARK_CANDIDATE_MODEL_ID,
  EXPERIMENT_A_DTYPE,
  EXPERIMENT_A_FP16_DTYPE,
  EXPERIMENT_A_MODEL_ID,
  PILOT_MODEL_DTYPE,
  PILOT_MODEL_ID,
  PROTOTYPE_MAX_NEW_TOKENS,
} from "@/services/ai-prototype/constants";
import {
  BENCH_BATCH_SIZES,
  BENCH_OUTPUT_CAPS,
  BENCH_REDUCE_DEFAULT_CAP,
  BENCH_SINGLE_PASS_CONTEXT_BUDGETS,
  BENCH_SYNTHETIC_PAGE_COUNTS,
  assertValidMapReduceConfig,
  assertValidSinglePassConfig,
  createRunRecordSkeleton,
  describeSlicingCoverage,
  pagesOfChunks,
  selectChunksWithinBudget,
  type BenchBatchSize,
  type BenchOutputCap,
  type BenchmarkDocSource,
  type BenchmarkMode,
  type BenchmarkRunRecord,
  type BenchQualityEntry,
  type BenchQualityStatus,
} from "@/services/ai-prototype/benchmarkConfig";
import type { AiWorkerDevice } from "@/services/ai-prototype/workerProtocol";

type Candidate = "pilot" | "benchmark" | "experimentA" | "experimentAFp16";

const CANDIDATE_CONFIG: Record<Candidate, { modelId: string; dtype: string }> = {
  pilot: { modelId: PILOT_MODEL_ID, dtype: PILOT_MODEL_DTYPE },
  benchmark: { modelId: BENCHMARK_CANDIDATE_MODEL_ID, dtype: BENCHMARK_CANDIDATE_DTYPE },
  experimentA: { modelId: EXPERIMENT_A_MODEL_ID, dtype: EXPERIMENT_A_DTYPE },
  experimentAFp16: { modelId: EXPERIMENT_A_MODEL_ID, dtype: EXPERIMENT_A_FP16_DTYPE },
};

const REDUCE_CAP_OPTIONS = [64, 128, 256, 512] as const;

type ModelLifecycle = "uninitialized" | "initializing" | "ready" | "error";
type SourceKind = "synthetic" | "uploaded";

interface ActiveRun {
  runId: string;
  cancelRequestedAtIso: string | null;
  cancelRequestedAtMs: number | null;
}

let runSequence = 0;
function nextRunId(): string {
  runSequence += 1;
  return `bench-${Date.now()}-${runSequence}`;
}

function sumNullable(values: (number | null)[]): number | null {
  let total = 0;
  for (const v of values) {
    if (v === null) return null;
    total += v;
  }
  return total;
}

function isMemoryFailureSignature(message: string): boolean {
  return /bad_alloc|array buffer|out of memory|OOM|allocation failed/i.test(message);
}

declare global {
  interface Window {
    /** Legacy hook (unchanged signature): full-context single-pass over a synthetic fixture. */
    runBrowserAiTest?: (device: AiWorkerDevice, candidate?: Candidate, pageCount?: number) => Promise<void>;
    /** Legacy hook (unchanged signature): Map->Reduce over a synthetic fixture. */
    runBrowserAiMapReduceTest?: (
      device: AiWorkerDevice,
      candidate: Candidate,
      pageCount: number,
      batchSize: number,
      mapMaxNewTokens?: number,
    ) => Promise<void>;
    cancelBrowserAiTest?: () => void;
    browserAiHarnessState?: { status: string; runs: number; lastRunId: string | null };
    /** New: parameterized single-pass benchmark (synthetic fixture only via hook; use the UI for uploaded PDFs). */
    runBenchmarkSinglePass?: (options: {
      device?: AiWorkerDevice;
      pageCount?: number;
      contextBudgetChars?: number;
      maxNewTokens?: number;
    }) => Promise<void>;
    /** New: parameterized Map->Reduce benchmark (synthetic fixture only via hook; use the UI for uploaded PDFs). */
    runBenchmarkMapReduce?: (options: {
      device?: AiWorkerDevice;
      pageCount?: number;
      batchSize?: number;
      mapMaxNewTokens?: number;
      reduceMaxNewTokens?: number;
    }) => Promise<void>;
    /** New: read-only access to completed run records (JSON-serializable). */
    getBenchmarkRuns?: () => BenchmarkRunRecord[];
  }
}

export default function BrowserAiBenchmarkPage() {
  // ---- Model lifecycle (cold vs warm) ----
  const clientRef = useRef<BrowserAiWorkerClient | null>(null);
  const clientConfigRef = useRef<{ device: AiWorkerDevice; modelId: string; dtype: string } | null>(null);
  const [lifecycle, setLifecycle] = useState<ModelLifecycle>("uninitialized");
  const [lastInitMs, setLastInitMs] = useState<number | null>(null);
  const [initError, setInitError] = useState<string | null>(null);

  // ---- Controls ----
  const [mode, setMode] = useState<BenchmarkMode>("single-pass");
  const [sourceKind, setSourceKind] = useState<SourceKind>("synthetic");
  const [syntheticPages, setSyntheticPages] = useState<number>(41);
  const [uploadedFile, setUploadedFile] = useState<File | null>(null);
  const [contextBudget, setContextBudget] = useState<number>(8000);
  const [singleCap, setSingleCap] = useState<BenchOutputCap>(256);
  const [batchSize, setBatchSize] = useState<BenchBatchSize>(3);
  const [mapCap, setMapCap] = useState<BenchOutputCap>(256);
  const [reduceCap, setReduceCap] = useState<number>(BENCH_REDUCE_DEFAULT_CAP);
  const [candidate, setCandidate] = useState<Candidate>("benchmark");
  const [device, setDevice] = useState<AiWorkerDevice>("wasm");
  const [browserLabel, setBrowserLabel] = useState<string>("Brave");
  const [detectedBrowser, setDetectedBrowser] = useState<string>("detecting…");

  // ---- Run state ----
  const [runs, setRuns] = useState<BenchmarkRunRecord[]>([]);
  const [runLogs, setRunLogs] = useState<Record<string, string[]>>({});
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [active, setActive] = useState<ActiveRun | null>(null);
  const [activeRequestId, setActiveRequestId] = useState<string | null>(null);
  const [status, setStatus] = useState<string>("idle");
  const [copyNote, setCopyNote] = useState<string>("");

  // ---- Visibility (foreground/background indicator only — no throttling workaround) ----
  // Deterministic "unknown" initial state: reading document.visibilityState
  // here would hydrate as "visible" on the client while SSR renders
  // "unknown" (hydration mismatch). The real value is synced on mount below.
  const [visibility, setVisibility] = useState<string>("unknown");
  const runActiveRef = useRef(false);
  const visibilityTransitionsRef = useRef(0);
  const runStartVisibilityRef = useRef<string | null>(null);

  // ---- Cancel coordination ----
  const mapReduceCancelRef = useRef(false);
  const cancelRequestRef = useRef<{ iso: string; ms: number } | null>(null);
  const activeRef = useRef<ActiveRun | null>(null);
  const onCancelClickedRef = useRef(() => {});
  const runsRef = useRef<BenchmarkRunRecord[]>([]);

  const runnersRef = useRef<{
    runSinglePass: (options: {
      source: BenchmarkDocSource;
      getFile: () => Promise<File>;
      contextBudgetChars: number | "full";
      maxNewTokens: number;
      device: AiWorkerDevice;
      candidate: Candidate;
    }) => Promise<void>;
    runMapReduce: (options: {
      source: BenchmarkDocSource;
      getFile: () => Promise<File>;
      batchSize: number;
      mapMaxNewTokens: number;
      reduceMaxNewTokens: number;
      device: AiWorkerDevice;
      candidate: Candidate;
      continueOnMapError?: boolean;
    }) => Promise<void>;
  } | null>(null);

  // Brave detection (best-effort, never blocks execution).
  useEffect(() => {
    let cancelled = false;
    async function detect() {
      try {
        const nav = navigator as unknown as {
          brave?: { isBrave?: () => Promise<boolean> };
          userAgentData?: { brands?: { brand: string }[] };
        };
        if (nav.brave?.isBrave) {
          const isBrave = await nav.brave.isBrave();
          if (!cancelled) setDetectedBrowser(isBrave ? "Brave (detected)" : "Not Brave (brave API present but false)");
          return;
        }
        const brands = nav.userAgentData?.brands?.map((b) => b.brand).join(", ");
        if (!cancelled) setDetectedBrowser(brands ? `UA brands: ${brands} (manual confirm)` : "Unknown — confirm manually (target: Brave)");
      } catch {
        if (!cancelled) setDetectedBrowser("Detection failed — confirm manually (target: Brave)");
      }
    }
    void detect();
    return () => {
      cancelled = true;
    };
  }, []);

  // Visibility tracking. The initial sync runs on mount (post-hydration),
  // so the server and the first client render agree on "unknown".
  // One-time browser-state sync (not derived render state) — the single
  // extra mount render is intentional and negligible for this harness.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional one-time post-hydration sync of browser-only document.visibilityState; required to avoid an SSR hydration mismatch
    setVisibility(document.visibilityState);
    const onChange = () => {
      setVisibility(document.visibilityState);
      if (runActiveRef.current) visibilityTransitionsRef.current += 1;
    };
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);

  function appendRunLog(runId: string, line: string) {
    setRunLogs((prev) => ({ ...prev, [runId]: [...(prev[runId] ?? []), line] }));
  }

  /**
   * Reads the cancel-request ref with an explicit type. (Direct
   * `cancelRequestRef.current?.iso` reads confuse control-flow narrowing
   * after the ref is reset to null in the same function body.)
   */
  function readCancelRequest(): { iso: string; ms: number } | null {
    const value: unknown = cancelRequestRef.current;
    if (
      value !== null &&
      typeof value === "object" &&
      "iso" in value &&
      "ms" in value &&
      typeof (value as { iso: unknown }).iso === "string" &&
      typeof (value as { ms: unknown }).ms === "number"
    ) {
      return value as { iso: string; ms: number };
    }
    return null;
  }

  function pushRun(record: BenchmarkRunRecord) {
    runsRef.current = [...runsRef.current, record];
    setRuns(runsRef.current);
    setSelectedRunId(record.runId);
    if (typeof window !== "undefined") {
      window.browserAiHarnessState = { status: record.success ? "complete" : "error", runs: runsRef.current.length, lastRunId: record.runId };
    }
  }

  /** Ensures an initialized client. Returns initMs only when THIS call initialized (cold); null when reusing (warm). */
  async function ensureClient(
    runId: string | null,
    init: { device: AiWorkerDevice; candidate: Candidate },
  ): Promise<{ initMs: number | null; cold: boolean }> {
    const targetDevice = init.device;
    const targetCandidate = init.candidate;
    const targetConfig = {
      device: targetDevice,
      modelId: CANDIDATE_CONFIG[targetCandidate].modelId,
      dtype: CANDIDATE_CONFIG[targetCandidate].dtype,
    };
    const existingConfig = clientConfigRef.current;
    if (clientRef.current) {
      if (
        existingConfig &&
        existingConfig.device === targetConfig.device &&
        existingConfig.modelId === targetConfig.modelId &&
        existingConfig.dtype === targetConfig.dtype
      ) {
        return { initMs: null, cold: false };
      }
      if (runId) {
        appendRunLog(runId, "Requested model/device differs from the loaded configuration; disposing the existing Worker.");
      }
      clientRef.current.terminate();
      clientRef.current = null;
      clientConfigRef.current = null;
      setLifecycle("uninitialized");
    }
    setLifecycle("initializing");
    setInitError(null);
    if (runId) appendRunLog(runId, `Cold init: loading ${CANDIDATE_CONFIG[targetCandidate].modelId} (device=${targetDevice})…`);
    const newClient = new BrowserAiWorkerClient({
      onInitProgress: (progress) => {
        if (runId) {
          appendRunLog(
            runId,
            `[init-progress] ${progress.status}${progress.file ? ` ${progress.file}` : ""}${
              progress.loaded && progress.total ? ` (${progress.loaded}/${progress.total} bytes)` : ""
            }`,
          );
        }
      },
      onToken: () => {},
    });
    try {
      const { modelInitMs } = await newClient.initModel({
        device: targetDevice,
        modelId: CANDIDATE_CONFIG[targetCandidate].modelId,
        dtype: CANDIDATE_CONFIG[targetCandidate].dtype,
      });
      clientRef.current = newClient;
      clientConfigRef.current = targetConfig;
      setLifecycle("ready");
      setLastInitMs(modelInitMs);
      if (runId) appendRunLog(runId, `Model ready in ${modelInitMs.toFixed(0)}ms (cold).`);
      return { initMs: modelInitMs, cold: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      newClient.terminate();
      clientRef.current = null;
      clientConfigRef.current = null;
      setLifecycle("error");
      setInitError(message);
      if (runId) appendRunLog(runId, `INIT ERROR: ${message}`);
      throw error;
    }
  }

  async function loadBenchmarkFile(
    source: BenchmarkDocSource,
    getFile: () => Promise<File>,
    runId: string,
  ): Promise<{ file: File; context: BuildAiTextContextResult }> {
    const file = await getFile();
    const label = source.kind === "synthetic" ? `synthetic ${source.pageCount}-page fixture` : `uploaded PDF "${source.filename}" (${source.fileSizeBytes} bytes)`;
    appendRunLog(runId, `Loading document: ${label}`);
    const context = await buildAiTextContext(file);
    appendRunLog(
      runId,
      `AI-02: ${context.chunks.length} chunk(s), ${context.totalCharacters} chars, ${context.sourcePageCount} page(s), ` +
        `truncated=${context.truncated}, pagesWithoutText=[${context.pagesWithoutText.join(",")}] in ${context.processingTime.toFixed(1)}ms.`,
    );
    return { file, context };
  }

  function finalizeVisibility(record: BenchmarkRunRecord): void {
    record.visibilityAtStart = runStartVisibilityRef.current;
    record.visibilityAtEnd = typeof document !== "undefined" ? document.visibilityState : "unknown";
    record.visibilityChangesDuringRun = visibilityTransitionsRef.current;
  }

  async function runSinglePass(options: {
    source: BenchmarkDocSource;
    getFile: () => Promise<File>;
    contextBudgetChars: number | "full";
    maxNewTokens: number;
    device: AiWorkerDevice;
    candidate: Candidate;
  }): Promise<void> {
    if (options.contextBudgetChars !== "full") {
      assertValidSinglePassConfig({ contextBudgetChars: options.contextBudgetChars, maxNewTokens: options.maxNewTokens });
    }
    if (activeRef.current) throw new Error("A benchmark is already running — cancel it first.");
    const runId = nextRunId();
    const startedAtIso = new Date().toISOString();
    runActiveRef.current = true;
    visibilityTransitionsRef.current = 0;
    runStartVisibilityRef.current = typeof document !== "undefined" ? document.visibilityState : "unknown";
    mapReduceCancelRef.current = false;
    cancelRequestRef.current = null;
    activeRef.current = { runId, cancelRequestedAtIso: null, cancelRequestedAtMs: null };
    setActive({ runId, cancelRequestedAtIso: null, cancelRequestedAtMs: null });
    setStatus("running");
    setRunLogs((prev) => ({ ...prev, [runId]: [] }));

    const record = createRunRecordSkeleton({
      runId,
      startedAtIso,
      mode: "single-pass",
      source: options.source,
      device: options.device,
      modelId: CANDIDATE_CONFIG[options.candidate].modelId,
      dtype: CANDIDATE_CONFIG[options.candidate].dtype,
      browserLabel,
      coldWarm: "warm",
    });
    record.requestedMaxNewTokens = options.maxNewTokens;

    try {
      appendRunLog(runId, `[single-pass] budget=${options.contextBudgetChars === "full" ? "full-context" : options.contextBudgetChars} cap=${options.maxNewTokens}`);
      const { context } = await loadBenchmarkFile(options.source, options.getFile, runId);
      record.pages = context.sourcePageCount;
      record.extractedCharacters = context.totalCharacters;
      record.chunks = context.chunks.length;
      record.pagesWithoutText = context.pagesWithoutText;
      record.ai02Truncated = context.truncated;
      record.extractionMs = context.processingTime;

      const slice =
        options.contextBudgetChars === "full"
          ? { included: context.chunks, omitted: [], includedChars: context.totalCharacters, omittedChars: 0 }
          : selectChunksWithinBudget(context.chunks, options.contextBudgetChars);
      const coverage = describeSlicingCoverage(context.chunks, slice);
      record.contextBudgetChars = options.contextBudgetChars === "full" ? context.totalCharacters : options.contextBudgetChars;
      record.actualContextChars = slice.includedChars;
      record.attemptedChunks = slice.included.length;
      record.completedChunks = 0; // set after generation
      record.omittedPages = coverage.omittedPages;
      record.truncated = context.truncated || slice.omitted.length > 0;
      appendRunLog(
        runId,
        `Slice: ${slice.included.length}/${context.chunks.length} chunks, ${slice.includedChars} chars` +
          (slice.omitted.length > 0 ? `; OMITTED ${slice.omitted.length} chunk(s), ${slice.omittedChars} chars, pages [${coverage.omittedPages.join(",")}]` : "; nothing omitted"),
      );

      const { initMs, cold } = await ensureClient(runId, { device: options.device, candidate: options.candidate });
      record.coldWarm = cold ? "cold" : "warm";
      record.initializationMs = initMs;

      const messages = buildSummarizePrompt({
        chunks: slice.included,
        hasPagesWithoutText: context.pagesWithoutText.length > 0,
        wasTruncated: record.truncated,
      });

      const client = clientRef.current;
      if (!client) throw new Error("Model client unavailable after init.");
      appendRunLog(runId, "Running single-pass inference…");
      const { requestId, result } = client.generate(messages, options.maxNewTokens);
      setActiveRequestId(requestId);
      const generation = await result;
      setActiveRequestId(null);

      record.inferenceMsTotal = generation.inferenceMs;
      record.inputTokens = generation.diagnostic?.inputTokenCount ?? null;
      record.generatedTokens = generation.diagnostic?.generatedTokenCount ?? null;
      record.outputCharacters = generation.outputCharacters;

      if (generation.cancelled) {
        record.cancelled = true;
        const cancelReq = readCancelRequest();
        record.cancelRequestedAtIso = cancelReq?.iso ?? null;
        record.cancelObservedMs = cancelReq ? performance.now() - cancelReq.ms : null;
        record.runtimeReusableAfterCancel = clientRef.current !== null;
        record.summary = generation.text || null;
        appendRunLog(runId, `CANCELLED by user. Reusable without reload: ${record.runtimeReusableAfterCancel}.`);
      } else {
        record.completedChunks = slice.included.length;
        record.summary = generation.text;
        record.success = true;
        appendRunLog(
          runId,
          `Done in ${generation.inferenceMs.toFixed(0)}ms: ${generation.outputCharacters} chars` +
            (record.generatedTokens !== null ? `, ${record.generatedTokens} tokens` : "") +
            (record.inputTokens !== null ? `, ${record.inputTokens} input tokens` : ""),
        );
        if (generation.diagnostic) {
          const d = generation.diagnostic;
          appendRunLog(
            runId,
            `Diagnostic: generatedTokenCount=${d.generatedTokenCount} specialTokenCount=${d.specialTokenCount} inputTokenCount=${d.inputTokenCount}`,
          );
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      record.success = false;
      record.error = message;
      if (isMemoryFailureSignature(message)) appendRunLog(runId, "MEMORY-FAILURE-SIGNATURE (exact text recorded; cause NOT classified).");
      appendRunLog(runId, `ERROR: ${message}`);
    } finally {
      record.totalCalls = 1;
      finalizeVisibility(record);
      pushRun(record);
      runActiveRef.current = false;
      activeRef.current = null;
      setActive(null);
      setActiveRequestId(null);
      // Failed runs stay visible in the top-level status instead of being
      // silently swallowed back to "idle" — the failure is already
      // recorded on `record.error`/the run log; surface it here too so a
      // fast failure (e.g. AI-02 extraction rejecting before any Worker
      // round-trip) doesn't look indistinguishable from nothing happening.
      setStatus(record.error ? `error: ${record.error}` : "idle");
    }
  }

  async function runMapReduce(options: {
    source: BenchmarkDocSource;
    getFile: () => Promise<File>;
    batchSize: number;
    mapMaxNewTokens: number;
    reduceMaxNewTokens: number;
    device: AiWorkerDevice;
    candidate: Candidate;
    continueOnMapError?: boolean;
  }): Promise<void> {
    assertValidMapReduceConfig({
      batchSize: options.batchSize,
      mapMaxNewTokens: options.mapMaxNewTokens,
      reduceMaxNewTokens: options.reduceMaxNewTokens,
    });
    if (activeRef.current) throw new Error("A benchmark is already running — cancel it first.");
    const continueOnMapError = options.continueOnMapError ?? true;
    const runId = nextRunId();
    const startedAtIso = new Date().toISOString();
    const wallStart = performance.now();
    runActiveRef.current = true;
    visibilityTransitionsRef.current = 0;
    runStartVisibilityRef.current = typeof document !== "undefined" ? document.visibilityState : "unknown";
    mapReduceCancelRef.current = false;
    cancelRequestRef.current = null;
    activeRef.current = { runId, cancelRequestedAtIso: null, cancelRequestedAtMs: null };
    setActive({ runId, cancelRequestedAtIso: null, cancelRequestedAtMs: null });
    setStatus("running");
    setRunLogs((prev) => ({ ...prev, [runId]: [] }));

    const record = createRunRecordSkeleton({
      runId,
      startedAtIso,
      mode: "map-reduce",
      source: options.source,
      device: options.device,
      modelId: CANDIDATE_CONFIG[options.candidate].modelId,
      dtype: CANDIDATE_CONFIG[options.candidate].dtype,
      browserLabel,
      coldWarm: "warm",
    });
    record.batchSize = options.batchSize;
    record.mapMaxNewTokens = options.mapMaxNewTokens;
    record.reduceMaxNewTokens = options.reduceMaxNewTokens;

    const applyDiagnostics = (diagnostics: MapReduceDiagnosticEntry[]) => {
      const maps = diagnostics.filter((d) => d.stage === "map");
      const reduces = diagnostics.filter((d) => d.stage === "reduce");
      record.mapCalls = maps.length;
      record.reduceCalls = reduces.length;
      record.totalCalls = diagnostics.length;
      record.mapMsTotal = maps.reduce((t, d) => t + d.inferenceMs, 0);
      record.reduceMs = reduces.reduce((t, d) => t + d.inferenceMs, 0);
      record.inferenceMsTotal = record.mapMsTotal + record.reduceMs;
      record.mapInputTokensTotal = sumNullable(maps.map((d) => d.inputTokenCount));
      record.reduceInputTokens = reduces.length > 0 ? sumNullable(reduces.map((d) => d.inputTokenCount)) : null;
      record.mapGeneratedTokensTotal = sumNullable(maps.map((d) => d.generatedTokenCount));
      record.reduceGeneratedTokens = reduces.length > 0 ? sumNullable(reduces.map((d) => d.generatedTokenCount)) : null;
    };

    try {
      appendRunLog(
        runId,
        `[map-reduce] batch=${options.batchSize} mapCap=${options.mapMaxNewTokens} reduceCap=${options.reduceMaxNewTokens} continueOnMapError=${continueOnMapError}`,
      );
      const { context } = await loadBenchmarkFile(options.source, options.getFile, runId);
      record.pages = context.sourcePageCount;
      record.extractedCharacters = context.totalCharacters;
      record.chunks = context.chunks.length;
      record.pagesWithoutText = context.pagesWithoutText;
      record.ai02Truncated = context.truncated;
      record.extractionMs = context.processingTime;
      record.truncated = context.truncated;
      record.attemptedChunks = context.chunks.length;

      const { initMs, cold } = await ensureClient(runId, { device: options.device, candidate: options.candidate });
      record.coldWarm = cold ? "cold" : "warm";
      record.initializationMs = initMs;

      const client = clientRef.current;
      if (!client) throw new Error("Model client unavailable after init.");

      const outcome = await runMapReduceSummarize({
        client,
        chunks: context.chunks,
        batchSize: options.batchSize,
        maxNewTokens: options.reduceMaxNewTokens,
        mapMaxNewTokens: options.mapMaxNewTokens,
        reduceMaxNewTokens: options.reduceMaxNewTokens,
        continueOnMapError,
        hasPagesWithoutText: context.pagesWithoutText.length > 0,
        wasTruncated: context.truncated,
        isCancelled: () => mapReduceCancelRef.current,
        onActiveRequestId: (requestId) => setActiveRequestId(requestId),
        onProgress: (event) => {
          appendRunLog(
            runId,
            event.stage === "map"
              ? `Map batch ${(event.batchIndex ?? 0) + 1}/${event.batchCount} starting…`
              : "Reduce stage: combining intermediate summaries…",
          );
        },
        onDiagnostic: (entry) => {
          const label = entry.stage === "map" ? `Map batch ${(entry.batchIndex ?? 0) + 1}/${entry.batchCount}` : "Reduce";
          appendRunLog(
            runId,
            `${label} (gen #${entry.generationNumber}, cap=${entry.requestedMaxNewTokens}): inputChars=${entry.inputCharacters}` +
              `${entry.chunksInBatch !== null ? ` chunks=${entry.chunksInBatch}` : ""} inferenceMs=${entry.inferenceMs.toFixed(0)} ` +
              `outChars=${entry.outputCharacters}${entry.generatedTokenCount !== null ? ` genTokens=${entry.generatedTokenCount}` : ""}` +
              `${entry.inputTokenCount !== null ? ` inTokens=${entry.inputTokenCount}` : ""}` +
              `${entry.cancelled ? " CANCELLED" : ""}${entry.error ? ` ERROR=${entry.error}` : ""}`,
          );
        },
      });
      setActiveRequestId(null);

      applyDiagnostics(outcome.diagnostics);
      record.completedChunks = outcome.coverage.completedChunks;
      record.failedChunks = outcome.coverage.failedChunks;
      record.failedBatchIndexes = outcome.failedBatchIndexes;
      record.completedBatchIndexes = outcome.completedBatchIndexes;
      record.pagesRepresented = outcome.coverage.pagesRepresented;
      record.omittedPages = pagesOfChunks(context.chunks).filter((p) => !outcome.coverage.pagesRepresented.includes(p));
      record.summary = outcome.finalSummary;
      record.mapSummaries = outcome.intermediateSummaries;
      record.outputCharacters = outcome.finalSummary?.length ?? 0;
      record.success = outcome.success;
      record.partial = outcome.partial;

      if (outcome.cancelled) {
        record.cancelled = true;
        const cancelReq = readCancelRequest();
        record.cancelRequestedAtIso = cancelReq?.iso ?? null;
        record.cancelObservedMs = cancelReq ? performance.now() - cancelReq.ms : null;
        record.runtimeReusableAfterCancel = clientRef.current !== null;
        appendRunLog(
          runId,
          `CANCELLED after ${outcome.diagnostics.length} generation(s). ${outcome.intermediateSummaries.length} intermediate(s) kept. Reusable without reload: ${record.runtimeReusableAfterCancel}.`,
        );
      } else if (outcome.success) {
        appendRunLog(
          runId,
          `COMPLETE: ${outcome.intermediateSummaries.length} map(s) -> 1 reduce, ${outcome.diagnostics.length} generation(s), ${(performance.now() - wallStart).toFixed(0)}ms wall.`,
        );
      } else {
        // continueOnMapError swallows Map-batch failures internally (no
        // throw), so record.error is still null here even though the run
        // failed — the underlying message only exists on the failed
        // diagnostic entries (see the Batch 4 diagnosis). Surface the
        // first one so the top-level status (set in `finally` below) can
        // show it instead of a bare "idle".
        if (record.error === null) {
          const firstFailedMap = outcome.diagnostics.find((d) => d.stage === "map" && d.error !== null);
          if (firstFailedMap?.error) {
            record.error = firstFailedMap.error;
          }
        }
        appendRunLog(
          runId,
          `PARTIAL/FAILED: ${outcome.coverage.batchesCompleted}/${outcome.coverage.batchesAttempted} batches ok; failed batches [${outcome.failedBatchIndexes.join(",")}]; ` +
            `pages represented [${outcome.coverage.pagesRepresented.join(",")}].`,
        );
      }
    } catch (error) {
      setActiveRequestId(null);
      if (error instanceof MapReduceRunError) {
        applyDiagnostics(error.diagnostics);
        record.completedChunks = error.coverage.completedChunks;
        record.failedChunks = error.coverage.failedChunks;
        record.failedBatchIndexes = error.failedBatchIndexes;
        record.completedBatchIndexes = error.completedBatchIndexes;
        record.pagesRepresented = error.coverage.pagesRepresented;
        record.mapSummaries = error.intermediateSummaries;
        record.success = false;
        record.partial = error.completedBatchIndexes.length > 0;
        record.error = error.message;
        if (isMemoryFailureSignature(error.message)) appendRunLog(runId, "MEMORY-FAILURE-SIGNATURE (exact text recorded; cause NOT classified).");
        appendRunLog(runId, `FAILED at ${error.stage}: ${error.message}`);
      } else {
        const message = error instanceof Error ? error.message : String(error);
        record.success = false;
        record.error = message;
        if (isMemoryFailureSignature(message)) appendRunLog(runId, "MEMORY-FAILURE-SIGNATURE (exact text recorded; cause NOT classified).");
        appendRunLog(runId, `ERROR: ${message}`);
      }
    } finally {
      finalizeVisibility(record);
      pushRun(record);
      runActiveRef.current = false;
      activeRef.current = null;
      setActive(null);
      setActiveRequestId(null);
      // Failed runs stay visible in the top-level status instead of being
      // silently swallowed back to "idle" — the failure is already
      // recorded on `record.error`/the run log; surface it here too so a
      // fast failure (e.g. AI-02 extraction rejecting before any Worker
      // round-trip) doesn't look indistinguishable from nothing happening.
      setStatus(record.error ? `error: ${record.error}` : "idle");
    }
  }

  // Keeps the window-hook entry points and cancel ref pointing at the
  // latest closures. No dependency array (runs after every render) —
  // this writes refs from an effect, never during render.
  useEffect(() => {
    runnersRef.current = {
      runSinglePass: (o) => runSinglePass(o),
      runMapReduce: (o) => runMapReduce(o),
    };
    onCancelClickedRef.current = onCancelClicked;
  });

  function syntheticFile(pageCount: number): () => Promise<File> {
    return async () => toFile(await buildTextVectorPdfBytes(pageCount), `benchmark-synthetic-${pageCount}p.pdf`);
  }

  function currentSource(): { source: BenchmarkDocSource; getFile: () => Promise<File> } | { error: string } {
    if (sourceKind === "synthetic") {
      return { source: { kind: "synthetic", pageCount: syntheticPages }, getFile: syntheticFile(syntheticPages) };
    }
    if (!uploadedFile) return { error: "No uploaded PDF selected — choose a file first." };
    const file = uploadedFile;
    return {
      source: { kind: "uploaded", filename: file.name, fileSizeBytes: file.size },
      getFile: async () => file,
    };
  }

  async function onRunClicked() {
    const resolved = currentSource();
    if ("error" in resolved) {
      setStatus(`error: ${resolved.error}`);
      return;
    }
    try {
      if (mode === "single-pass") {
        await runSinglePass({
          source: resolved.source,
          getFile: resolved.getFile,
          contextBudgetChars: contextBudget,
          maxNewTokens: singleCap,
          device,
          candidate,
        });
      } else {
        await runMapReduce({
          source: resolved.source,
          getFile: resolved.getFile,
          batchSize,
          mapMaxNewTokens: mapCap,
          reduceMaxNewTokens: reduceCap,
          device,
          candidate,
        });
      }
    } catch (error) {
      setStatus(`error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function onInitClicked() {
    try {
      const { initMs } = await ensureClient(null, { device, candidate });
      setStatus(initMs === null ? `model already initialized (warm) — last init ${lastInitMs?.toFixed(0) ?? "?"}ms` : `model initialized in ${initMs.toFixed(0)}ms (cold)`);
    } catch {
      setStatus("error: model initialization failed (see panel)");
    }
  }

  function onCancelClicked() {
    const current = activeRef.current;
    if (!current) return;
    const nowMs = performance.now();
    cancelRequestRef.current = { iso: new Date().toISOString(), ms: nowMs };
    mapReduceCancelRef.current = true;
    setActive({ ...current, cancelRequestedAtIso: cancelRequestRef.current.iso, cancelRequestedAtMs: nowMs });
    if (clientRef.current && activeRequestId) {
      clientRef.current.cancel(activeRequestId);
    }
    setStatus("cancellation requested — waiting for worker to stop…");
  }

  function onResetModel() {
    clientRef.current?.terminate();
    clientRef.current = null;
    clientConfigRef.current = null;
    setLifecycle("uninitialized");
    setLastInitMs(null);
    setInitError(null);
    setActiveRequestId(null);
    setStatus("model reset — next run will be COLD");
  }

  async function copyText(text: string, note: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopyNote(note);
      setTimeout(() => setCopyNote(""), 3000);
    } catch {
      setCopyNote("Clipboard copy failed — select the JSON manually.");
    }
  }

  function updateQuality(runId: string, index: number, patch: Partial<BenchQualityEntry>) {
    setRuns((prev) => {
      const next = prev.map((r) => {
        if (r.runId !== runId) return r;
        const quality = r.quality.map((q, i) => (i === index ? { ...q, ...patch } : q));
        return { ...r, quality };
      });
      runsRef.current = next;
      return next;
    });
  }

  // Legacy + new window hooks (Playwright-drivable, repeatable).
  useEffect(() => {
    const runners = () =>
      runnersRef.current ?? {
        runSinglePass: () => Promise.reject(new Error("Harness not ready.")),
        runMapReduce: () => Promise.reject(new Error("Harness not ready.")),
      };
    window.runBrowserAiTest = async (deviceOverride, candidateOverride = "pilot", pageCount = 2) => {
      // Legacy hook: applies its device/candidate explicitly to the page
      // controls AND the run (no stale-closure reads), then runs the
      // legacy full-context single-pass.
      setDevice(deviceOverride);
      setCandidate(candidateOverride);
      await runners().runSinglePass({
        source: { kind: "synthetic", pageCount },
        getFile: async () => toFile(await buildTextVectorPdfBytes(pageCount), "browser-ai-prototype-fixture.pdf"),
        contextBudgetChars: "full",
        maxNewTokens: PROTOTYPE_MAX_NEW_TOKENS,
        device: deviceOverride,
        candidate: candidateOverride,
      });
    };
    window.runBrowserAiMapReduceTest = async (deviceOverride, candidateOverride, pageCount, batchSizeOverride, mapMaxNewTokens) => {
      setDevice(deviceOverride);
      setCandidate(candidateOverride);
      await runners().runMapReduce({
        source: { kind: "synthetic", pageCount },
        getFile: async () => toFile(await buildTextVectorPdfBytes(pageCount), "browser-ai-prototype-fixture.pdf"),
        batchSize: batchSizeOverride,
        mapMaxNewTokens: mapMaxNewTokens ?? PROTOTYPE_MAX_NEW_TOKENS,
        reduceMaxNewTokens: PROTOTYPE_MAX_NEW_TOKENS,
        device: deviceOverride,
        candidate: candidateOverride,
        continueOnMapError: false,
      });
    };
    window.runBenchmarkSinglePass = async (options) => {
      // Window hooks carry explicit config (defaulting to the benchmark
      // target wasm + 0.5B candidate); UI control state is separate.
      const hookDevice = options.device ?? "wasm";
      setDevice(hookDevice);
      return runners().runSinglePass({
        source: { kind: "synthetic", pageCount: options.pageCount ?? 41 },
        getFile: async () =>
          toFile(await buildTextVectorPdfBytes(options.pageCount ?? 41), "browser-ai-prototype-fixture.pdf"),
        contextBudgetChars: options.contextBudgetChars ?? 8000,
        maxNewTokens: options.maxNewTokens ?? PROTOTYPE_MAX_NEW_TOKENS,
        device: hookDevice,
        candidate: "benchmark",
      });
    };
    window.runBenchmarkMapReduce = async (options) => {
      const hookDevice = options.device ?? "wasm";
      setDevice(hookDevice);
      return runners().runMapReduce({
        source: { kind: "synthetic", pageCount: options.pageCount ?? 41 },
        getFile: async () =>
          toFile(await buildTextVectorPdfBytes(options.pageCount ?? 41), "browser-ai-prototype-fixture.pdf"),
        batchSize: options.batchSize ?? 3,
        mapMaxNewTokens: options.mapMaxNewTokens ?? PROTOTYPE_MAX_NEW_TOKENS,
        reduceMaxNewTokens: options.reduceMaxNewTokens ?? PROTOTYPE_MAX_NEW_TOKENS,
        device: hookDevice,
        candidate: "benchmark",
        continueOnMapError: true,
      });
    };
    window.cancelBrowserAiTest = () => onCancelClickedRef.current();
    window.getBenchmarkRuns = () => runsRef.current;
    window.browserAiHarnessState = { status: "idle", runs: 0, lastRunId: null };
    return () => {
      delete window.runBrowserAiTest;
      delete window.runBrowserAiMapReduceTest;
      delete window.runBenchmarkSinglePass;
      delete window.runBenchmarkMapReduce;
      delete window.cancelBrowserAiTest;
      delete window.getBenchmarkRuns;
    };
  }, []);

  const selectedRun = runs.find((r) => r.runId === selectedRunId) ?? null;
  const isRunning = active !== null;
  const canRun = !isRunning && (sourceKind === "synthetic" || uploadedFile !== null);

  return (
    <div style={{ padding: "20px", fontFamily: "monospace", maxWidth: "1100px" }}>
      <h1>Brave Benchmark Harness — Browser AI Prototype</h1>
      <p>
        <strong>PROTOTYPE / BENCHMARK ONLY.</strong> Run this benchmark in <strong>Brave</strong> for production-relevant
        results. Backend: <strong>WASM</strong> · Model: <strong>Qwen2.5-0.5B-Instruct q4</strong> (benchmark candidate) ·
        Transformers.js 4.2.0 · Local-only: no document content leaves this browser.
      </p>
      <p>
        Page visibility: <strong data-testid="visibility">{visibility}</strong> ({visibility === "visible" ? "foreground" : "background/hidden — expect throttling, do not work around it"}) ·
        Detected browser: <strong>{detectedBrowser}</strong>
      </p>

      <section style={{ border: "1px solid #999", padding: "12px", marginBottom: "12px" }}>
        <h2>Model (cold vs warm)</h2>
        <p>
          Lifecycle: <strong data-testid="lifecycle">{lifecycle}</strong> ·
          Last cold init: <strong data-testid="last-init-ms">{lastInitMs !== null ? `${lastInitMs.toFixed(0)}ms` : "—"}</strong>
        </p>
        <p style={{ fontSize: "12px" }}>
          COLD = this run initialized a new Worker/model (init time recorded in the run). WARM = reused the already
          initialized Worker/model (init time shown as —; see the earlier cold run for init cost). Model download is
          cached by the browser across reloads; init time still applies per page load.
        </p>
        {initError && <p data-testid="init-error" style={{ color: "red" }}>Init error: {initError}</p>}
        <button data-testid="init-model" onClick={() => void onInitClicked()} disabled={isRunning || lifecycle === "initializing"}>
          Initialize model now (cold start)
        </button>{" "}
        <button data-testid="reset-model" onClick={onResetModel} disabled={isRunning}>
          Reset model (terminate — next run is COLD)
        </button>{" "}
        <label>
          Device:{" "}
          <select value={device} onChange={(e) => setDevice(e.target.value as AiWorkerDevice)} disabled={isRunning || lifecycle === "ready"}>
            <option value="wasm">wasm (production target)</option>
            <option value="webgpu">webgpu (EXPERIMENTAL — not production)</option>
          </select>
        </label>{" "}
        <label>
          Model:{" "}
          <select value={candidate} onChange={(e) => setCandidate(e.target.value as Candidate)} disabled={isRunning || lifecycle === "ready"}>
            <option value="benchmark">Qwen2.5-0.5B q4 (benchmark target)</option>
            <option value="pilot">Qwen2.5-1.5B q4 (pilot)</option>
            <option value="experimentA">SmolLM2-360M q4f16 (experiment)</option>
            <option value="experimentAFp16">SmolLM2-360M fp16 (experiment)</option>
          </select>
        </label>
        <p style={{ fontSize: "12px" }}>Device/model lock while a model is initialized — Reset first to change them.</p>
      </section>

      <section style={{ border: "1px solid #999", padding: "12px", marginBottom: "12px" }}>
        <h2>Benchmark configuration</h2>
        <div>
          <label>
            Mode:{" "}
            <select value={mode} onChange={(e) => setMode(e.target.value as BenchmarkMode)} disabled={isRunning}>
              <option value="single-pass">Single-pass</option>
              <option value="map-reduce">Map→Reduce</option>
            </select>
          </label>{" "}
          <label>
            Source:{" "}
            <select value={sourceKind} onChange={(e) => setSourceKind(e.target.value as SourceKind)} disabled={isRunning}>
              <option value="synthetic">Synthetic fixture (repeatable)</option>
              <option value="uploaded">Uploaded PDF (real document)</option>
            </select>
          </label>{" "}
          {sourceKind === "synthetic" ? (
            <label>
              Pages:{" "}
              <select value={syntheticPages} onChange={(e) => setSyntheticPages(Number(e.target.value))} disabled={isRunning}>
                {BENCH_SYNTHETIC_PAGE_COUNTS.map((p) => (
                  <option key={p} value={p}>{p}</option>
                ))}
              </select>
            </label>
          ) : (
            <label>
              PDF: <input data-testid="real-pdf-input" type="file" accept="application/pdf" disabled={isRunning} onChange={(e) => setUploadedFile(e.target.files?.[0] ?? null)} />
              {uploadedFile && <span data-testid="real-pdf-selected-name"> selected: {uploadedFile.name} ({uploadedFile.size} bytes)</span>}
            </label>
          )}
        </div>
        {mode === "single-pass" ? (
          <div style={{ marginTop: "8px" }}>
            <label>
              Context budget (chars):{" "}
              <select value={contextBudget} onChange={(e) => setContextBudget(Number(e.target.value))} disabled={isRunning}>
                {BENCH_SINGLE_PASS_CONTEXT_BUDGETS.map((b) => (
                  <option key={b} value={b}>{b >= 1000 ? `${b / 1000}K` : b} ({b})</option>
                ))}
              </select>
            </label>{" "}
            <label>
              Output cap (tokens):{" "}
              <select value={singleCap} onChange={(e) => setSingleCap(Number(e.target.value) as BenchOutputCap)} disabled={isRunning}>
                {BENCH_OUTPUT_CAPS.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </label>
          </div>
        ) : (
          <div style={{ marginTop: "8px" }}>
            <label>
              Map batch size (chunks/call):{" "}
              <select value={batchSize} onChange={(e) => setBatchSize(Number(e.target.value) as BenchBatchSize)} disabled={isRunning}>
                {BENCH_BATCH_SIZES.map((b) => (
                  <option key={b} value={b}>{b}</option>
                ))}
              </select>
            </label>{" "}
            <label>
              Map output cap:{" "}
              <select value={mapCap} onChange={(e) => setMapCap(Number(e.target.value) as BenchOutputCap)} disabled={isRunning}>
                {BENCH_OUTPUT_CAPS.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </label>{" "}
            <label>
              Reduce output cap:{" "}
              <select value={reduceCap} onChange={(e) => setReduceCap(Number(e.target.value))} disabled={isRunning}>
                {REDUCE_CAP_OPTIONS.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </label>
          </div>
        )}
        <div style={{ marginTop: "8px" }}>
          <label>
            Browser label (recorded per run):{" "}
            <input value={browserLabel} onChange={(e) => setBrowserLabel(e.target.value)} disabled={isRunning} size={30} />
          </label>
        </div>
        <div style={{ marginTop: "8px" }}>
          <button data-testid="run-benchmark" onClick={() => void onRunClicked()} disabled={!canRun}>
            {isRunning ? "Benchmark running…" : "Run benchmark"}
          </button>{" "}
          <button data-testid="cancel" onClick={onCancelClicked} disabled={!isRunning}>
            Cancel
          </button>
        </div>
        <p data-testid="status">{status}</p>
      </section>

      <section style={{ border: "1px solid #999", padding: "12px", marginBottom: "12px" }}>
        <h2>Runs ({runs.length})</h2>
        <button
          data-testid="copy-all-runs"
          onClick={() => void copyText(JSON.stringify(runs, null, 2), `Copied ${runs.length} run(s). Paste into ChatGPT.`)}
          disabled={runs.length === 0}
        >
          Copy all runs JSON
        </button>{" "}
        {copyNote && <span>{copyNote}</span>}
        {runs.length === 0 ? (
          <p>No runs yet.</p>
        ) : (
          <table data-testid="runs-table" border={1} cellPadding={4} style={{ borderCollapse: "collapse", marginTop: "8px", fontSize: "12px" }}>
            <thead>
              <tr>
                <th>Run</th><th>Mode</th><th>Source</th><th>Pages</th><th>Chars</th><th>Budget/Batch</th>
                <th>Caps</th><th>Cold/Warm</th><th>Calls (M/R)</th><th>Init / Infer / Wall</th><th>Result</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r, i) => (
                <tr key={r.runId} onClick={() => setSelectedRunId(r.runId)} style={{ cursor: "pointer", background: r.runId === selectedRunId ? "#eef" : undefined }}>
                  <td>{i + 1}</td>
                  <td>{r.mode}</td>
                  <td>{r.source.kind === "synthetic" ? `synthetic ${r.source.pageCount}p` : `upload ${(r.source.filename ?? "").slice(0, 24)}`}</td>
                  <td>{r.pages ?? "?"}</td>
                  <td>{r.extractedCharacters}</td>
                  <td>{r.mode === "single-pass" ? `${r.actualContextChars}/${r.contextBudgetChars}` : `batch ${r.batchSize}`}</td>
                  <td>{r.mode === "single-pass" ? `out ${r.requestedMaxNewTokens}` : `map ${r.mapMaxNewTokens} / red ${r.reduceMaxNewTokens}`}</td>
                  <td>{r.coldWarm}</td>
                  <td>{r.mode === "single-pass" ? "1" : `${r.mapCalls}/${r.reduceCalls}`}</td>
                  <td>
                    {r.initializationMs !== null ? `${r.initializationMs.toFixed(0)}/` : "—/"}
                    {r.inferenceMsTotal.toFixed(0)}ms
                  </td>
                  <td>
                    {r.cancelled ? "CANCELLED" : r.success ? (r.partial ? "PARTIAL" : "SUCCESS") : r.partial ? "PARTIAL/FAILED" : "FAILED"}
                    {r.error ? ` — ${r.error.slice(0, 80)}` : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {selectedRun && (
        <section style={{ border: "1px solid #999", padding: "12px", marginBottom: "12px" }}>
          <h2>Run detail — {selectedRun.runId}</h2>
          <button data-testid="copy-run" onClick={() => void copyText(JSON.stringify(selectedRun, null, 2), "Run JSON copied. Paste into ChatGPT.")}>
            Copy this run JSON
          </button>
          <h3>Config & timing</h3>
          <pre data-testid="run-detail" style={{ whiteSpace: "pre-wrap", fontSize: "12px" }}>
            {JSON.stringify(
              {
                mode: selectedRun.mode,
                source: selectedRun.source,
                device: selectedRun.device,
                model: `${selectedRun.modelId} (${selectedRun.dtype})`,
                browser: selectedRun.browserLabel,
                coldWarm: selectedRun.coldWarm,
                pages: selectedRun.pages,
                extractedCharacters: selectedRun.extractedCharacters,
                chunks: selectedRun.chunks,
                pagesWithoutText: selectedRun.pagesWithoutText,
                ai02Truncated: selectedRun.ai02Truncated,
                contextBudget: selectedRun.contextBudgetChars,
                actualContextChars: selectedRun.actualContextChars,
                batchSize: selectedRun.batchSize,
                mapCap: selectedRun.mapMaxNewTokens,
                reduceCap: selectedRun.reduceMaxNewTokens,
                requestedCap: selectedRun.requestedMaxNewTokens,
                inputTokens: selectedRun.inputTokens,
                generatedTokens: selectedRun.generatedTokens,
                mapInputTokensTotal: selectedRun.mapInputTokensTotal,
                reduceInputTokens: selectedRun.reduceInputTokens,
                mapGeneratedTokensTotal: selectedRun.mapGeneratedTokensTotal,
                reduceGeneratedTokens: selectedRun.reduceGeneratedTokens,
                extractionMs: selectedRun.extractionMs,
                initializationMs: selectedRun.initializationMs,
                mapMsTotal: selectedRun.mapMsTotal,
                reduceMs: selectedRun.reduceMs,
                inferenceMsTotal: selectedRun.inferenceMsTotal,
                attemptedChunks: selectedRun.attemptedChunks,
                completedChunks: selectedRun.completedChunks,
                failedChunks: selectedRun.failedChunks,
                failedBatches: selectedRun.failedBatchIndexes,
                completedBatches: selectedRun.completedBatchIndexes,
                pagesRepresented: selectedRun.pagesRepresented,
                omittedPages: selectedRun.omittedPages,
                outputCharacters: selectedRun.outputCharacters,
                truncated: selectedRun.truncated,
                cancelled: selectedRun.cancelled,
                cancelObservedMs: selectedRun.cancelObservedMs,
                reusableAfterCancel: selectedRun.runtimeReusableAfterCancel,
                partial: selectedRun.partial,
                success: selectedRun.success,
                error: selectedRun.error,
                visibility: `${selectedRun.visibilityAtStart} -> ${selectedRun.visibilityAtEnd} (${selectedRun.visibilityChangesDuringRun} changes)`,
              },
              null,
              2,
            )}
          </pre>
          <h3>Log</h3>
          <pre data-testid="run-log" style={{ whiteSpace: "pre-wrap", fontSize: "12px", maxHeight: "300px", overflow: "auto" }}>
            {(runLogs[selectedRun.runId] ?? []).join("\n")}
          </pre>
          <h3>Outputs (inspect, do not auto-score)</h3>
          {selectedRun.mapSummaries !== null && (
            <>
              <h4>Map outputs ({selectedRun.mapSummaries.length}, batches [{selectedRun.completedBatchIndexes.join(",")}])</h4>
              {selectedRun.mapSummaries.map((s, i) => (
                <pre key={i} style={{ whiteSpace: "pre-wrap", fontSize: "12px", border: "1px solid #ccc", padding: "6px" }}>
                  [batch {selectedRun.completedBatchIndexes[i] ?? i}] {s}
                </pre>
              ))}
            </>
          )}
          <h4>Final summary</h4>
          <pre data-testid="run-summary" style={{ whiteSpace: "pre-wrap", fontSize: "12px", border: "1px solid #ccc", padding: "6px" }}>
            {selectedRun.summary ?? "(none)"}
          </pre>
          <h3>Qualitative review (manual checklist — not a score)</h3>
          {selectedRun.quality.map((q, i) => (
            <div key={q.criterionId} style={{ fontSize: "12px", marginBottom: "4px" }}>
              <strong>{q.criterionId}</strong>{" "}
              {(["unreviewed", "yes", "partial", "no", "n/a"] as BenchQualityStatus[]).map((s) => (
                <label key={s} style={{ marginRight: "6px" }}>
                  <input
                    type="radio"
                    name={`${selectedRun.runId}-${q.criterionId}`}
                    checked={q.status === s}
                    onChange={() => updateQuality(selectedRun.runId, i, { status: s })}
                  />{" "}
                  {s}
                </label>
              ))}{" "}
              <input
                placeholder="note"
                value={q.note}
                onChange={(e) => updateQuality(selectedRun.runId, i, { note: e.target.value })}
                size={40}
              />
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
