"use client";

import { useEffect, useRef, useState } from "react";
import { AiEmptyContextError, runAiActionOnPdf, type RunAiActionOnPdfResult } from "../services/ai/orchestration";
import type { AiRuntime } from "../services/ai/types";
import { selectAiRuntime } from "../services/ai/providerSelection";
import {
  AiGenerationCancelledError,
  AiRuntimeDisposedError,
} from "../services/ai/browser/errors";
import { OllamaRuntime } from "../services/ai/ollama/runtime";
import { getOllamaAvailability } from "../services/ai/ollama/availability";
import {
  buildAiDisclosure,
  createAiConsentStore,
  grantAiConsent,
  type AiConsentStore,
  type AiDisclosure,
} from "../services/ai/consent";
import {
  Tier2ServiceError,
  runTier2ValidatedSummarize,
  type Tier2ValidatedSummarizeResult,
} from "../services/ai/tier2Summarize";
import ResultPanel from "./ResultPanel";
import UploadZone from "./UploadZone";

function isPdfFile(file: File): boolean {
  return file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
}

type ProcessingStage = "extracting" | "generating";
type ProviderChoice = "browser" | "ollama";
type OllamaStatus = "idle" | "checking" | "ready" | "unavailable" | "model-unavailable" | "error";

function tier2ErrorMessage(err: Tier2ServiceError): string {
  switch (err.code) {
    case "service-unavailable":
      return "Ollama is not reachable. Start your local Ollama service and try again.";
    case "model-unavailable":
      return "The qwen3:4b model is not installed in Ollama. Run: ollama pull qwen3:4b";
    case "availability-error":
      return "Ollama availability could not be established. Try again.";
    case "consent-required":
      return "Consent is required before sending content to Ollama. Review the disclosure below.";
    case "empty-context":
      return "No extractable text was found. This looks like a scanned/image-only PDF. Text-based AI can't summarize it without OCR.";
    case "unsupported-capability":
    case "selection-failed":
      return "This request is not supported by the Tier-2 Ollama path. Try the Browser AI provider instead.";
    case "generation-failed":
      return "Generation failed. Try again.";
    default:
      return "Generation failed. Try again.";
  }
}

