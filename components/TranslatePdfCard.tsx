"use client";

import { useEffect, useRef, useState } from "react";
import { AiGenerationCancelledError, AiRuntimeDisposedError } from "../services/ai/browser/errors";
import { selectAiRuntime } from "../services/ai/providerSelection";
import {
  buildAiDisclosure,
  createAiConsentStore,
  grantAiConsent,
  type AiDisclosure,
  type AiConsentStore,
} from "../services/ai/consent";
import { OllamaRuntime } from "../services/ai/ollama/runtime";
import { getOllamaAvailability } from "../services/ai/ollama/availability";
import {
  SUPPORTED_TRANSLATION_LANGUAGES,
  translatePdf,
  type TranslatePdfResult,
  type TranslationLanguage,
} from "../services/ai/translation";
import type { AiRuntime } from "../services/ai/types";
import ResultPanel from "./ResultPanel";
import UploadZone from "./UploadZone";

type ProviderChoice = "browser" | "ollama";
type OllamaStatus = "idle" | "checking" | "ready" | "unavailable" | "model-unavailable" | "error";

function isPdfFile(file: File): boolean {
  return file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
}

export default function TranslatePdfCard() {
  const runtimeRef = useRef<AiRuntime | null>(null);
  const ollamaMetaRef = useRef<OllamaRuntime | null>(null);
  const consentStoreRef = useRef<AiConsentStore | null>(null);
  const cancelRequestedRef = useRef(false);
  const requestIdRef = useRef(0);
  const [provider, setProvider] = useState<ProviderChoice>("browser");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [language, setLanguage] = useState<TranslationLanguage>("English");
  const [status, setStatus] = useState<OllamaStatus>("idle");
  const [disclosure, setDisclosure] = useState<AiDisclosure | null>(null);
  const [consentGranted, setConsentGranted] = useState(false);
  const [disclosureDismissed, setDisclosureDismissed] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState({ completed: 0, total: 0 });
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<TranslatePdfResult | null>(null);

  const getOllamaMeta = () => {
    if (!ollamaMetaRef.current) ollamaMetaRef.current = new OllamaRuntime();
    return ollamaMetaRef.current;
  };

  const getConsentStore = () => {
    if (!consentStoreRef.current) consentStoreRef.current = createAiConsentStore();
    return consentStoreRef.current;
  };

  const checkOllama = async () => {
    setStatus("checking");
    const runtime = getOllamaMeta();
    try {
      const availability = await getOllamaAvailability(runtime);
      if (availability.status === "available") {
        setStatus("ready");
        setDisclosure(buildAiDisclosure(runtime));
      } else if (availability.status === "model-unavailable") {
        setStatus("model-unavailable");
      } else if (availability.status === "unavailable") {
        setStatus("unavailable");
      } else {
        setStatus("error");
      }
    } catch {
      setStatus("error");
    }
  };

  useEffect(() => {
    return () => {
      const runtime = runtimeRef.current as (AiRuntime & { dispose?: () => void }) | null;
      runtime?.dispose?.();
      runtimeRef.current = null;
    };
  }, []);

  const reset = () => {
    requestIdRef.current += 1;
    cancelRequestedRef.current = false;
    setSelectedFile(null);
    setResult(null);
    setError(null);
    setProgress({ completed: 0, total: 0 });
    setDisclosureDismissed(false);
  };

  const selectFile = (file: File | undefined) => {
    if (!file) return;
    if (!isPdfFile(file)) {
      setError("Please select a valid PDF file.");
      setSelectedFile(null);
      return;
    }
    requestIdRef.current += 1;
    setSelectedFile(file);
    setResult(null);
    setError(null);
    setDisclosureDismissed(false);
  };

  const changeProvider = (next: ProviderChoice) => {
    if (isProcessing) return;
    requestIdRef.current += 1;
    setProvider(next);
    setResult(null);
    setError(null);
    setConsentGranted(false);
    setDisclosureDismissed(false);
    if (next === "ollama" && status !== "ready") void checkOllama();
  };

  const cancel = () => {
    cancelRequestedRef.current = true;
    const runtime = runtimeRef.current as (AiRuntime & { cancel?: () => void }) | null;
    runtime?.cancel?.();
  };

  const translate = async () => {
    if (!selectedFile || isProcessing) return;
    if (provider === "ollama" && !consentGranted) {
      setDisclosureDismissed(false);
      return;
    }
    const requestId = ++requestIdRef.current;
    cancelRequestedRef.current = false;
    setIsProcessing(true);
    setError(null);
    setResult(null);
    setProgress({ completed: 0, total: 0 });

    let runtime: AiRuntime;
    if (provider === "ollama") {
      runtime = new OllamaRuntime();
      runtimeRef.current = runtime;
    } else {
      runtime = runtimeRef.current ?? selectAiRuntime("browser").runtime;
      runtimeRef.current = runtime;
    }

    try {
      const translated = await translatePdf({
        file: selectedFile,
        targetLanguage: language,
        runtime,
        isCancellationRequested: () => cancelRequestedRef.current,
        onProgress: (completed, total) => {
          if (requestId === requestIdRef.current) setProgress({ completed, total });
        },
      });
      if (requestId === requestIdRef.current) setResult(translated);
    } catch (reason) {
      if (requestId !== requestIdRef.current) return;
      if (reason instanceof AiGenerationCancelledError || reason instanceof AiRuntimeDisposedError) {
        setError("Translation cancelled.");
      } else if (reason instanceof Error) {
        setError(`Translation failed: ${reason.message}`);
      } else {
        setError("Translation failed.");
      }
    } finally {
      if (provider === "ollama") {
        (runtime as OllamaRuntime).dispose();
        runtimeRef.current = null;
      }
      if (requestId === requestIdRef.current) setIsProcessing(false);
    }
  };

  const showDisclosure =
    provider === "ollama" &&
    status === "ready" &&
    disclosure !== null &&
    !consentGranted &&
    !disclosureDismissed &&
    selectedFile !== null;

  return (
    <div className="mx-auto w-full max-w-2xl px-4 sm:px-6">
      <div className="overflow-hidden rounded-2xl border border-gray-100 bg-white shadow-lg">
        <div className="px-4 pt-6 sm:px-6 sm:pt-8">
          <h2 className="text-xl font-bold text-gray-900">Translate PDF</h2>
          <p className="mt-1 text-sm text-gray-500">Translate extracted PDF text without recreating PDF layout.</p>
          <p className="mt-2 text-xs text-gray-400">
            Text is extracted in your browser. Image-only pages are not translated and are disclosed below.
          </p>
          <fieldset className="mt-4">
            <legend className="text-xs font-semibold text-gray-500">Target language</legend>
            <select
              aria-label="Target language"
              value={language}
              disabled={isProcessing}
              onChange={(event) => setLanguage(event.target.value as TranslationLanguage)}
              className="mt-2 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm"
            >
              {SUPPORTED_TRANSLATION_LANGUAGES.map((item) => (
                <option key={item}>{item}</option>
              ))}
            </select>
          </fieldset>
          <fieldset className="mt-4">
            <legend className="text-xs font-semibold text-gray-500">AI provider</legend>
            <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:gap-4">
              <label className="flex items-center gap-2 text-sm text-gray-700">
                <input type="radio" name="translate-provider" checked={provider === "browser"} disabled={isProcessing} onChange={() => changeProvider("browser")} />
                Browser AI (on-device)
              </label>
              <label className="flex items-center gap-2 text-sm text-gray-700">
                <input type="radio" name="translate-provider" checked={provider === "ollama"} disabled={isProcessing} onChange={() => changeProvider("ollama")} />
                Ollama (qwen3:4b, local service)
              </label>
            </div>
          </fieldset>
          {provider === "ollama" && status === "checking" && <p role="status" className="mt-2 text-xs text-gray-500">Checking local Ollama service...</p>}
          {provider === "ollama" && status === "ready" && <p role="status" className="mt-2 text-xs text-green-700">Ollama is available.</p>}
          {provider === "ollama" && status === "unavailable" && <p role="alert" className="mt-2 text-xs text-red-600">Ollama is unavailable. Start the local service and try again.</p>}
          {provider === "ollama" && status === "model-unavailable" && <p role="alert" className="mt-2 text-xs text-red-600">The qwen3:4b Ollama model is not installed.</p>}
          {provider === "ollama" && status === "error" && <p role="alert" className="mt-2 text-xs text-red-600">Ollama availability could not be established.</p>}
        </div>

        <UploadZone
          accept=".pdf,application/pdf"
          onFileSelect={(file) => void selectFile(file)}
          disabled={isProcessing}
          title="Choose a PDF to translate"
          helperText="or drag and drop it here"
          className="mx-4 mb-4 mt-6 sm:mx-6"
        />

        <div className="px-4 pb-6 sm:px-6">
          {selectedFile && <p className="mb-4 truncate rounded-lg border border-gray-200 bg-gray-50 px-4 py-3 text-sm font-medium text-gray-800">{selectedFile.name}</p>}
          {showDisclosure && (
            <div aria-label="Ollama consent disclosure" className="mb-4 rounded-lg border border-blue-200 bg-blue-50 px-4 py-3">
              <p className="text-sm font-semibold text-gray-900">{disclosure.headline}</p>
              <ul className="mt-2 list-disc pl-5 text-xs text-gray-700">{disclosure.points.map((point) => <li key={point}>{point}</li>)}</ul>
              <div className="mt-3 flex gap-2">
                <button type="button" onClick={() => { grantAiConsent(getConsentStore(), disclosure.providerId); setConsentGranted(true); setDisclosureDismissed(false); }} className="rounded-lg bg-blue-600 px-3 py-2 text-xs font-semibold text-white">{disclosure.confirmLabel ?? "Approve"}</button>
                <button type="button" onClick={() => setDisclosureDismissed(true)} className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-xs font-semibold text-gray-700">{disclosure.cancelLabel ?? "Cancel"}</button>
              </div>
            </div>
          )}
          {isProcessing && <p role="status" className="mb-3 text-sm text-gray-600">{progress.total ? `Translating chunk ${Math.min(progress.completed + 1, progress.total)} of ${progress.total}...` : "Extracting text..."}</p>}
          {error && <p role="alert" className="mb-3 text-sm font-medium text-red-600">{error}</p>}
          <div className="mt-6 flex gap-3">
            <button type="button" onClick={() => void translate()} disabled={!selectedFile || isProcessing || (provider === "ollama" && status !== "ready")} className="flex-1 rounded-lg bg-blue-600 px-4 py-3 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-gray-200 disabled:text-gray-400">{isProcessing ? "Translating..." : "Translate PDF"}</button>
            {isProcessing && <button type="button" onClick={cancel} className="rounded-lg border border-gray-300 bg-white px-4 py-3 text-sm font-semibold text-gray-700">Cancel</button>}
          </div>
          {provider === "ollama" && isProcessing && <p className="mt-2 text-center text-xs text-gray-500">Ollama cancellation stops new chunks; an in-flight local request may finish.</p>}
        </div>

        {result && (
          <ResultPanel
            icon="T"
            title={
              result.status === "no-text"
                ? "No extractable text found"
                : result.status === "provider-failed"
                  ? "Translation failed"
                  : result.status === "cancelled" || result.status === "partial"
                    ? "Translation incomplete"
                    : "Translation ready"
            }
            message={`${result.targetLanguage} · ${result.sourcePageCount} page${result.sourcePageCount === 1 ? "" : "s"}`}
            onReset={reset}
            resetLabel="Translate another PDF"
          >
            {result.pagesWithoutText.length > 0 && <p className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">Pages without extractable text were not translated: {result.pagesWithoutText.join(", ")}.</p>}
            {result.status === "no-text" && <p className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">This PDF appears to be image-only or contains no extractable text. OCR is not included.</p>}
            {result.status === "provider-failed" && <p role="alert" className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">The selected AI provider could not complete translation: {result.providerError ?? "provider failure"}.</p>}
            {result.failedChunkIndexes.length > 0 && <p className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">Some chunks were failed or truncated. Review the marked sections below.</p>}
            <div className="space-y-4">
              {result.chunks.map((chunk) => (
                <section key={chunk.chunkIndex} className="rounded-lg border border-gray-200 bg-white p-3">
                  <p className="mb-2 text-xs font-semibold text-gray-500">Page {chunk.pageNumber} · Chunk {chunk.chunkIndex + 1} · {chunk.status}</p>
                  {chunk.translatedText ? <p className="whitespace-pre-wrap text-sm text-gray-800">{chunk.translatedText}</p> : <p className="text-sm text-gray-500">{chunk.error ?? "No translation was produced."}</p>}
                </section>
              ))}
            </div>
            {result.chunks.some((chunk) => chunk.status === "translated") && <button type="button" onClick={() => void navigator.clipboard?.writeText(result.chunks.filter((chunk) => chunk.status === "translated").map((chunk) => chunk.translatedText).join("\n\n"))} className="mt-4 w-full rounded-lg border border-gray-300 bg-white py-2 text-sm font-semibold text-gray-700">Copy translated text</button>}
          </ResultPanel>
        )}
      </div>
    </div>
  );
}
