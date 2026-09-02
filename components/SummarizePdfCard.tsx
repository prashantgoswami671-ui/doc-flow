"use client";

import { useEffect, useRef, useState } from "react";
import { AiEmptyContextError, runAiActionOnPdf, type RunAiActionOnPdfResult } from "../services/ai/orchestration";
import { BrowserAiRuntime } from "../services/ai/browser/browserAiRuntime";
import {
  AiGenerationCancelledError,
  AiRuntimeDisposedError,
} from "../services/ai/browser/errors";
import ResultPanel from "./ResultPanel";
import UploadZone from "./UploadZone";

function isPdfFile(file: File): boolean {
  return file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
}

type ProcessingStage = "extracting" | "generating";

export default function SummarizePdfCard() {
  const isProcessingRef = useRef(false);
  const requestIdRef = useRef(0);
  const runtimeRef = useRef<BrowserAiRuntime | null>(null);

  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [processingStage, setProcessingStage] = useState<ProcessingStage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorKind, setErrorKind] = useState<"empty" | "cancelled" | "generic" | null>(null);
  const [result, setResult] = useState<RunAiActionOnPdfResult | null>(null);
  const [copied, setCopied] = useState(false);

  function getRuntime(): BrowserAiRuntime {
    if (!runtimeRef.current) {
      runtimeRef.current = new BrowserAiRuntime();
    }
    return runtimeRef.current;
  }

  useEffect(() => {
    return () => {
      runtimeRef.current?.dispose();
      runtimeRef.current = null;
    };
  }, []);

  const selectFile = (file: File | undefined) => {
    if (!file) return;
    if (!isPdfFile(file)) {
      requestIdRef.current += 1;
      setSelectedFile(null);
      setError("Please select a valid PDF file.");
      setErrorKind("generic");
      setResult(null);
      return;
    }
    requestIdRef.current += 1;
    setSelectedFile(file);
    setError(null);
    setErrorKind(null);
    setResult(null);
    setCopied(false);
  };

  const handleReset = () => {
    requestIdRef.current += 1;
    setSelectedFile(null);
    setError(null);
    setErrorKind(null);
    setResult(null);
    setCopied(false);
    setProcessingStage(null);
  };

  const handleCancel = () => {
    const runtime = runtimeRef.current;
    if (runtime) {
      runtime.cancel();
    }
  };

  const handleSummarize = async () => {
    if (isProcessingRef.current || !selectedFile) return;

    const requestId = ++requestIdRef.current;
    isProcessingRef.current = true;
    setIsProcessing(true);
    setProcessingStage("extracting");
    setError(null);
    setErrorKind(null);
    setResult(null);
    setCopied(false);

    // Staged messaging: extraction is fast, but show intermediate
    // before generation starts. Since runAiActionOnPdf is single promise,
    // we approximate by switching label shortly after start.
    const stageTimer = setTimeout(() => {
      if (requestIdRef.current === requestId) {
        setProcessingStage("generating");
      }
    }, 600);

    try {
      const runtime = getRuntime();
      // Update to generating before await if still current
      if (requestIdRef.current === requestId) {
        setProcessingStage("generating");
      }
      const orchestrationResult = await runAiActionOnPdf({
        file: selectedFile,
        action: "summarize",
        runtime,
      });

      if (requestId !== requestIdRef.current) return;

      setResult(orchestrationResult);
    } catch (err) {
      if (requestId !== requestIdRef.current) return;

      if (err instanceof AiEmptyContextError) {
        setError(
          "No extractable text was found. This looks like a scanned/image-only PDF. Text-based AI can't summarize it without OCR.",
        );
        setErrorKind("empty");
      } else if (
        err instanceof AiGenerationCancelledError ||
        err instanceof AiRuntimeDisposedError ||
        (err instanceof Error && err.name === "AiGenerationCancelledError") ||
        (err instanceof Error && err.name === "AiRuntimeDisposedError")
      ) {
        const isDisposed = err instanceof AiRuntimeDisposedError || err.name === "AiRuntimeDisposedError";
        // Dispose is teardown, not user cancel — but treat similarly as cancellable
        if (isDisposed) {
          setError("Generation was interrupted.");
        } else {
          setError("Generation cancelled.");
        }
        setErrorKind("cancelled");
      } else if (err instanceof Error) {
        const name = err.name;
        if (name === "AiRuntimeUnavailableError") {
          setError(`AI unavailable: ${err.message}`);
        } else if (name === "AiModelInitializationError") {
          setError(`AI initialization failed: ${err.message}`);
        } else if (name === "AiGenerationError" || name === "AiConcurrentGenerationError") {
          setError(`Generation failed: ${err.message}`);
        } else {
          setError(err.message ? `Generation failed: ${err.message}` : "Generation failed.");
        }
        setErrorKind("generic");
      } else {
        setError("Generation failed.");
        setErrorKind("generic");
      }
    } finally {
      clearTimeout(stageTimer);
      if (requestId === requestIdRef.current) {
        isProcessingRef.current = false;
        setIsProcessing(false);
        setProcessingStage(null);
      }
    }
  };

  const canSummarize = selectedFile !== null && !isProcessing;
  const processingLabel =
    processingStage === "extracting"
      ? "Extracting text..."
      : processingStage === "generating"
        ? "Generating summary..."
        : isProcessing
          ? "Processing..."
          : null;

  const handleCopy = async () => {
    if (!result?.text) return;
    try {
      await navigator.clipboard.writeText(result.text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard may be unavailable in some contexts
    }
  };

  return (
    <div className="w-full max-w-2xl mx-auto px-4 sm:px-6">
      <div className="bg-white rounded-2xl shadow-lg border border-gray-100 overflow-hidden">
        <div className="px-4 sm:px-6 pt-6 sm:pt-8">
          <h2 className="text-xl font-bold text-gray-900">Summarize PDF</h2>
          <p className="mt-1 text-sm text-gray-500">
            Get a concise summary of your PDF — processed locally in your browser.
          </p>
          <p className="mt-2 text-xs text-gray-400">
            Tier-1 Browser AI — document text is processed locally in your browser. The AI model is
            downloaded and cached in your browser. Your document content is not sent to a cloud AI
            provider.
          </p>
        </div>

        <UploadZone
          accept=".pdf,application/pdf"
          onFileSelect={(file) => void selectFile(file)}
          disabled={isProcessing}
          title="Choose a PDF to summarize"
          helperText="or drag and drop it here"
          className="mx-4 sm:mx-6 mt-6 mb-4"
        />

        <div className="px-4 sm:px-6 pb-6">
          {selectedFile && (
            <div className="rounded-lg bg-gray-50 border border-gray-200 px-4 py-3 mb-4">
              <p className="text-sm font-medium text-gray-800 truncate">{selectedFile.name}</p>
            </div>
          )}

          {isProcessing && processingLabel && (
            <p
              role="status"
              aria-live="polite"
              aria-atomic="true"
              className="text-sm font-medium text-gray-600"
            >
              {processingLabel}
            </p>
          )}

          {error && (
            <p
              role={errorKind === "cancelled" ? "status" : "alert"}
              className={`mt-4 text-sm font-medium ${errorKind === "cancelled" ? "text-amber-600" : "text-red-600"}`}
            >
              {error}
            </p>
          )}

          <div className="mt-6 flex gap-3">
            <button
              type="button"
              onClick={handleSummarize}
              disabled={!canSummarize}
              aria-busy={isProcessing}
              className={`flex-1 rounded-lg px-4 py-3 text-sm font-semibold transition-colors ${
                canSummarize
                  ? "bg-blue-600 text-white hover:bg-blue-700"
                  : "bg-gray-200 text-gray-400 cursor-not-allowed"
              }`}
            >
              {isProcessing ? "Summarizing..." : "Summarize PDF"}
            </button>
            {isProcessing && (
              <button
                type="button"
                onClick={handleCancel}
                className="rounded-lg border border-gray-300 bg-white px-4 py-3 text-sm font-semibold text-gray-700 transition hover:bg-gray-50"
              >
                Cancel
              </button>
            )}
          </div>
          {isProcessing && (
            <p className="mt-2 text-center text-xs text-gray-500">Your file stays on device while we generate the summary.</p>
          )}
        </div>

        {result && (
          <ResultPanel
            icon="✨"
            title="Summary ready"
            message={`${result.sourcePageCount} page${result.sourcePageCount === 1 ? "" : "s"}${result.truncated ? " · truncated" : ""}`}
            onReset={handleReset}
            resetLabel="Summarize another PDF"
          >
            <div className="mb-4 rounded-lg border border-gray-200 bg-white px-4 py-3">
              <p className="whitespace-pre-wrap text-sm leading-relaxed text-gray-800">{result.text}</p>
              <button
                type="button"
                onClick={handleCopy}
                className="mt-3 rounded-lg border border-gray-200 bg-gray-50 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-100"
              >
                {copied ? "Copied!" : "Copy summary"}
              </button>
            </div>

            {result.truncated && (
              <p className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                Note: only part of the document was used — the context was truncated to fit the local
                model. Result may not cover the entire PDF.
              </p>
            )}

            {result.pagesWithoutText.length > 0 && (
              <p className="mb-3 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-600">
                Pages without extractable text: {result.pagesWithoutText.join(", ")} — these pages are
                image-only and were not included.
              </p>
            )}

            <p className="mb-1 text-xs text-gray-400">
              Tier-1 Browser AI — document text is processed locally in your browser. The AI model is
              downloaded and cached in your browser. Your document content is not sent to a cloud AI
              provider.
            </p>
          </ResultPanel>
        )}
      </div>
    </div>
  );
}