export default function SummarizePdfCard() {
  const isProcessingRef = useRef(false);
  const requestIdRef = useRef(0);
  const runtimeRef = useRef<AiRuntime | null>(null);
  const ollamaMetaRef = useRef<OllamaRuntime | null>(null);
  const consentStoreRef = useRef<AiConsentStore | null>(null);

  const [provider, setProvider] = useState<ProviderChoice>("browser");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [processingStage, setProcessingStage] = useState<ProcessingStage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorKind, setErrorKind] = useState<"empty" | "cancelled" | "generic" | null>(null);
  const [result, setResult] = useState<RunAiActionOnPdfResult | null>(null);
  const [tier2Result, setTier2Result] = useState<Tier2ValidatedSummarizeResult | null>(null);
  const [copied, setCopied] = useState(false);
  const [ollamaStatus, setOllamaStatus] = useState<OllamaStatus>("idle");
  const [disclosure, setDisclosure] = useState<AiDisclosure | null>(null);
  const [consentGranted, setConsentGranted] = useState(false);
  const consentGrantedRef = useRef(false);
  const [disclosureDismissed, setDisclosureDismissed] = useState(false);

  function getBrowserRuntime(): AiRuntime {
    if (!runtimeRef.current) {
      runtimeRef.current = selectAiRuntime("browser").runtime;
    }
    return runtimeRef.current;
  }

  function getOllamaMeta(): OllamaRuntime {
    if (!ollamaMetaRef.current) {
      ollamaMetaRef.current = new OllamaRuntime();
    }
    return ollamaMetaRef.current;
  }

  function getConsentStore(): AiConsentStore {
    if (!consentStoreRef.current) {
      consentStoreRef.current = createAiConsentStore();
    }
    return consentStoreRef.current;
  }

  useEffect(() => {
    return () => {
      const disposable = runtimeRef.current as unknown as { dispose?: () => void } | null;
      disposable?.dispose?.();
      runtimeRef.current = null;
    };
  }, []);

  const checkOllama = async () => {
    setOllamaStatus("checking");
    setDisclosure(null);
    try {
      const availability = await getOllamaAvailability(getOllamaMeta());
      if (availability.status === "available") {
        setOllamaStatus("ready");
        setDisclosure(buildAiDisclosure(getOllamaMeta()));
      } else if (availability.status === "model-unavailable") {
        setOllamaStatus("model-unavailable");
      } else if (availability.status === "unavailable") {
        setOllamaStatus("unavailable");
      } else {
        setOllamaStatus("error");
      }
    } catch {
      setOllamaStatus("error");
    }
  };

  const handleProviderChange = (next: ProviderChoice) => {
    if (isProcessing) return;
    requestIdRef.current += 1;
    setProvider(next);
    setError(null);
    setErrorKind(null);
    setResult(null);
    setTier2Result(null);
    setCopied(false);
    setProcessingStage(null);
    setDisclosureDismissed(false);
    if (next === "ollama" && ollamaStatus !== "ready" && ollamaStatus !== "checking") {
      void checkOllama();
    }
  };

  const selectFile = (file: File | undefined) => {
    if (!file) return;
    if (!isPdfFile(file)) {
      requestIdRef.current += 1;
      setSelectedFile(null);
      setError("Please select a valid PDF file.");
      setErrorKind("generic");
      setResult(null);
      setTier2Result(null);
      return;
    }
    requestIdRef.current += 1;
    setSelectedFile(file);
    setError(null);
    setErrorKind(null);
    setResult(null);
    setTier2Result(null);
    setCopied(false);
    setDisclosureDismissed(false);
  };

  const handleReset = () => {
    requestIdRef.current += 1;
    setSelectedFile(null);
    setError(null);
    setErrorKind(null);
    setResult(null);
    setTier2Result(null);
    setCopied(false);
    setProcessingStage(null);
    setDisclosureDismissed(false);
  };

  const handleCancel = () => {
    const runtime = runtimeRef.current as unknown as { cancel?: () => void } | null;
    if (runtime && typeof runtime.cancel === "function") {
      runtime.cancel();
    }
  };

  const runTier2Generation = async (requestId: number) => {
    try {
      const validated = await runTier2ValidatedSummarize({
        file: selectedFile,
        consentStore: getConsentStore(),
      });
      if (requestId !== requestIdRef.current) return;
      setTier2Result(validated);
    } catch (err) {
      if (requestId !== requestIdRef.current) return;
      if (err instanceof Tier2ServiceError) {
        setError(tier2ErrorMessage(err));
        setErrorKind(err.code === "empty-context" ? "empty" : "generic");
      } else if (err instanceof Error && err.message) {
        setError(`Generation failed: ${err.message}`);
        setErrorKind("generic");
      } else {
        setError("Generation failed.");
        setErrorKind("generic");
      }
    }
  };

  const handleSummarize = async () => {
    if (isProcessingRef.current || !selectedFile) return;

    if (provider === "ollama") {
      if (ollamaStatus !== "ready") {
        await checkOllama();
        return;
      }
      if (!consentGrantedRef.current) {
        setDisclosureDismissed(false);
        return;
      }
    }

    const requestId = ++requestIdRef.current;
    isProcessingRef.current = true;
    setIsProcessing(true);
    setProcessingStage("extracting");
    setError(null);
    setErrorKind(null);
    setResult(null);
    setTier2Result(null);
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
      if (provider === "ollama") {
        if (requestIdRef.current === requestId) {
          setProcessingStage("generating");
        }
        await runTier2Generation(requestId);
      } else {
        const runtime = getBrowserRuntime();
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
      }
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

  const handleDisclosureApprove = async () => {
    if (!disclosure || !selectedFile || isProcessingRef.current) return;
    grantAiConsent(getConsentStore(), disclosure.providerId);
    consentGrantedRef.current = true;
    setConsentGranted(true);
    setDisclosureDismissed(false);
    await handleSummarize();
  };

  const handleDisclosureDismiss = () => {
    setDisclosureDismissed(true);
  };

  const canSummarize =
    selectedFile !== null &&
    !isProcessing &&
    (provider === "browser" || ollamaStatus === "ready");
  const processingLabel =
    processingStage === "extracting"
      ? "Extracting text..."
      : processingStage === "generating"
        ? "Generating summary..."
        : isProcessing
          ? "Processing..."
          : null;

  const tier2SummaryText = tier2Result
    ? tier2Result.claims.map((claim) => claim.text).join("\n\n")
    : "";

  const handleCopy = async () => {
    const textToCopy = provider === "ollama" ? tier2SummaryText : result?.text;
    if (!textToCopy) return;
    try {
      await navigator.clipboard.writeText(textToCopy);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard may be unavailable in some contexts
    }
  };

  const showDisclosure =
    provider === "ollama" &&
    ollamaStatus === "ready" &&
    disclosure !== null &&
    !consentGranted &&
    !disclosureDismissed &&
    selectedFile !== null &&
    tier2Result === null;

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
          <p className="mt-1 text-xs text-gray-400">
            Browser AI processes up to about 8,192 characters of extracted PDF text per request —
            longer documents may be truncated. Summaries are generated locally in your browser, and
            quality can vary by document.
          </p>

          <fieldset className="mt-4">
            <legend className="text-xs font-semibold text-gray-500">AI provider</legend>
            <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:gap-4">
              <label className="flex items-center gap-2 text-sm text-gray-700">
                <input
                  type="radio"
                  name="ai-provider"
                  value="browser"
                  checked={provider === "browser"}
                  disabled={isProcessing}
                  onChange={() => handleProviderChange("browser")}
                />
                Browser AI (on-device)
              </label>
              <label className="flex items-center gap-2 text-sm text-gray-700">
                <input
                  type="radio"
                  name="ai-provider"
                  value="ollama"
                  checked={provider === "ollama"}
                  disabled={isProcessing}
                  onChange={() => handleProviderChange("ollama")}
                />
                Ollama (qwen3:4b, local service)
              </label>
            </div>
          </fieldset>

          {provider === "ollama" && ollamaStatus === "checking" && (
            <p role="status" className="mt-2 text-xs text-gray-500">
              Checking local Ollama service...
            </p>
          )}
          {provider === "ollama" && ollamaStatus === "ready" && (
            <p role="status" className="mt-2 text-xs font-medium text-green-700">
              Ollama is available — local service with qwen3:4b is reachable.
            </p>
          )}
          {provider === "ollama" && ollamaStatus === "unavailable" && (
            <p role="alert" className="mt-2 text-xs font-medium text-red-600">
              Ollama is unavailable — the local Ollama service is not reachable. Start Ollama and
              try again.
            </p>
          )}
          {provider === "ollama" && ollamaStatus === "model-unavailable" && (
            <p role="alert" className="mt-2 text-xs font-medium text-red-600">
              Ollama model missing — qwen3:4b is not installed. Run: ollama pull qwen3:4b
            </p>
          )}
          {provider === "ollama" && ollamaStatus === "error" && (
            <p role="alert" className="mt-2 text-xs font-medium text-red-600">
              Ollama availability could not be established. Try again.
            </p>
          )}
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

          {showDisclosure && (
            <div
              aria-label="Ollama consent disclosure"
              className="mb-4 rounded-lg border border-blue-200 bg-blue-50 px-4 py-3"
            >
              <p className="text-sm font-semibold text-gray-900">{disclosure.headline}</p>
              <ul className="mt-2 list-disc pl-5 text-xs leading-relaxed text-gray-700">
                {disclosure.points.map((point) => (
                  <li key={point}>{point}</li>
                ))}
              </ul>
              <div className="mt-3 flex gap-2">
                <button
                  type="button"
                  onClick={() => void handleDisclosureApprove()}
                  disabled={isProcessing}
                  className="rounded-lg bg-blue-600 px-3 py-2 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  {disclosure.confirmLabel ?? "Approve"}
                </button>
                <button
                  type="button"
                  onClick={handleDisclosureDismiss}
                  disabled={isProcessing}
                  className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-xs font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                >
                  {disclosure.cancelLabel ?? "Cancel"}
                </button>
              </div>
            </div>
          )}
          {provider === "ollama" &&
            ollamaStatus === "ready" &&
            disclosureDismissed &&
            !consentGranted &&
            selectedFile !== null &&
            tier2Result === null && (
              <div className="mb-4">
                <p className="mb-2 text-xs text-gray-500">
                  Approval is still required before Ollama can summarize this document.
                </p>
                <button
                  type="button"
                  onClick={() => setDisclosureDismissed(false)}
                  className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-xs font-semibold text-gray-700 hover:bg-gray-50"
                >
                  Review Ollama disclosure
                </button>
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
            {isProcessing && provider === "browser" && (
              <button
                type="button"
                onClick={handleCancel}
                className="rounded-lg border border-gray-300 bg-white px-4 py-3 text-sm font-semibold text-gray-700 transition hover:bg-gray-50"
              >
                Cancel
              </button>
            )}
          </div>
          {isProcessing && provider === "browser" && (
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

        {tier2Result && (
          <ResultPanel
            icon="✨"
            title={tier2Result.status === "grounded" ? "Summary ready" : "Limited result"}
            message={`Ollama (qwen3:4b) · ${tier2Result.sourcePageCount} page${tier2Result.sourcePageCount === 1 ? "" : "s"}`}
            onReset={handleReset}
            resetLabel="Summarize another PDF"
          >
            {tier2Result.status === "limited" && (
              <p className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                {tier2Result.reason === "no-evidence"
                  ? "No exact evidence could be extracted, so no grounded summary was produced."
                  : tier2Result.reason === "malformed-output"
                    ? "The model returned an unusable response format, so no summary is shown."
                    : "The model output could not be grounded to source evidence, so no summary is shown."}
              </p>
            )}

            {tier2Result.status === "grounded" && (
              <div className="mb-4 rounded-lg border border-gray-200 bg-white px-4 py-3">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                  Summary points
                </h3>
                <ul className="mt-2 space-y-2">
                  {tier2Result.claims.map((claim, claimIndex) => (
                    <li key={`${claimIndex}-${claim.kind}-${claim.evidenceIds.join("+")}`} className="text-sm leading-relaxed text-gray-800">
                      {claim.text}
                    </li>
                  ))}
                </ul>
                <button
                  type="button"
                  onClick={handleCopy}
                  className="mt-3 rounded-lg border border-gray-200 bg-gray-50 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-100"
                >
                  {copied ? "Copied!" : "Copy summary"}
                </button>
              </div>
            )}

            {tier2Result.status === "grounded" && (
              <div className="mb-3 rounded-lg border border-gray-200 bg-gray-50 px-4 py-3">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                  Source evidence
                </h3>
                <ul className="mt-2 space-y-1">
                  {tier2Result.claims.flatMap((claim, claimIndex) =>
                    claim.evidence.map((grounded, evidenceIndex) => (
                      <li
                        key={`${claimIndex}-${evidenceIndex}-${grounded.item.evidenceId}`}
                        className="text-xs leading-relaxed text-gray-600"
                      >
                        <span className="font-mono">[{grounded.item.evidenceId}]</span>{" "}
                        <span className="text-gray-500">
                          (p. {grounded.item.sourcePages.join(", ")})
                        </span>{" "}
                        {grounded.item.exactText}
                      </li>
                    )),
                  )}
                </ul>
              </div>
            )}

            {(tier2Result.contextTruncated || tier2Result.evidenceTruncated) && (
              <p className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                Note: only part of the document was used
                {tier2Result.evidenceTruncated ? " — the evidence pool was bounded" : ""} — the
                result may not cover the entire PDF.
              </p>
            )}

            {tier2Result.rejectedClaims > 0 && (
              <p className="mb-3 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-600">
                {tier2Result.rejectedClaims} model claim{tier2Result.rejectedClaims === 1 ? " was" : "s were"} rejected
                during validation and excluded from this result.
              </p>
            )}

            {tier2Result.failedChunks.length > 0 && (
              <p className="mb-3 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-600">
                {tier2Result.failedChunks.length} document section{tier2Result.failedChunks.length === 1 ? " could" : "s could"} not
                be processed and {tier2Result.failedChunks.length === 1 ? "was" : "were"} excluded from this result.
              </p>
            )}

            {tier2Result.pagesWithoutText.length > 0 && (
              <p className="mb-3 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-600">
                Pages without extractable text: {tier2Result.pagesWithoutText.join(", ")} — these
                pages are image-only and were not included.
              </p>
            )}

            <p className="mb-1 text-xs text-gray-400">
              Tier-2 Ollama — selected extracted text was sent to your local Ollama service
              (qwen3:4b). The original PDF was not sent. Availability depends on the local Ollama
              service and model.
            </p>
          </ResultPanel>
        )}
      </div>
    </div>
  );
}
