"use client";

/*
 * Checkpoint 2A — Browser AI Prototype Test Harness (PROTOTYPE ONLY)
 *
 * Mirrors the pattern established by app/test/compression/page.tsx
 * (Phase 3.3): a plain, Playwright-drivable harness page, not linked
 * from any production navigation, exercising the ACTUAL prototype code
 * (services/ai-prototype/*) and the ACTUAL AI-01/AI-02 foundation
 * (services/ai/*) — no mocks, no fabricated prompt/context data.
 *
 * Flow (checkpoint spec §6): load model -> load a real PDF -> build
 * AI-02 context -> construct the fixed prototype prompt -> run local
 * inference -> display the response -> record timings.
 *
 * Nothing here downloads the model or starts the Worker on page load —
 * every network/model-loading action is behind an explicit button click
 * (checkpoint spec §9/§10).
 */

import { useEffect, useRef, useState } from "react";
import { buildAiTextContext } from "@/services/ai/pipeline";
import {
  buildTextVectorPdfBytes,
  toFile,
} from "@/services/pdf/__fixtures__/pdf";
import { buildSummarizePrompt } from "@/services/ai-prototype/promptBuilder";
import { BrowserAiWorkerClient } from "@/services/ai-prototype/browserAiWorkerClient";
import { runMapReduceSummarize } from "@/services/ai-prototype/mapReduceRunner";
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
import type { AiWorkerDevice } from "@/services/ai-prototype/workerProtocol";

type Candidate = "pilot" | "benchmark" | "experimentA" | "experimentAFp16";

const CANDIDATE_CONFIG: Record<Candidate, { modelId: string; dtype: string }> = {
  pilot: { modelId: PILOT_MODEL_ID, dtype: PILOT_MODEL_DTYPE },
  benchmark: { modelId: BENCHMARK_CANDIDATE_MODEL_ID, dtype: BENCHMARK_CANDIDATE_DTYPE },
  // Checkpoint 2A, Experiment A — see services/ai-prototype/constants.ts
  // for why SmolLM2-360M-Instruct-ONNX / q4f16 was chosen (normal-sized
  // vocabulary vs. Qwen's, to isolate whether vocab size was the
  // dominant driver of the ~1.79 GB Qwen2.5-1.5B download).
  experimentA: { modelId: EXPERIMENT_A_MODEL_ID, dtype: EXPERIMENT_A_DTYPE },
  // Checkpoint 2A, Experiment A follow-up — single-variable change from
  // the row above (same model, only dtype differs) to isolate whether
  // q4f16 specifically caused the observed token-ID-0 degeneration.
  experimentAFp16: { modelId: EXPERIMENT_A_MODEL_ID, dtype: EXPERIMENT_A_FP16_DTYPE },
};

interface HarnessState {
  status: string;
  log: string[];
  webgpuAdapterAvailable: boolean | null;
  modelInitMs: number | null;
  contextBuildMs: number | null;
  inferenceMs: number | null;
  summary: string | null;
  cancelled: boolean;
  error: string | null;
  downloadedBytesObserved: number | null;
}

const INITIAL_STATE: HarnessState = {
  status: "idle",
  log: [],
  webgpuAdapterAvailable: null,
  modelInitMs: null,
  contextBuildMs: null,
  inferenceMs: null,
  summary: null,
  cancelled: false,
  error: null,
  downloadedBytesObserved: null,
};

declare global {
  interface Window {
    runBrowserAiTest?: (device: AiWorkerDevice, candidate?: Candidate, pageCount?: number) => Promise<void>;
    // Checkpoint 2A/2B — Map -> Reduce experiment entry point, same
    // Playwright-drivable-window-hook pattern as runBrowserAiTest above.
    // Optional 5th param (Experiment 4, additive) — Map-stage-only
    // generation-token limit; omitted/undefined reproduces prior behavior
    // exactly (Reduce always stays at PROTOTYPE_MAX_NEW_TOKENS).
    runBrowserAiMapReduceTest?: (
      device: AiWorkerDevice,
      candidate: Candidate,
      pageCount: number,
      batchSize: number,
      mapMaxNewTokens?: number,
    ) => Promise<void>;
    cancelBrowserAiTest?: () => void;
    browserAiHarnessState?: HarnessState;
  }
}

