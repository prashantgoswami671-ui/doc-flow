"use client";

import { useEffect, useRef, useState } from "react";
import {
  repairPdf,
  validatePdf,
  RasterSalvageRequiredError,
  SafeRepairUnavailableError,
  getRepairedFilename,
  type PdfValidationIssue,
  type PdfValidationResult,
  type RepairPdfResult,
  type RepairStage,
  type StrategyDiagnostics,
} from "../services/pdf/repairValidate";
import ResultPanel from "./ResultPanel";
import ProcessingState from "./ProcessingState";
import UploadZone from "./UploadZone";

function isPdfFile(file: File): boolean {
  return (
    file.type === "application/pdf" ||
    file.name.toLowerCase().endsWith(".pdf")
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function downloadPdfBytes(bytes: Uint8Array, filename: string): void {
  const blob = new Blob([bytes as BlobPart], { type: "application/pdf" });
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = objectUrl;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(objectUrl);
}

function getStatusLabel(status: PdfValidationResult["status"]): {
  icon: string;
  text: string;
  colorClass: string;
} {
  if (status === "valid") {
    return {
      icon: "✓",
      text: "PDF appears healthy",
      colorClass: "text-green-700",
    };
  }

  if (status === "repairable") {
    return {
      icon: "⚠",
      text: "PDF needs repair",
      colorClass: "text-amber-700",
    };
  }

  return {
    icon: "✕",
    text: "PDF could not be processed",
    colorClass: "text-red-700",
  };
}

/**
 * Derives a single, user-facing explanation of *why* a "repairable" PDF is
 * being flagged, from facts the validation result already computed. This
 * does not introduce any new validation rule or threshold — it only
 * decides which already-known fact is most relevant to show first. The
 * `pdfJsLoadable`/`pdfLibLoadable` case mirrors the explanatory note the
 * card already surfaced inline; the issue-message fallback reuses the
 * existing `issues` list the service produces.
 */
function repairReasonExplanation(validationResult: PdfValidationResult): string {
  if (!validationResult.pdfJsLoadable && validationResult.pdfLibLoadable) {
    return "PDF structure can still be read, but page rendering could not be verified. A repair attempt is available.";
  }

  const primaryIssue = validationResult.issues.find(
    (issue) => issue.severity !== "info",
  );

  if (primaryIssue) {
    return primaryIssue.message;
  }

  return "DocFlow detected recoverable issues in this PDF's structure.";
}

function issueExplanation(code: string): string {
  switch (code) {
    case "password-protected":
      return "Use Unlock PDF first, then validate or repair again.";
    case "pdf-lib-load-failed":
      return "Structure checks were limited, but page rendering may still be possible.";
    case "pdfjs-load-failed-recoverable":
      return "A repair attempt can try to rebuild this PDF into a clean, renderable file.";
    case "page-render-failed":
      return "Some pages may be damaged or use unsupported content.";
    case "invalid-page-dimensions":
      return "This page's reported size looks corrupted.";
    case "render-sampled-pages":
      return "Large files are sampled first to keep browser memory usage stable.";
    case "repairable-structure-issues":
      return "A rebuild often removes structural noise while keeping visible content.";
    default:
      return "Review this issue before sharing the output.";
  }
}

function issueClasses(issue: PdfValidationIssue): string {
  if (issue.severity === "error") {
    return "border-red-200 bg-red-50 text-red-700";
  }

  if (issue.severity === "warning") {
    return "border-amber-200 bg-amber-50 text-amber-700";
  }

  return "border-blue-200 bg-blue-50 text-blue-700";
}

function stageLabel(stage: RepairStage | null): string | null {
  switch (stage) {
    case "preparing":
      return "Preparing repair...";
    case "structural-rebuild":
      return "Rebuilding PDF...";
    case "structural-recovery":
      return "Attempting structural recovery...";
    case "structural-reconstruction":
      return "Reconstructing damaged pages...";
    case "raster-salvage":
      return "Rebuilding pages as images...";
    case "validating":
      return "Validating repaired PDF...";
    default:
      return null;
  }
}

function methodLabel(method: RepairPdfResult["method"]): string {
  switch (method) {
    case "structural-rebuild":
      return "Structural rebuild";
    case "structural-recovery":
      return "Structural recovery";
    case "structural-reconstruction":
      return "Structural reconstruction (page-by-page)";
    case "page-tree-reconstruction":
      return "Page-tree reconstruction";
    case "raster-salvage":
      return "Raster salvage";
    default:
      return method;
  }
}

/**
 * Primary heading for the final repair-result panel. Distinguishes lossy
 * raster recovery, partial (some pages placeholder/uncertain) recovery, and
 * a full non-lossy structural repair — using only `method`/`lossy`, which
 * the repair service already computes.
 */
function repairResultHeading(result: RepairPdfResult): string {
  if (result.method === "raster-salvage") {
    return "Recovered successfully — lossy";
  }

  if (result.lossy) {
    return "Partially recovered";
  }

  return "Repair successful";
}

/**
 * "Pages recovered" is used whenever the result is lossy (raster salvage or
 * partial structural recovery) to make clear not every page came back
 * losslessly; "Pages verified" is kept for a full, non-lossy repair.
 */
function repairResultPagesLabel(result: RepairPdfResult): string {
  return result.method === "raster-salvage" || result.lossy
    ? "Pages recovered"
    : "Pages verified";
}

/**
 * "Structure preserved" is only shown for non-lossy structural methods —
 * i.e. exactly the cases where the repair service itself reports
 * `lossy: false` for a non-raster-salvage method, meaning every page came
 * from the original vector/text content rather than a placeholder or a
 * rasterized image. This never overrides or duplicates that determination.
 */
function repairResultStructurePreserved(result: RepairPdfResult): boolean {
  return result.method !== "raster-salvage" && !result.lossy;
}

function strategyStatusLabel(diag: StrategyDiagnostics): string {
  if (!diag.attempted) return "Not attempted";
  if (diag.succeeded) return diag.lossy ? "Succeeded (lossy)" : "Succeeded";
  return "Failed";
}

function StrategyDiagnosticsPanel({
  diagnostics,
}: {
  diagnostics: StrategyDiagnostics[];
}) {
  if (diagnostics.length === 0) return null;

  return (
    <details className="mt-4 rounded-lg border border-gray-200 bg-white">
      <summary className="cursor-pointer select-none px-4 py-3 text-sm font-semibold text-gray-800">
        Repair diagnostics ({diagnostics.length} strateg{diagnostics.length === 1 ? "y" : "ies"} attempted)
      </summary>
      <div className="space-y-3 px-4 pb-4">
        {diagnostics.map((diag) => (
          <div
            key={diag.strategy}
            className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-700"
          >
            <p className="text-sm font-semibold text-gray-900">
              {methodLabel(diag.strategy)} — {strategyStatusLabel(diag)}
            </p>
            <p className="mt-1">
              pdf-lib load: {diag.pdfLibLoad.succeeded ? "OK" : "Failed"}
              {diag.pdfLibLoad.pageCount != null && ` (page count: ${diag.pdfLibLoad.pageCount})`}
            </p>
            {diag.copyPages.applicable && (
              <p className="mt-1">
                copyPages(): {diag.copyPages.succeeded ? "OK" : "Failed"}
                {diag.copyPages.pagesCopied > 0 && ` — ${diag.copyPages.pagesCopied} page(s) copied`}
                {diag.copyPages.pagesFailed.length > 0 &&
                  ` — page(s) ${diag.copyPages.pagesFailed.join(", ")} could not be copied`}
              </p>
            )}
            <p className="mt-1">save(): {diag.save.succeeded ? "OK" : "Failed"}</p>
            {diag.postSaveValidation.attempted && (
              <p className="mt-1">
                Post-repair PDF.js check: {diag.postSaveValidation.pdfJsLoadable ? "Loaded" : "Failed to load"}
                {diag.postSaveValidation.renderablePages != null &&
                  ` — ${diag.postSaveValidation.renderablePages} page(s) rendered`}
              </p>
            )}
            {diag.failureReason && (
              <p className="mt-1 text-amber-700">Reason: {diag.failureReason}</p>
            )}
            {diag.rawError && (
              <p className="mt-1 break-all font-mono text-[11px] text-red-700">{diag.rawError}</p>
            )}
          </div>
        ))}
      </div>
    </details>
  );
}

/**
 * Small, local icon-circle badge shared by every status/state block in this
 * card (valid, repairable, invalid, raster-salvage prompt, repair failure)
 * so they read as visually related to the ResultPanel-driven success state
 * further down. Presentation-only; carries no validation/repair meaning.
 */
function StatusIconCircle({
  icon,
  tone,
}: {
  icon: string;
  tone: "green" | "amber" | "red";
}) {
  const toneClasses: Record<typeof tone, string> = {
    green: "bg-green-100 text-green-700",
    amber: "bg-amber-100 text-amber-700",
    red: "bg-red-100 text-red-700",
  };

  return (
    <div
      className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-xl ${toneClasses[tone]}`}
      aria-hidden="true"
    >
      {icon}
    </div>
  );
}

export default function RepairValidatePdfCard() {
  const validationRequestIdRef = useRef(0);
  const isRepairingRef = useRef(false);

  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isValidating, setIsValidating] = useState(false);
  const [validationResult, setValidationResult] = useState<PdfValidationResult | null>(null);
  const [isRepairing, setIsRepairing] = useState(false);
  const [repairStage, setRepairStage] = useState<RepairStage | null>(null);
  const [repairResult, setRepairResult] = useState<RepairPdfResult | null>(null);
  const [showRasterSalvagePrompt, setShowRasterSalvagePrompt] = useState(false);
  const [repairFailed, setRepairFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [repairDiagnostics, setRepairDiagnostics] = useState<StrategyDiagnostics[]>([]);

  useEffect(() => {
    return () => {
      validationRequestIdRef.current += 1;
    };
  }, []);

  const resetOutput = () => {
    setValidationResult(null);
    setRepairResult(null);
    setShowRasterSalvagePrompt(false);
    setRepairFailed(false);
    setError(null);
    setRepairDiagnostics([]);
  };

  const selectFile = (file: File | undefined) => {
    if (!file) return;

    if (!isPdfFile(file)) {
      setSelectedFile(null);
      resetOutput();
      setError("Please select a valid PDF file.");
      return;
    }

    setSelectedFile(file);
    setRepairResult(null);
    setShowRasterSalvagePrompt(false);
    setRepairFailed(false);
    setError(null);
    setRepairDiagnostics([]);
    void runValidation(file);
  };

  const runValidation = async (file: File) => {
    const requestId = ++validationRequestIdRef.current;

    setIsValidating(true);
    setValidationResult(null);
    setRepairResult(null);
    setShowRasterSalvagePrompt(false);
    setRepairFailed(false);
    setError(null);
    setRepairDiagnostics([]);

    try {
      const result = await validatePdf(file);

      if (requestId !== validationRequestIdRef.current) {
        return;
      }

      setValidationResult(result);
    } catch {
      if (requestId !== validationRequestIdRef.current) {
        return;
      }

      setError("Validation failed. Please try another PDF file.");
    } finally {
      if (requestId === validationRequestIdRef.current) {
        setIsValidating(false);
      }
    }
  };

  const runRepair = async (allowRasterSalvage: boolean) => {
    if (isRepairingRef.current || !selectedFile) return;

    isRepairingRef.current = true;
    setIsRepairing(true);
    setError(null);
    setRepairFailed(false);
    setShowRasterSalvagePrompt(false);
    setRepairDiagnostics([]);
    setRepairStage("preparing");

    try {
      const result = await repairPdf(
        selectedFile,
        { allowRasterSalvage },
        (stage) => setRepairStage(stage),
      );

      setRepairResult(result);
      setValidationResult(result.validation);
      setShowRasterSalvagePrompt(false);
      setRepairDiagnostics(result.diagnostics);
    } catch (repairError) {
      if (repairError instanceof RasterSalvageRequiredError) {
        setShowRasterSalvagePrompt(true);
        setRepairDiagnostics(repairError.diagnostics);
        setError(null);
      } else if (repairError instanceof SafeRepairUnavailableError) {
        setRepairFailed(true);
        setRepairDiagnostics(repairError.diagnostics);
        setError(repairError.message);
      } else {
        const message =
          repairError instanceof Error
            ? repairError.message
            : "Repair failed. Please try another file.";

        setError(message);
      }
    } finally {
      isRepairingRef.current = false;
      setIsRepairing(false);
      setRepairStage(null);
    }
  };

  /**
   * Full workflow reset for the "Validate another PDF" action. Reuses the
   * existing `resetOutput` helper (the same output-clearing logic the card
   * already ran on file re-selection) instead of introducing a second,
   * parallel reset implementation, and additionally clears the selected
   * file / in-flight validation and repair bookkeeping so a new file can be
   * picked immediately.
   */
  const handleValidateAnother = () => {
    validationRequestIdRef.current += 1;
    isRepairingRef.current = false;

    setSelectedFile(null);
    setIsValidating(false);
    setIsRepairing(false);
    setRepairStage(null);
    resetOutput();
  };

  const canRepair =
    selectedFile !== null &&
    validationResult !== null &&
    validationResult.status !== "invalid" &&
    !isRepairing &&
    !isValidating;

  const status = validationResult ? getStatusLabel(validationResult.status) : null;
  const currentStageLabel = stageLabel(repairStage);
  const isValidState = validationResult?.status === "valid";
  const isRepairableState = validationResult?.status === "repairable";
  const isInvalidState = validationResult?.status === "invalid";

  return (
    <div className="w-full max-w-2xl mx-auto px-4 sm:px-6">
      <div className="bg-white rounded-2xl shadow-lg border border-gray-100 overflow-hidden">
        <div className="px-4 sm:px-6 pt-6 sm:pt-8">
          <h2 className="text-xl font-bold text-gray-900">Repair &amp; Validate PDF</h2>
          <p className="mt-1 text-sm text-gray-500">
            Validate and rebuild PDFs that are readable or renderable.
          </p>
        </div>

        <UploadZone
          accept=".pdf,application/pdf"
          onFileSelect={(file) => void selectFile(file)}
          disabled={isValidating || isRepairing}
          title="Upload a PDF to check its integrity"
          helperText="or drag and drop it here"
          className="mx-4 sm:mx-6 mt-6 mb-4"
        />

        <div className="px-4 sm:px-6 pb-6">
          {!selectedFile && (
            <p className="text-sm text-gray-500">Upload a PDF to check its integrity.</p>
          )}

          {selectedFile && (
            <div className="rounded-lg bg-gray-50 border border-gray-200 px-4 py-3">
              <p className="text-sm font-medium text-gray-800 truncate">{selectedFile.name}</p>
              <p className="mt-1 text-sm text-gray-500">
                {formatBytes(selectedFile.size)}
              </p>
            </div>
          )}

          {isValidating && (
            <p
              className="mt-4 text-sm font-medium text-gray-600"
              role="status"
              aria-live="polite"
            >
              <ProcessingState isProcessing={isValidating} message="Validating PDF..." />
            </p>
          )}

          {/* --- A1: valid state --- */}
          {validationResult && status && isValidState && (
            <div className="mt-4 rounded-lg border border-green-200 bg-green-50 p-4">
              <div className="flex items-start gap-3">
                <StatusIconCircle icon="✓" tone="green" />
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-green-800">PDF appears healthy</p>
                  <p className="mt-1 text-sm text-green-700">
                    No repair is needed. This PDF loads and renders normally.
                  </p>
                  <p className="mt-2 text-sm font-medium text-gray-800">
                    Page count: {validationResult.pageCount ?? "Unavailable"}
                  </p>
                </div>
              </div>

              <details className="mt-3 rounded-lg border border-green-200 bg-white">
                <summary className="cursor-pointer select-none px-3 py-2 text-xs font-medium text-gray-500">
                  Technical details
                </summary>
                <div className="space-y-1 px-3 pb-3 text-xs text-gray-600">
                  <p>Renderable pages checked: {validationResult.renderablePages}</p>
                  <p>
                    PDF.js load: {validationResult.pdfJsLoadable ? "Yes" : "No"} · pdf-lib parse:{" "}
                    {validationResult.pdfLibLoadable ? "Yes" : "No"}
                  </p>
                </div>
              </details>
            </div>
          )}

          {/* --- A2: repairable state --- */}
          {validationResult && status && isRepairableState && (
            <div className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-4">
              <div className="flex items-start gap-3">
                <StatusIconCircle icon="⚠" tone="amber" />
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-amber-800">PDF needs repair</p>
                  <p className="mt-1 text-sm text-amber-800">
                    {repairReasonExplanation(validationResult)}
                  </p>
                  <p className="mt-2 text-sm font-medium text-gray-800">
                    Page count: {validationResult.pageCount ?? "Unavailable"}
                  </p>
                </div>
              </div>

              <details className="mt-3 rounded-lg border border-amber-200 bg-white">
                <summary className="cursor-pointer select-none px-3 py-2 text-xs font-medium text-gray-500">
                  Technical details
                </summary>
                <div className="space-y-1 px-3 pb-3 text-xs text-gray-600">
                  <p>Renderable pages checked: {validationResult.renderablePages}</p>
                  <p>
                    PDF.js load: {validationResult.pdfJsLoadable ? "Yes" : "No"} · pdf-lib parse:{" "}
                    {validationResult.pdfLibLoadable ? "Yes" : "No"}
                  </p>
                </div>
              </details>
            </div>
          )}

          {/* --- A3: invalid state --- */}
          {validationResult && status && isInvalidState && (
            <div
              className="mt-4 rounded-lg border border-red-300 bg-red-50 p-4"
              role="alert"
            >
              <div className="flex items-start gap-3">
                <StatusIconCircle icon="✕" tone="red" />
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-red-800">
                    PDF could not be processed
                  </p>
                  <p className="mt-1 text-sm text-red-700">
                    Unable to repair this PDF in the browser.
                  </p>
                </div>
              </div>
            </div>
          )}

          {validationResult && validationResult.issues.length > 0 && (
            <div className="mt-4">
              <h3 className="text-sm font-semibold text-gray-900">Issues</h3>
              <div className="mt-2 space-y-2">
                {validationResult.issues.map((issue, index) => (
                  <div
                    key={`${issue.code}-${index}`}
                    className={`rounded-lg border px-3 py-2 ${issueClasses(issue)}`}
                  >
                    <p className="text-sm font-semibold capitalize">{issue.severity}</p>
                    <p className="text-sm">{issue.message}</p>
                    <p className="mt-1 text-xs opacity-80">{issueExplanation(issue.code)}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {isRepairing && (
            <p
              className="mt-4 text-sm font-medium text-gray-600"
              role="status"
              aria-live="polite"
            >
              <ProcessingState
                isProcessing={isRepairing}
                message="Repairing PDF..."
                stage={
                  repairStage
                    ? { id: repairStage, label: currentStageLabel ?? "Repairing PDF..." }
                    : null
                }
              />
            </p>
          )}

          {/* --- D: raster-salvage confirmation (not an error, not a result) --- */}
          {showRasterSalvagePrompt && (
            <div className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-4">
              <div className="flex items-start gap-3">
                <StatusIconCircle icon="⚠" tone="amber" />
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-amber-800">
                    Lossy image-based recovery needed
                  </p>
                  <p className="mt-1 text-sm text-amber-800">
                    This PDF could not be structurally rebuilt. It can still be salvaged by
                    rebuilding pages as images, but text may no longer be selectable and
                    vector/form/annotation data may be lost.
                  </p>
                </div>
              </div>
            </div>
          )}

          {showRasterSalvagePrompt && (
            <StrategyDiagnosticsPanel diagnostics={repairDiagnostics} />
          )}

          {/* --- E: repair failure --- */}
          {repairFailed && (
            <div
              className="mt-4 rounded-lg border border-red-300 bg-red-50 p-4"
              role="alert"
            >
              <div className="flex items-start gap-3">
                <StatusIconCircle icon="✕" tone="red" />
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-red-800">Safe repair unavailable</p>
                  <p className="mt-1 text-sm text-red-700">
                    This PDF is too severely damaged for DocFlow&apos;s current browser-based
                    recovery methods.
                  </p>
                  {validationResult && !validationResult.pdfJsLoadable && (
                    <p className="mt-1 text-sm text-red-700">
                      Image-based (raster) salvage was not available either, because the original
                      PDF could not be rendered by the browser&apos;s PDF viewer.
                    </p>
                  )}
                </div>
              </div>
            </div>
          )}

          {repairFailed && (
            <StrategyDiagnosticsPanel diagnostics={repairDiagnostics} />
          )}

          {/* --- F: generic errors --- */}
          {error && !repairFailed && (
            <div
              className="mt-4 rounded-lg border border-red-200 bg-red-50 p-4"
              role="alert"
            >
              <div className="flex items-start gap-3">
                <StatusIconCircle icon="✕" tone="red" />
                <p className="text-sm font-medium text-red-700">{error}</p>
              </div>
            </div>
          )}

          {validationResult && validationResult.status !== "invalid" && (
            <button
              type="button"
              onClick={() => void runRepair(false)}
              disabled={!canRepair}
              className={`mt-6 w-full rounded-lg px-4 py-3 text-sm font-semibold transition-colors ${
                !canRepair
                  ? "bg-gray-200 text-gray-400 cursor-not-allowed"
                  : isValidState
                    ? "border border-blue-300 bg-white text-blue-700 hover:bg-blue-50"
                    : "bg-blue-600 text-white hover:bg-blue-700"
              }`}
              aria-busy={isRepairing}
            >
              {isRepairing
                ? currentStageLabel ?? "Repairing PDF..."
                : isValidState
                  ? "Rebuild / Sanitize PDF (optional)"
                  : "Repair PDF"}
            </button>
          )}

          {showRasterSalvagePrompt && selectedFile && (
            <button
              type="button"
              onClick={() => void runRepair(true)}
              disabled={isRepairing || isValidating}
              className={`mt-3 w-full rounded-lg px-4 py-3 text-sm font-semibold transition-colors ${
                isRepairing || isValidating
                  ? "bg-gray-200 text-gray-400 cursor-not-allowed"
                  : "bg-amber-600 text-white hover:bg-amber-700"
              }`}
              aria-busy={isRepairing}
            >
              {isRepairing ? currentStageLabel ?? "Rebuilding pages as images..." : "Continue with image-based repair"}
            </button>
          )}
        </div>

        {repairResult && selectedFile && (
          <ResultPanel
            icon={repairResult.lossy ? "⚠" : "✓"}
            title={repairResultHeading(repairResult)}
            message={
              repairResultStructurePreserved(repairResult)
                ? "Structure preserved — all pages retain their original vector/text content."
                : undefined
            }
            stats={[
              { label: "Method", value: methodLabel(repairResult.method) },
              {
                label: repairResultPagesLabel(repairResult),
                value: `${repairResult.pagesVerified} / ${repairResult.pageCount}`,
              },
              { label: "Original size", value: formatBytes(repairResult.originalSize) },
              { label: "Repaired size", value: formatBytes(repairResult.repairedSize) },
              { label: "Page count", value: repairResult.pageCount },
              { label: "Output validation", value: "Passed" },
            ]}
            onDownload={() =>
              downloadPdfBytes(
                repairResult.bytes,
                getRepairedFilename(selectedFile.name),
              )
            }
            downloadLabel="Download Repaired PDF"
            onReset={handleValidateAnother}
            resetLabel="Validate another PDF"
          >
            {repairResult.warnings.length > 0 && (
              <div className="mb-4 space-y-2">
                {repairResult.warnings.map((warning, index) => (
                  <div
                    key={index}
                    className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800"
                  >
                    {warning}
                  </div>
                ))}
              </div>
            )}

            <StrategyDiagnosticsPanel diagnostics={repairDiagnostics} />
          </ResultPanel>
        )}
      </div>
    </div>
  );
}
