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
      text: "PDF has recoverable issues",
      colorClass: "text-amber-700",
    };
  }

  return {
    icon: "✕",
    text: "PDF could not be processed",
    colorClass: "text-red-700",
  };
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
    case "raster-salvage":
      return "Raster salvage";
    default:
      return method;
  }
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

export default function RepairValidatePdfCard() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const validationRequestIdRef = useRef(0);
  const isRepairingRef = useRef(false);

  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isDragging, setIsDragging] = useState(false);
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

  const canRepair =
    selectedFile !== null &&
    validationResult !== null &&
    validationResult.status !== "invalid" &&
    !isRepairing &&
    !isValidating;

  const status = validationResult ? getStatusLabel(validationResult.status) : null;
  const currentStageLabel = stageLabel(repairStage);

  return (
    <div className="w-full max-w-2xl mx-auto px-4 sm:px-6">
      <div className="bg-white rounded-2xl shadow-lg border border-gray-100 overflow-hidden">
        <div className="px-4 sm:px-6 pt-6 sm:pt-8">
          <h2 className="text-xl font-bold text-gray-900">Repair &amp; Validate PDF</h2>
          <p className="mt-1 text-sm text-gray-500">
            Validate and rebuild PDFs that are readable or renderable.
          </p>
        </div>

        <input
          ref={fileInputRef}
          type="file"
          accept=".pdf,application/pdf"
          className="hidden"
          onChange={(event) => {
            selectFile(event.target.files?.[0]);
            event.target.value = "";
          }}
        />

        <div
          role="button"
          tabIndex={0}
          onClick={() => fileInputRef.current?.click()}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              fileInputRef.current?.click();
            }
          }}
          onDragEnter={() => setIsDragging(true)}
          onDragLeave={() => setIsDragging(false)}
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault();
            setIsDragging(false);
            selectFile(event.dataTransfer.files?.[0]);
          }}
          className={`mx-4 sm:mx-6 mt-6 mb-4 flex flex-col items-center justify-center rounded-xl border-2 border-dashed px-6 py-10 transition-colors cursor-pointer ${
            isDragging
              ? "border-blue-500 bg-blue-50"
              : "border-gray-300 bg-gray-50 hover:border-blue-400 hover:bg-blue-50/50"
          }`}
        >
          <p className="text-base font-medium text-gray-800 text-center">
            Upload a PDF to check its integrity
          </p>
          <p className="mt-1 text-sm text-gray-500">or drag and drop it here</p>
        </div>

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
            <p className="mt-4 text-sm font-medium text-gray-600">Validating PDF...</p>
          )}

          {validationResult && status && (
            <div className="mt-4 space-y-2 rounded-lg border border-gray-200 bg-white p-4">
              <p className={`text-sm font-semibold ${status.colorClass}`}>
                {status.icon} {status.text}
              </p>
              <p className="text-sm text-gray-600">
                Page count: {validationResult.pageCount ?? "Unavailable"}
              </p>
              <p className="text-sm text-gray-600">
                Renderable pages checked: {validationResult.renderablePages}
              </p>
              <p className="text-sm text-gray-600">
                PDF.js load: {validationResult.pdfJsLoadable ? "Yes" : "No"} · pdf-lib parse: {validationResult.pdfLibLoadable ? "Yes" : "No"}
              </p>
              {!validationResult.pdfJsLoadable && validationResult.pdfLibLoadable && (
                <p className="text-sm text-amber-700">
                  PDF structure can still be read, but page rendering could not be verified. A repair attempt is available.
                </p>
              )}
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

          {validationResult?.status === "valid" && (
            <p className="mt-4 text-sm font-medium text-green-700">PDF is healthy.</p>
          )}

          {validationResult?.status === "invalid" && (
            <p className="mt-4 text-sm font-medium text-red-700">
              Unable to repair this PDF in the browser.
            </p>
          )}

          {isRepairing && currentStageLabel && (
            <p className="mt-4 text-sm font-medium text-gray-600">{currentStageLabel}</p>
          )}

          {showRasterSalvagePrompt && (
            <div className="mt-4 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800">
              <p className="font-semibold">Lossy salvage required</p>
              <p className="mt-1">
                This PDF could not be structurally rebuilt. It can still be salvaged by rebuilding
                pages as images, but text may no longer be selectable and vector/form/annotation
                data may be lost.
              </p>
            </div>
          )}

          {showRasterSalvagePrompt && (
            <StrategyDiagnosticsPanel diagnostics={repairDiagnostics} />
          )}

          {repairFailed && (
            <div className="mt-4 rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700">
              <p className="font-semibold">✕ Safe repair unavailable</p>
              <p className="mt-1">
                This PDF is too severely damaged for DocFlow&apos;s current browser-based recovery
                methods.
              </p>
              {validationResult && !validationResult.pdfJsLoadable && (
                <p className="mt-1">
                  Image-based (raster) salvage was not available either, because the original PDF
                  could not be rendered by the browser&apos;s PDF viewer.
                </p>
              )}
            </div>
          )}

          {repairFailed && (
            <StrategyDiagnosticsPanel diagnostics={repairDiagnostics} />
          )}

          {error && !repairFailed && (
            <p className="mt-4 text-sm font-medium text-red-600">{error}</p>
          )}

          {validationResult && validationResult.status !== "invalid" && (
            <button
              type="button"
              onClick={() => void runRepair(false)}
              disabled={!canRepair}
              className={`mt-6 w-full rounded-lg px-4 py-3 text-sm font-semibold transition-colors ${
                canRepair
                  ? "bg-blue-600 text-white hover:bg-blue-700"
                  : "bg-gray-200 text-gray-400 cursor-not-allowed"
              }`}
            >
              {isRepairing
                ? currentStageLabel ?? "Repairing PDF..."
                : validationResult.status === "valid"
                  ? "Rebuild / Sanitize PDF"
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
            >
              {isRepairing ? currentStageLabel ?? "Rebuilding pages as images..." : "Continue with image-based repair"}
            </button>
          )}
        </div>

        {repairResult && selectedFile && (
          <div className="border-t border-gray-100 bg-gray-50 px-4 sm:px-6 py-6">
            <div className="mb-4 flex items-start gap-3">
              <div
                className={`flex h-10 w-10 items-center justify-center rounded-full text-xl ${
                  repairResult.lossy ? "bg-amber-100" : "bg-green-100"
                }`}
              >
                {repairResult.lossy ? "⚠" : "✓"}
              </div>
              <div>
                <p className="text-base font-semibold text-gray-900">
                  {repairResult.method === "raster-salvage"
                    ? "Salvage successful (lossy)"
                    : repairResult.lossy
                      ? "Partial repair — some pages could not be recovered"
                      : "Repair successful"}
                </p>
                <p className="text-sm text-gray-600">Method: {methodLabel(repairResult.method)}</p>
                <p className="text-sm text-gray-600">
                  Pages verified: {repairResult.pagesVerified} / {repairResult.pageCount}
                </p>
              </div>
            </div>

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

            <div className="mb-4 rounded-lg border border-gray-200 bg-white px-4 py-3 text-sm text-gray-700">
              <p>Original size: {formatBytes(repairResult.originalSize)}</p>
              <p>Repaired size: {formatBytes(repairResult.repairedSize)}</p>
              <p>Page count: {repairResult.pageCount}</p>
              <p>
                Validation: {repairResult.validation.status === "valid" ? "Healthy" : "Repairable"}
              </p>
            </div>

            <StrategyDiagnosticsPanel diagnostics={repairDiagnostics} />

            <button
              type="button"
              onClick={() =>
                downloadPdfBytes(
                  repairResult.bytes,
                  getRepairedFilename(selectedFile.name),
                )
              }
              className="w-full rounded-xl bg-blue-600 py-3 text-base font-semibold text-white transition hover:bg-blue-700"
            >
              Download Repaired PDF
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