export default function BrowserAiTestPage() {
  const [state, setState] = useState<HarnessState>(INITIAL_STATE);
  const [client, setClient] = useState<BrowserAiWorkerClient | null>(null);
  const [activeRequestId, setActiveRequestId] = useState<string | null>(null);
  const [realPdfFile, setRealPdfFile] = useState<File | null>(null);
  // Checkpoint 2A/2B — Map -> Reduce cancellation flag, checked BETWEEN
  // generations (see mapReduceRunner.ts's isCancelled callback), since
  // client.cancel(activeRequestId) alone only stops a generation already
  // in flight and would not, by itself, stop the next Map batch from
  // starting. A ref (not state) so cancelTest() reads/writes it
  // synchronously without waiting on a re-render.
  const mapReduceCancelRef = useRef(false);

  function appendLog(line: string) {
    setState((prev) => {
      const next = { ...prev, log: [...prev.log, line] };
      window.browserAiHarnessState = next;
      return next;
    });
  }

  function update(patch: Partial<HarnessState>) {
    setState((prev) => {
      const next = { ...prev, ...patch };
      window.browserAiHarnessState = next;
      return next;
    });
  }

  async function checkWebGpuAdapter(): Promise<boolean> {
    // Checkpoint spec §8: "Do not treat navigator.gpu existence alone as
    // proof" — this actually calls requestAdapter().
    const gpu = (navigator as unknown as { gpu?: { requestAdapter: () => Promise<unknown> } }).gpu;
    if (!gpu) return false;
    try {
      const adapter = await gpu.requestAdapter();
      return adapter !== null;
    } catch {
      return false;
    }
  }

  async function runWithDocument(
    device: AiWorkerDevice,
    candidate: Candidate,
    getFile: () => Promise<File>,
    sourceLabel: string,
  ) {
    setState({ ...INITIAL_STATE, status: "running" });
    window.browserAiHarnessState = { ...INITIAL_STATE, status: "running" };

    try {
      const webgpuAdapterAvailable = await checkWebGpuAdapter();
      update({ webgpuAdapterAvailable });
      appendLog(`navigator.gpu.requestAdapter() -> ${webgpuAdapterAvailable ? "available" : "unavailable"}`);

      if (device === "webgpu" && !webgpuAdapterAvailable) {
        throw new Error(
          "WebGPU path requested but no adapter is available in this browser/environment — recording as a discovered limitation, not silently falling back to WASM.",
        );
      }

      const { modelId, dtype } = CANDIDATE_CONFIG[candidate];

      appendLog(`Initializing model ${modelId} (device=${device}, dtype=${dtype})...`);
      const newClient = new BrowserAiWorkerClient({
        onInitProgress: (progress) => {
          if (progress.total) {
            update({ downloadedBytesObserved: progress.loaded ?? null });
          }
          appendLog(
            `[init-progress] ${progress.status}${progress.file ? ` ${progress.file}` : ""}${
              progress.loaded && progress.total
                ? ` (${progress.loaded}/${progress.total} bytes)`
                : ""
            }`,
          );
        },
        onToken: () => {
          // Streaming tokens are logged at completion (full text) to keep
          // the harness's DOM small for Playwright; token-by-token
          // arrival itself is what proves streaming/UI-responsiveness
          // (checkpoint spec §13), not the harness's own rendering.
        },
      });

      const { modelInitMs } = await newClient.initModel({ device, modelId, dtype });
      setClient(newClient);
      update({ modelInitMs });
      appendLog(`Model ready in ${modelInitMs.toFixed(0)}ms.`);

      appendLog(`Loading document: ${sourceLabel}`);
      const file = await getFile();

      const contextStart = performance.now();
      const context = await buildAiTextContext(file);
      const contextBuildMs = performance.now() - contextStart;
      update({ contextBuildMs });
      appendLog(
        `AI-02 context built in ${contextBuildMs.toFixed(1)}ms: ${context.chunks.length} chunk(s), ${context.totalCharacters} chars, truncated=${context.truncated}, pagesWithoutText=${context.pagesWithoutText.length}.`,
      );

      const messages = buildSummarizePrompt({
        chunks: context.chunks,
        hasPagesWithoutText: context.pagesWithoutText.length > 0,
        wasTruncated: context.truncated,
      });

      appendLog("Running inference...");
      const { requestId, result } = newClient.generate(messages, PROTOTYPE_MAX_NEW_TOKENS);
      setActiveRequestId(requestId);

      const generation = await result;
      setActiveRequestId(null);

      if (generation.cancelled) {
        update({ cancelled: true, status: "cancelled", summary: generation.text || null });
        appendLog("Generation was cancelled.");
        return;
      }

      update({
        inferenceMs: generation.inferenceMs,
        summary: generation.text,
        status: "complete",
      });
      appendLog(
        `Inference complete in ${generation.inferenceMs.toFixed(0)}ms, ${generation.outputCharacters} output characters.`,
      );

      // [Checkpoint 2A diagnostic] Concise summary only — deliberately not
      // dumping the full generated-token sequence or the untruncated raw
      // decode into the harness log.
      if (generation.diagnostic) {
        const d = generation.diagnostic;
        appendLog(
          `Diagnostic: generatedTokenCount=${d.generatedTokenCount} specialTokenCount=${d.specialTokenCount} ` +
            `firstTokenIds=[${d.firstTokenIds.join(", ")}] lastTokenIds=[${d.lastTokenIds.join(", ")}] ` +
            `streamedOutputCharacters=${d.streamedOutputCharacters} rawDecoded=${JSON.stringify(d.rawDecoded)} ` +
            `inputTokenCount=${d.inputTokenCount}`,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      update({ status: "error", error: message });
      appendLog(`ERROR: ${message}`);
    }
  }

  /** Unchanged existing entry point — synthetic-fixture path, same signature, same window hook (checkpoint 2A). */
  async function runTest(device: AiWorkerDevice, candidate: Candidate = "pilot", pageCount = 2) {
    await runWithDocument(
      device,
      candidate,
      async () => {
        // Real PDF fixture (checkpoint spec §15) — a text/vector fixture
        // with genuine selectable text, the same one already used by
        // app/test/compression/page.tsx, run through the real AI-02
        // pipeline. Never manually pasted text into the inference call.
        const pdfBytes = await buildTextVectorPdfBytes(pageCount);
        return toFile(pdfBytes, "browser-ai-prototype-fixture.pdf");
      },
      `synthetic ${pageCount}-page fixture`,
    );
  }

  /**
   * Checkpoint 2B — real-document validation. Takes the ACTUAL uploaded
   * File (bytes come from the user's file picker, never fabricated) and
   * runs it through the identical init -> AI-02 -> prompt -> inference
   * path runTest() already uses. Device/candidate are required (no
   * defaults) so this can never silently run on a different model than
   * what was explicitly requested.
   */
  async function runRealPdfTest(device: AiWorkerDevice, candidate: Candidate, file: File) {
    await runWithDocument(
      device,
      candidate,
      async () => file,
      `uploaded PDF "${file.name}" (${file.size} bytes)`,
    );
  }

  function cancelTest() {
    mapReduceCancelRef.current = true;
    if (client && activeRequestId) {
      client.cancel(activeRequestId);
      appendLog("Cancel requested.");
    }
  }

  /**
   * Checkpoint 2A/2B — Map -> Reduce experiment. Same init -> AI-02 flow
   * as runTest() above (identical model/device/candidate/fixture
   * handling — nothing about model loading or AI-02 context building
   * changes here), but instead of one buildSummarizePrompt() call over
   * the entire context, it hands the context's chunks to
   * runMapReduceSummarize() (services/ai-prototype/mapReduceRunner.ts),
   * which sequences bounded per-batch Map generations followed by one
   * Reduce generation, all against the same initialized client/session.
   */
  async function runMapReduceTest(
    device: AiWorkerDevice,
    candidate: Candidate,
    pageCount: number,
    batchSize: number,
    mapMaxNewTokens?: number,
  ) {
    setState({ ...INITIAL_STATE, status: "running" });
    window.browserAiHarnessState = { ...INITIAL_STATE, status: "running" };
    mapReduceCancelRef.current = false;

    try {
      const webgpuAdapterAvailable = await checkWebGpuAdapter();
      update({ webgpuAdapterAvailable });
      appendLog(`navigator.gpu.requestAdapter() -> ${webgpuAdapterAvailable ? "available" : "unavailable"}`);

      if (device === "webgpu" && !webgpuAdapterAvailable) {
        throw new Error(
          "WebGPU path requested but no adapter is available in this browser/environment — recording as a discovered limitation, not silently falling back to WASM.",
        );
      }

      const { modelId, dtype } = CANDIDATE_CONFIG[candidate];

      appendLog(`[Map->Reduce] Initializing model ${modelId} (device=${device}, dtype=${dtype})...`);
      const newClient = new BrowserAiWorkerClient({
        onInitProgress: (progress) => {
          if (progress.total) {
            update({ downloadedBytesObserved: progress.loaded ?? null });
          }
          appendLog(
            `[init-progress] ${progress.status}${progress.file ? ` ${progress.file}` : ""}${
              progress.loaded && progress.total
                ? ` (${progress.loaded}/${progress.total} bytes)`
                : ""
            }`,
          );
        },
        onToken: () => {
          // Same rationale as runWithDocument(): logged at completion, not
          // token-by-token, to keep the harness's DOM small for Playwright.
        },
      });

      const { modelInitMs } = await newClient.initModel({ device, modelId, dtype });
      setClient(newClient);
      update({ modelInitMs });
      appendLog(`[Map->Reduce] Model ready in ${modelInitMs.toFixed(0)}ms.`);

      appendLog(`[Map->Reduce] Loading document: synthetic ${pageCount}-page fixture`);
      const pdfBytes = await buildTextVectorPdfBytes(pageCount);
      const file = toFile(pdfBytes, "browser-ai-prototype-fixture.pdf");

      const contextStart = performance.now();
      const context = await buildAiTextContext(file);
      const contextBuildMs = performance.now() - contextStart;
      update({ contextBuildMs });
      appendLog(
        `[Map->Reduce] AI-02 context built in ${contextBuildMs.toFixed(1)}ms: ${context.chunks.length} chunk(s), ${context.totalCharacters} chars, truncated=${context.truncated}, pagesWithoutText=${context.pagesWithoutText.length}.`,
      );
      appendLog(`[Map->Reduce] batchSize=${batchSize} chunks/batch -> ${Math.ceil(context.chunks.length / batchSize)} Map batch(es).`);
      if (mapMaxNewTokens !== undefined) {
        appendLog(
          `[Map->Reduce] Experiment 4: Map maxNewTokens=${mapMaxNewTokens} (Reduce maxNewTokens=${PROTOTYPE_MAX_NEW_TOKENS} unchanged).`,
        );
      }

      const mapReduceStart = performance.now();

      const outcome = await runMapReduceSummarize({
        client: newClient,
        chunks: context.chunks,
        batchSize,
        maxNewTokens: PROTOTYPE_MAX_NEW_TOKENS,
        mapMaxNewTokens,
        hasPagesWithoutText: context.pagesWithoutText.length > 0,
        wasTruncated: context.truncated,
        isCancelled: () => mapReduceCancelRef.current,
        onActiveRequestId: (requestId) => setActiveRequestId(requestId),
        onProgress: (event) => {
          if (event.stage === "map") {
            appendLog(`[Map->Reduce] Map batch ${(event.batchIndex ?? 0) + 1}/${event.batchCount} starting...`);
          } else {
            appendLog("[Map->Reduce] Reduce stage: combining intermediate summaries...");
          }
        },
        onDiagnostic: (entry) => {
          const label =
            entry.stage === "map"
              ? `Map batch ${(entry.batchIndex ?? 0) + 1}/${entry.batchCount}`
              : "Reduce";
          appendLog(
            `[Map->Reduce] ${label} (gen #${entry.generationNumber}): inputChars=${entry.inputCharacters}` +
              `${entry.chunksInBatch !== null ? ` chunksInBatch=${entry.chunksInBatch}` : ""}` +
              ` inferenceMs=${entry.inferenceMs.toFixed(0)} outputChars=${entry.outputCharacters}` +
              `${entry.generatedTokenCount !== null ? ` generatedTokens=${entry.generatedTokenCount}` : ""}` +
              `${entry.inputTokenCount !== null ? ` inputTokenCount=${entry.inputTokenCount}` : ""}` +
              `${entry.cancelled ? " CANCELLED" : ""}${entry.error ? ` ERROR=${entry.error}` : ""}`,
          );
        },
      });

      setActiveRequestId(null);
      const totalElapsedMs = performance.now() - mapReduceStart;

      if (outcome.cancelled) {
        update({ cancelled: true, status: "cancelled", summary: outcome.finalSummary });
        appendLog(
          `[Map->Reduce] Cancelled after ${outcome.diagnostics.length} generation(s), ${totalElapsedMs.toFixed(0)}ms elapsed. ${outcome.intermediateSummaries.length} intermediate summary(ies) completed before cancellation.`,
        );
        return;
      }

      update({ status: "complete", summary: outcome.finalSummary });
      appendLog(
        `[Map->Reduce] Complete: ${outcome.intermediateSummaries.length} intermediate summary(ies) -> 1 final summary, ` +
          `${outcome.diagnostics.length} total generation(s), ${totalElapsedMs.toFixed(0)}ms total elapsed.`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      update({ status: "error", error: message });
      appendLog(`[Map->Reduce] ERROR: ${message}`);
    }
  }

  function resetHarness() {
    client?.terminate();
    setClient(null);
    setActiveRequestId(null);
    setState(INITIAL_STATE);
    window.browserAiHarnessState = INITIAL_STATE;
  }

  useEffect(() => {
    window.runBrowserAiTest = runTest;
    window.runBrowserAiMapReduceTest = runMapReduceTest;
    window.cancelBrowserAiTest = cancelTest;

    return () => {
      delete window.runBrowserAiTest;
      delete window.runBrowserAiMapReduceTest;
      delete window.cancelBrowserAiTest;
    };
  });

  return (
    <div style={{ padding: "20px", fontFamily: "monospace" }}>
      <h1>Checkpoint 2A — Browser AI Prototype Harness</h1>
      <p>Prototype only — see services/ai-prototype/README.md.</p>

      <div style={{ marginBottom: "16px" }}>
        <button data-testid="run-webgpu" onClick={() => runTest("webgpu", "pilot")}>
          Run Qwen pilot (WebGPU)
        </button>{" "}
        <button data-testid="run-wasm" onClick={() => runTest("wasm", "pilot")}>
          Run Qwen pilot (WASM)
        </button>{" "}
        <button data-testid="run-benchmark-candidate" onClick={() => runTest("wasm", "benchmark")}>
          Run Qwen 0.5B benchmark (WASM)
        </button>{" "}
        <button data-testid="run-benchmark-candidate-webgpu" onClick={() => runTest("webgpu", "benchmark")}>
          Run Qwen 0.5B benchmark (WebGPU)
        </button>{" "}
        <button data-testid="run-benchmark-candidate-wasm-large" onClick={() => runTest("wasm", "benchmark", 20)}>
          Run Qwen 0.5B benchmark (WASM, large doc)
        </button>{" "}
        {/* Checkpoint 2B — medium-context stress test. Same benchmark
            candidate/device/path as the buttons above; pageCount=41 chosen
            from the fixture's empirical ~196.3 chars/page ratio (392/2 and
            3931/20 from prior runs) to target ~8,000 extracted chars —
            between the working 20-page (~3,931 char) run and the real PDF's
            12,063-char OrtRun() bad_alloc failure. */}
        <button data-testid="run-benchmark-candidate-wasm-medium" onClick={() => runTest("wasm", "benchmark", 41)}>
          Run Qwen 0.5B benchmark (WASM, medium doc ~8k chars)
        </button>{" "}
        {/* Checkpoint 2B — intermediate isolation point between the
            8,068-char synthetic success and the 12,063-char real-PDF
            std::bad_alloc failure, to separate a pure size effect from
            possible real-PDF-specific tokenization/memory differences.
            pageCount=51 chosen from the fixture's refined ~196.4
            chars/page ratio (392/2, 3931/20, 8068/41) to target ~10,000
            chars. */}
        <button data-testid="run-benchmark-candidate-wasm-10k" onClick={() => runTest("wasm", "benchmark", 51)}>
          Run Qwen 0.5B benchmark (WASM, ~10k doc)
        </button>{" "}
        <button data-testid="run-experiment-a-webgpu" onClick={() => runTest("webgpu", "experimentA")}>
          Run Experiment A: SmolLM2-360M (WebGPU)
        </button>{" "}
        <button data-testid="run-experiment-a-wasm" onClick={() => runTest("wasm", "experimentA")}>
          Run Experiment A: SmolLM2-360M (WASM)
        </button>{" "}
        <button data-testid="run-experiment-a-fp16-webgpu" onClick={() => runTest("webgpu", "experimentAFp16")}>
          Run Experiment A: SmolLM2-360M fp16 (WebGPU)
        </button>{" "}
        {/* Checkpoint 2A/2B — Map -> Reduce experiment (see
            services/ai-prototype/mapReduceRunner.ts). Fixed to the
            already-proven-working 41-page/~8k-char synthetic fixture and
            the benchmark candidate/WASM path per the checkpoint spec's
            first-experiment design — a conservative 3-chunks-per-batch
            size, well below the observed single-pass memory boundary. */}
        <button
          data-testid="run-map-reduce-medium"
          onClick={() => runMapReduceTest("wasm", "benchmark", 41, 3)}
        >
          Run Map→Reduce (WASM, medium doc ~8k chars, batch=3)
        </button>{" "}
        {/* Checkpoint 2A/2B — controlled input-token instrumentation
            experiment. Reuses the exact same runMapReduceTest() harness
            path as the button above (no new implementation) — only the
            pageCount differs (6 instead of 41), matching the previously
            verified fresh-session run (6-page fixture -> 6 AI-02 chunks,
            batchSize=3 -> 2 Map batches + 1 Reduce). Same device, same
            candidate/model/dtype, same batchSize, same maxNewTokens
            (PROTOTYPE_MAX_NEW_TOKENS, unchanged, passed through
            runMapReduceTest exactly as the 41-page button does). */}
        <button
          data-testid="run-map-reduce-6page"
          onClick={() => runMapReduceTest("wasm", "benchmark", 6, 3)}
        >
          Run Map→Reduce (WASM, 6-page, batch=3)
        </button>{" "}
        {/* Experiment 4 — Map output-length control. Reuses the exact
            same runMapReduceTest() harness path and the same 6-page
            fixture/batchSize=3 as the button above — only the new
            optional mapMaxNewTokens argument differs (64), which is
            threaded through to runMapReduceSummarize()'s additive
            `mapMaxNewTokens` option (mapReduceRunner.ts). Map-stage
            generations use maxNewTokens=64; Reduce is untouched and
            still uses PROTOTYPE_MAX_NEW_TOKENS (256). No prompts,
            cancellation, worker lifecycle, or instrumentation changed. */}
        <button
          data-testid="run-map-reduce-6page-map64"
          onClick={() => runMapReduceTest("wasm", "benchmark", 6, 3, 64)}
        >
          Run Map→Reduce (WASM, 6-page, Map=64)
        </button>{" "}
        {/* Experiment 5 — Map batch-size control. Reuses the exact same
            runMapReduceTest() harness path and the same 6-page fixture as
            the two buttons above — only batchSize differs (6, so all 6
            AI-02 chunks land in a single Map batch -> 1 Map generation +
            1 Reduce). No mapMaxNewTokens argument is passed, so Map falls
            back to the same default (PROTOTYPE_MAX_NEW_TOKENS = 256) as
            Reduce — isolating batch size as the only independent variable
            versus the batch=3 button, and avoiding the Experiment 4
            Map=64 override entirely. No prompts, AI-02, instrumentation,
            cancellation, or worker lifecycle changed. */}
        <button
          data-testid="run-map-reduce-6page-batch6"
          onClick={() => runMapReduceTest("wasm", "benchmark", 6, 6)}
        >
          Run Map→Reduce (WASM, 6-page, batch=6)
        </button>{" "}
        {/* Next experiment — 41-page batch=6 large-document test. Reuses
            the exact same runMapReduceTest() harness path as the buttons
            above — only pageCount (41) and batchSize (6) differ, matching
            the proven 41-page/~8k-char fixture from run-map-reduce-medium
            with the batch=6 grouping from run-map-reduce-6page-batch6.
            No mapMaxNewTokens argument is passed, so both Map and Reduce
            use PROTOTYPE_MAX_NEW_TOKENS (256), unchanged. Expected:
            ceil(41 / 6) = 7 Map batches + 1 Reduce = 8 total generations.
            No prompts, AI-02, instrumentation, cancellation, or worker
            lifecycle changed. */}
        <button
          data-testid="run-map-reduce-41page-batch6"
          onClick={() => runMapReduceTest("wasm", "benchmark", 41, 6)}
        >
          Run Map→Reduce (WASM, 41-page, batch=6)
        </button>{" "}
        <button data-testid="cancel" onClick={cancelTest}>
          Cancel
        </button>{" "}
        <button data-testid="reset" onClick={resetHarness}>
          Reset
        </button>
      </div>

      {/* Checkpoint 2B — real-document validation. Routes a real uploaded
          PDF (never fabricated) through the exact same init -> AI-02 ->
          prompt -> inference path as the buttons above, locked to the
          proven Qwen 0.5B q4 WASM benchmark candidate — nothing here
          changes model/dtype/device/prompt/generation config. */}
      <div style={{ marginBottom: "16px" }}>
        <input
          type="file"
          accept="application/pdf"
          data-testid="real-pdf-input"
          onChange={(event) => setRealPdfFile(event.target.files?.[0] ?? null)}
        />{" "}
        <button
          data-testid="run-real-pdf-benchmark-wasm"
          disabled={!realPdfFile}
          onClick={() => realPdfFile && runRealPdfTest("wasm", "benchmark", realPdfFile)}
        >
          Run REAL PDF — Qwen 0.5B benchmark (WASM)
        </button>
        {realPdfFile && (
          <span data-testid="real-pdf-selected-name">
            {" "}
            selected: {realPdfFile.name} ({realPdfFile.size} bytes)
          </span>
        )}
      </div>

      <div data-testid="status">{state.status}</div>
      <div data-testid="webgpu-adapter-available">{String(state.webgpuAdapterAvailable)}</div>
      <div data-testid="model-init-ms">{state.modelInitMs ?? ""}</div>
      <div data-testid="context-build-ms">{state.contextBuildMs ?? ""}</div>
      <div data-testid="inference-ms">{state.inferenceMs ?? ""}</div>
      <div data-testid="cancelled">{String(state.cancelled)}</div>
      {state.error && <div data-testid="error">{state.error}</div>}
      {state.summary && <div data-testid="summary">{state.summary}</div>}

      <h2>Log</h2>
      <pre data-testid="log">{state.log.join("\n")}</pre>
    </div>
  );
}
