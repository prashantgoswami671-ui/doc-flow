"use client";

import { useEffect, useRef, useState } from "react";
import { selectAiRuntime } from "../services/ai/providerSelection";
import type { AiRuntime } from "../services/ai/types";
import { OllamaRuntime } from "../services/ai/ollama/runtime";
import { getOllamaAvailability } from "../services/ai/ollama/availability";
import { buildAiDisclosure, createAiConsentStore, grantAiConsent, type AiDisclosure, type AiConsentStore } from "../services/ai/consent";
import { generateKeyPoints, MAX_DISPLAY_KEY_POINTS, type KeyPointsResult } from "../services/ai/keyPoints";
import UploadZone from "./UploadZone";
import ResultPanel from "./ResultPanel";

type Provider = "browser" | "ollama";
type OllamaStatus = "idle" | "checking" | "ready" | "unavailable" | "model-unavailable" | "error";

function isPdf(file: File) { return file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf"); }

export default function KeyPointsPdfCard() {
  const runtimeRef = useRef<AiRuntime | null>(null);
  const ollamaRef = useRef<OllamaRuntime | null>(null);
  const consentRef = useRef<AiConsentStore | null>(null);
  const cancelRef = useRef(false);
  const requestRef = useRef(0);
  const [provider, setProvider] = useState<Provider>("browser");
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<KeyPointsResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);
  const [progress, setProgress] = useState({ completed: 0, total: 0 });
  const [ollamaStatus, setOllamaStatus] = useState<OllamaStatus>("idle");
  const [disclosure, setDisclosure] = useState<AiDisclosure | null>(null);
  const [consent, setConsent] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  const getOllama = () => (ollamaRef.current ??= new OllamaRuntime());
  const getConsent = () => (consentRef.current ??= createAiConsentStore());
  const checkOllama = async () => {
    setOllamaStatus("checking");
    try {
      const availability = await getOllamaAvailability(getOllama());
      if (availability.status === "available") { setOllamaStatus("ready"); setDisclosure(buildAiDisclosure(getOllama())); }
      else if (availability.status === "model-unavailable") setOllamaStatus("model-unavailable");
      else if (availability.status === "unavailable") setOllamaStatus("unavailable");
      else setOllamaStatus("error");
    } catch { setOllamaStatus("error"); }
  };
  useEffect(() => () => { (runtimeRef.current as (AiRuntime & { dispose?: () => void }) | null)?.dispose?.(); }, []);

  const changeProvider = (next: Provider) => {
    if (processing) return;
    requestRef.current++;
    setProvider(next); setResult(null); setError(null); setConsent(false); setDismissed(false);
    if (next === "ollama" && ollamaStatus !== "ready" && ollamaStatus !== "checking") void checkOllama();
  };
  const chooseFile = (candidate?: File) => {
    if (!candidate) return;
    requestRef.current++;
    if (!isPdf(candidate)) { setFile(null); setError("Please select a valid PDF file."); return; }
    setFile(candidate); setResult(null); setError(null); setDismissed(false);
  };
  const run = async () => {
    if (!file || processing) return;
    if (provider === "ollama" && (ollamaStatus !== "ready" || !consent)) { setDismissed(false); return; }
    const request = ++requestRef.current;
    cancelRef.current = false; setProcessing(true); setError(null); setResult(null); setProgress({ completed: 0, total: 0 });
    const runtime = provider === "ollama" ? new OllamaRuntime() : (runtimeRef.current ??= selectAiRuntime("browser").runtime);
    if (provider === "ollama") runtimeRef.current = runtime;
    try {
      const value = await generateKeyPoints({ file, runtime, isCancellationRequested: () => cancelRef.current, onProgress: (completed, total) => { if (request === requestRef.current) setProgress({ completed, total }); } });
      if (request === requestRef.current) setResult(value);
    } catch (reason) { if (request === requestRef.current) setError(reason instanceof Error ? `Key points failed: ${reason.message}` : "Key points failed."); }
    finally {
      if (provider === "ollama") { (runtime as OllamaRuntime).dispose(); runtimeRef.current = null; }
      if (request === requestRef.current) setProcessing(false);
    }
  };
  const cancel = () => { cancelRef.current = true; (runtimeRef.current as (AiRuntime & { cancel?: () => void }) | null)?.cancel?.(); };
  const reset = () => { requestRef.current++; cancelRef.current = true; setFile(null); setResult(null); setError(null); setProgress({ completed: 0, total: 0 }); };
  const visible = result?.points.slice(0, MAX_DISPLAY_KEY_POINTS) ?? [];
  const omitted = result ? Math.max(0, result.points.length - visible.length) : 0;
  const showDisclosure = provider === "ollama" && ollamaStatus === "ready" && disclosure && !consent && !dismissed && file;
  const copyPoints = async () => {
    const text = visible.map((point) => point.text).join("\n\n");
    if (text) await navigator.clipboard?.writeText(text);
  };

  return <div className="mx-auto w-full max-w-2xl px-4 sm:px-6">
    <div className="overflow-hidden rounded-2xl border border-gray-100 bg-white shadow-lg">
      <div className="px-4 pt-6 sm:px-6 sm:pt-8">
        <h2 className="text-xl font-bold text-gray-900">Key Points</h2>
        <p className="mt-1 text-sm text-gray-500">Extract concise key points from your PDF.</p>
        <fieldset className="mt-4"><legend className="text-xs font-semibold text-gray-500">AI provider</legend><div className="mt-2 flex flex-col gap-2 sm:flex-row sm:gap-4">
          <label className="flex items-center gap-2 text-sm text-gray-700"><input type="radio" name="key-points-provider" checked={provider === "browser"} disabled={processing} onChange={() => changeProvider("browser")} />Browser AI (on-device)</label>
          <label className="flex items-center gap-2 text-sm text-gray-700"><input type="radio" name="key-points-provider" checked={provider === "ollama"} disabled={processing} onChange={() => changeProvider("ollama")} />Ollama (qwen3:4b, local service)</label>
        </div></fieldset>
        {provider === "ollama" && ollamaStatus === "checking" && <p role="status" className="mt-2 text-xs text-gray-500">Checking local Ollama service...</p>}
        {provider === "ollama" && ollamaStatus === "ready" && <p role="status" className="mt-2 text-xs text-green-700">Ollama is available.</p>}
        {provider === "ollama" && ollamaStatus === "unavailable" && <p role="alert" className="mt-2 text-xs text-red-600">Ollama is unavailable.</p>}
        {provider === "ollama" && ollamaStatus === "model-unavailable" && <p role="alert" className="mt-2 text-xs text-red-600">The qwen3:4b Ollama model is not installed.</p>}
      </div>
      <UploadZone accept=".pdf,application/pdf" onFileSelect={(candidate) => void chooseFile(candidate)} disabled={processing} title="Choose a PDF for key points" helperText="or drag and drop it here" className="mx-4 mb-4 mt-6 sm:mx-6" />
      <div className="px-4 pb-6 sm:px-6">
        {file && <p className="mb-4 truncate rounded-lg border border-gray-200 bg-gray-50 px-4 py-3 text-sm font-medium text-gray-800">{file.name}</p>}
        {showDisclosure && <div aria-label="Ollama consent disclosure" className="mb-4 rounded-lg border border-blue-200 bg-blue-50 px-4 py-3"><p className="text-sm font-semibold text-gray-900">{disclosure.headline}</p><ul className="mt-2 list-disc pl-5 text-xs text-gray-700">{disclosure.points.map((point) => <li key={point}>{point}</li>)}</ul><div className="mt-3 flex gap-2"><button type="button" onClick={() => { grantAiConsent(getConsent(), disclosure.providerId); setConsent(true); setDismissed(false); }} className="rounded-lg bg-blue-600 px-3 py-2 text-xs font-semibold text-white">{disclosure.confirmLabel ?? "Approve"}</button><button type="button" onClick={() => setDismissed(true)} className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-xs font-semibold text-gray-700">Cancel</button></div></div>}
        {processing && <p role="status" className="mb-3 text-sm text-gray-600">{progress.total ? `Generating chunk ${Math.min(progress.completed + 1, progress.total)} of ${progress.total}...` : "Extracting text..."}</p>}
        {error && <p role="alert" className="mb-3 text-sm font-medium text-red-600">{error}</p>}
        <div className="mt-6 flex gap-3"><button type="button" onClick={() => void run()} disabled={!file || processing || (provider === "ollama" && ollamaStatus !== "ready")} className="flex-1 rounded-lg bg-blue-600 px-4 py-3 text-sm font-semibold text-white disabled:bg-gray-200 disabled:text-gray-400">{processing ? "Generating..." : "Get key points"}</button>{processing && <button type="button" onClick={cancel} className="rounded-lg border border-gray-300 bg-white px-4 py-3 text-sm font-semibold text-gray-700">Cancel</button>}</div>
      </div>
      {result && <ResultPanel icon="•" title={result.status === "no-text" ? "No extractable text found" : result.status === "provider-failed" ? "Key points failed" : result.status === "cancelled" || result.status === "partial" ? "Key points incomplete" : "Key points ready"} message={`${result.sourcePageCount} page${result.sourcePageCount === 1 ? "" : "s"}`} onReset={reset} resetLabel="Choose another PDF">
        {result.status === "no-text" && <p className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">This PDF has no extractable text. OCR is not included.</p>}
        {result.status === "provider-failed" && <p role="alert" className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">{result.providerError ?? "The selected AI provider failed."}</p>}
        {result.pagesWithoutText.length > 0 && result.status !== "no-text" && <p className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">No extractable text was found on page{result.pagesWithoutText.length === 1 ? "" : "s"} {result.pagesWithoutText.join(", ")}.</p>}
        {result.failedChunkIndexes.length > 0 && <p className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">{result.failedChunkIndexes.length} text chunk{result.failedChunkIndexes.length === 1 ? "" : "s"} could not be processed.</p>}
        {result.truncated && <p className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">The extracted PDF context was truncated before key-point generation.</p>}
        {omitted > 0 && <p className="mb-3 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-800">Showing {visible.length} of {result.points.length} key points ({omitted} omitted).</p>}
        <ol className="list-decimal space-y-2 pl-5 text-sm text-gray-800">{visible.map((point) => <li key={point.pointIndex}>{point.text}<span className="ml-2 text-xs text-gray-500">(page {point.sourcePageNumber}, chunk {point.sourceChunkIndex + 1})</span></li>)}</ol>
        {visible.length > 0 && <button type="button" onClick={() => void copyPoints()} className="mt-4 w-full rounded-lg border border-gray-300 bg-white py-2 text-sm font-semibold text-gray-700">Copy key points</button>}
      </ResultPanel>}
    </div>
  </div>;
}
