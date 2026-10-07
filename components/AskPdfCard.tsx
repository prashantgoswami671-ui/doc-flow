"use client";

import { useEffect, useRef, useState } from "react";
import { selectAiRuntime } from "../services/ai/providerSelection";
import type { AiRuntime } from "../services/ai/types";
import { OllamaRuntime } from "../services/ai/ollama/runtime";
import { getOllamaAvailability } from "../services/ai/ollama/availability";
import { buildAiDisclosure, createAiConsentStore, grantAiConsent, type AiConsentStore, type AiDisclosure } from "../services/ai/consent";
import { askPdf, prepareAskPdfContext, type AskPdfResult } from "../services/ai/askPdf";
import type { BuildAiTextContextResult } from "../services/ai/pipeline";
import UploadZone from "./UploadZone";
import ResultPanel from "./ResultPanel";

type Provider = "browser" | "ollama";
type OllamaStatus = "idle" | "checking" | "ready" | "unavailable" | "model-unavailable" | "error";

function isPdf(file: File): boolean {
  return file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
}

function invalidateRequest(ref: { current: number }): void {
  ref.current++;
}

export default function AskPdfCard() {
  const runtimeRef = useRef<AiRuntime | null>(null);
  const ollamaRef = useRef<OllamaRuntime | null>(null);
  const consentRef = useRef<AiConsentStore | null>(null);
  const requestRef = useRef(0);
  const availabilityRequestRef = useRef(0);
  const cancelRef = useRef(false);
  const mountedRef = useRef(true);
  const providerRef = useRef<Provider>("browser");
  const [provider, setProvider] = useState<Provider>("browser");
  const [file, setFile] = useState<File | null>(null);
  const [context, setContext] = useState<BuildAiTextContextResult | null>(null);
  const [question, setQuestion] = useState("");
  const [result, setResult] = useState<AskPdfResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);
  const [loadingContext, setLoadingContext] = useState(false);
  const [ollamaStatus, setOllamaStatus] = useState<OllamaStatus>("idle");
  const [disclosure, setDisclosure] = useState<AiDisclosure | null>(null);
  const [consent, setConsent] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  const getOllama = () => (ollamaRef.current ??= new OllamaRuntime());
  const getConsent = () => (consentRef.current ??= createAiConsentStore());
  const checkOllama = async () => {
    const availabilityRequest = ++availabilityRequestRef.current;
    const intendedProvider: Provider = "ollama";
    if (!mountedRef.current) return;
    setOllamaStatus("checking");
    try {
      const availability = await getOllamaAvailability(getOllama());
      if (!mountedRef.current || availabilityRequest !== availabilityRequestRef.current || providerRef.current !== intendedProvider) return;
      if (availability.status === "available") { setOllamaStatus("ready"); setDisclosure(buildAiDisclosure(getOllama())); }
      else if (availability.status === "model-unavailable") setOllamaStatus("model-unavailable");
      else if (availability.status === "unavailable") setOllamaStatus("unavailable");
      else setOllamaStatus("error");
    } catch {
      if (mountedRef.current && availabilityRequest === availabilityRequestRef.current && providerRef.current === intendedProvider) {
        setOllamaStatus("error");
      }
    }
  };
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      invalidateRequest(requestRef);
      invalidateRequest(availabilityRequestRef);
      cancelRef.current = true;
      (runtimeRef.current as (AiRuntime & { cancel?: () => void; dispose?: () => void }) | null)?.cancel?.();
      (runtimeRef.current as (AiRuntime & { dispose?: () => void }) | null)?.dispose?.();
    };
  }, []);

  const changeProvider = (next: Provider) => {
    if (processing || loadingContext) return;
    requestRef.current++;
    availabilityRequestRef.current++;
    providerRef.current = next;
    setProvider(next); setResult(null); setError(null); setConsent(false); setDismissed(false);
    if (next === "ollama" && ollamaStatus !== "ready") void checkOllama();
  };

  const chooseFile = (candidate?: File) => {
    if (!candidate || !mountedRef.current) return;
    const request = ++requestRef.current;
    setResult(null); setError(null); setQuestion("");
    if (!isPdf(candidate)) { setFile(null); setContext(null); setError("Please select a valid PDF file."); return; }
    setFile(candidate); setContext(null); setLoadingContext(true); setDismissed(false);
    void prepareAskPdfContext(candidate).then((value) => {
      if (mountedRef.current && request === requestRef.current) setContext(value);
    }).catch((reason) => {
      if (mountedRef.current && request === requestRef.current) setError(reason instanceof Error ? reason.message : "Could not extract PDF text.");
    }).finally(() => {
      if (mountedRef.current && request === requestRef.current) setLoadingContext(false);
    });
  };

  const ask = async () => {
    if (!mountedRef.current || !context || !file || processing || loadingContext) return;
    if (provider === "ollama" && (ollamaStatus !== "ready" || !consent)) { setDismissed(false); return; }
    const request = ++requestRef.current;
    cancelRef.current = false; setProcessing(true); setResult(null); setError(null);
    const runtime = provider === "ollama" ? new OllamaRuntime() : (runtimeRef.current ??= selectAiRuntime("browser").runtime);
    if (provider === "ollama") runtimeRef.current = runtime;
    try {
      const value = await askPdf({ runtime, question, context, isCancellationRequested: () => cancelRef.current });
      if (mountedRef.current && request === requestRef.current) setResult(value);
    } catch (reason) {
      if (mountedRef.current && request === requestRef.current) setError(reason instanceof Error ? reason.message : "Ask PDF failed.");
    } finally {
      if (provider === "ollama") { (runtime as OllamaRuntime).dispose(); runtimeRef.current = null; }
      if (mountedRef.current && request === requestRef.current) setProcessing(false);
    }
  };

  const cancel = () => { cancelRef.current = true; (runtimeRef.current as (AiRuntime & { cancel?: () => void }) | null)?.cancel?.(); };
  const newQuestion = () => { requestRef.current++; cancelRef.current = true; setQuestion(""); setResult(null); setError(null); };
  const reset = () => { requestRef.current++; cancelRef.current = true; setFile(null); setContext(null); setQuestion(""); setResult(null); setError(null); };
  const visibleAnswer = result?.status === "ready" ? result.answer : undefined;
  const showDisclosure = provider === "ollama" && ollamaStatus === "ready" && disclosure && !consent && !dismissed && file;
  const copyAnswer = async () => { if (visibleAnswer) await navigator.clipboard?.writeText(visibleAnswer.answer); };
  const statusTitle = result?.status === "no-text" ? "No extractable text found"
    : result?.status === "provider-failed" ? "Ask failed"
      : result?.status === "not-found" ? "Not found in document"
        : result?.status === "cancelled" || result?.status === "partial" ? "Answer incomplete"
          : "Answer ready";

  return <div className="mx-auto w-full max-w-2xl px-4 sm:px-6">
    <div className="overflow-hidden rounded-2xl border border-gray-100 bg-white shadow-lg">
      <div className="px-4 pt-6 sm:px-6 sm:pt-8">
        <h2 className="text-xl font-bold text-gray-900">Ask PDF</h2>
        <p className="mt-1 text-sm text-gray-500">Ask a question using only your PDF&apos;s extractable text.</p>
        <fieldset className="mt-4"><legend className="text-xs font-semibold text-gray-500">AI provider</legend><div className="mt-2 flex flex-col gap-2 sm:flex-row sm:gap-4">
          <label className="flex items-center gap-2 text-sm text-gray-700"><input type="radio" name="ask-pdf-provider" checked={provider === "browser"} disabled={processing || loadingContext} onChange={() => changeProvider("browser")} />Browser AI (on-device)</label>
          <label className="flex items-center gap-2 text-sm text-gray-700"><input type="radio" name="ask-pdf-provider" checked={provider === "ollama"} disabled={processing || loadingContext} onChange={() => changeProvider("ollama")} />Ollama (qwen3:4b, local service)</label>
        </div></fieldset>
        {provider === "ollama" && ollamaStatus === "checking" && <p role="status" className="mt-2 text-xs text-gray-500">Checking local Ollama service...</p>}
        {provider === "ollama" && ollamaStatus === "ready" && <p role="status" className="mt-2 text-xs text-green-700">Ollama is available.</p>}
        {provider === "ollama" && ollamaStatus === "unavailable" && <p role="alert" className="mt-2 text-xs text-red-600">Ollama is unavailable.</p>}
        {provider === "ollama" && ollamaStatus === "model-unavailable" && <p role="alert" className="mt-2 text-xs text-red-600">The qwen3:4b Ollama model is not installed.</p>}
      </div>
      <UploadZone accept=".pdf,application/pdf" onFileSelect={(candidate) => void chooseFile(candidate)} disabled={processing} title="Choose a PDF to ask about" helperText="or drag and drop it here" className="mx-4 mb-4 mt-6 sm:mx-6" />
      <div className="px-4 pb-6 sm:px-6">
        {file && <p className="mb-4 truncate rounded-lg border border-gray-200 bg-gray-50 px-4 py-3 text-sm font-medium text-gray-800">{file.name}</p>}
        {showDisclosure && <div aria-label="Ollama consent disclosure" className="mb-4 rounded-lg border border-blue-200 bg-blue-50 px-4 py-3"><p className="text-sm font-semibold text-gray-900">{disclosure.headline}</p><ul className="mt-2 list-disc pl-5 text-xs text-gray-700">{disclosure.points.map((point) => <li key={point}>{point}</li>)}</ul><div className="mt-3 flex gap-2"><button type="button" onClick={() => { grantAiConsent(getConsent(), disclosure.providerId); setConsent(true); setDismissed(false); }} className="rounded-lg bg-blue-600 px-3 py-2 text-xs font-semibold text-white">{disclosure.confirmLabel ?? "Approve"}</button><button type="button" onClick={() => setDismissed(true)} className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-xs font-semibold text-gray-700">Cancel</button></div></div>}
        <label htmlFor="ask-pdf-question" className="mb-2 block text-sm font-semibold text-gray-700">Your question</label>
        <textarea id="ask-pdf-question" value={question} onChange={(event) => setQuestion(event.target.value)} maxLength={512} rows={4} disabled={!context || processing} placeholder="What does the document say about..." className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100 disabled:bg-gray-50" />
        {loadingContext && <p role="status" className="mt-2 text-sm text-gray-600">Extracting PDF text...</p>}
        {error && <p role="alert" className="mt-3 text-sm font-medium text-red-600">{error}</p>}
        <div className="mt-4 flex gap-3"><button type="button" onClick={() => void ask()} disabled={!context || !question.trim() || processing || loadingContext || (provider === "ollama" && ollamaStatus !== "ready")} className="flex-1 rounded-lg bg-blue-600 px-4 py-3 text-sm font-semibold text-white disabled:bg-gray-200 disabled:text-gray-400">{processing ? "Asking..." : "Ask question"}</button>{processing && <button type="button" onClick={cancel} className="rounded-lg border border-gray-300 bg-white px-4 py-3 text-sm font-semibold text-gray-700">Cancel</button>}</div>
      </div>
      {result && <ResultPanel icon="?" title={statusTitle} message={`${result.sourcePageCount} page${result.sourcePageCount === 1 ? "" : "s"}`} onReset={reset} resetLabel="Choose another PDF">
        {result.status === "no-text" && <p className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">This PDF has no extractable text. OCR is not included.</p>}
        {result.status === "not-found" && <p className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">This information was not found in the available extractable text.</p>}
        {result.status === "provider-failed" && <p role="alert" className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">{result.providerError ?? "The selected AI provider failed."}</p>}
        {result.pagesWithoutText.length > 0 && <p className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">No extractable text was found on page{result.pagesWithoutText.length === 1 ? "" : "s"} {result.pagesWithoutText.join(", ")}.</p>}
        {visibleAnswer && <><p className="whitespace-pre-wrap text-sm text-gray-800">{visibleAnswer.answer}</p><div className="mt-4 space-y-3">{visibleAnswer.citations.map((citation, index) => <blockquote key={`${citation.sourceChunkIndex}-${citation.sourceStartOffset}-${index}`} className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs text-gray-600">&quot;{citation.sourceQuote}&quot; <span className="font-medium">(page {citation.sourcePageNumber}, chunk {citation.sourceChunkIndex + 1})</span></blockquote>)}</div><button type="button" onClick={() => void copyAnswer()} className="mt-4 w-full rounded-lg border border-gray-300 bg-white py-2 text-sm font-semibold text-gray-700">Copy answer</button></>}
        <button type="button" onClick={newQuestion} className="mt-4 w-full rounded-lg border border-gray-300 bg-white py-2 text-sm font-semibold text-gray-700">Ask another question</button>
      </ResultPanel>}
    </div>
  </div>;
}
