"use client";

import { useRef, useState } from "react";
import {
  analyzePdfOrientation,
  type OrientationAnalysisResult,
  type PageOrientationResult,
} from "../services/pdf/orientation";
import {
  applyPageRotations,
  type PageRotationCorrection,
  type PageRotationResult,
  type RotationDegrees,
} from "../services/pdf/rotate";

function isPdfFile(file: File): boolean {
  return (
    file.type === "application/pdf" ||
    file.name.toLowerCase().endsWith(".pdf")
  );
}

function getOrientationFixedFilename(originalName: string): string {
  if (originalName.toLowerCase().endsWith(".pdf")) {
    return `${originalName.slice(0, -4)}-orientation-fixed.pdf`;
  }

  return `${originalName}-orientation-fixed.pdf`;
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

function getStatusLabel(page: PageOrientationResult): string {
  switch (page.status) {
    case "normal":
      return "Normal";
    case "likely-rotated":
      return `Likely rotated ${page.detectedOrientation}° clockwise — fix by ${page.proposedCorrection}° clockwise`;
    case "likely-misaligned":
      return "Likely misaligned - landscape outlier. Choose a rotation to fix it.";
    case "needs-review":
      return "Needs review";
    case "unable-to-detect":
      return "Unable to detect";
  }
}

function getStatusClass(status: PageOrientationResult["status"]): string {
  switch (status) {
    case "normal":
      return "text-green-700";
    case "likely-rotated":
      return "text-amber-700";
    case "likely-misaligned":
      return "text-amber-700";
    case "needs-review":
      return "text-amber-700";
    case "unable-to-detect":
      return "text-gray-500";
  }
}

export default function FixPageOrientationCard() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const isProcessingRef = useRef(false);
  const analysisRequestIdRef = useRef(0);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analysisProgress, setAnalysisProgress] = useState("");
  const [analysis, setAnalysis] = useState<OrientationAnalysisResult | null>(null);
  const [selectedPages, setSelectedPages] = useState<Set<number>>(new Set());
  const [manualCorrections, setManualCorrections] = useState<
    Map<number, RotationDegrees>
  >(new Map());
  const [isProcessing, setIsProcessing] = useState(false);
  const [result, setResult] = useState<PageRotationResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const startAnalysis = async (file: File) => {
    const requestId = ++analysisRequestIdRef.current;
    setIsAnalyzing(true);
    setAnalysisProgress("Analyzing page orientation...");
    setAnalysis(null);
    setSelectedPages(new Set());
    setManualCorrections(new Map());

    try {
      const analysisResult = await analyzePdfOrientation(file, (progress) => {
        if (requestId === analysisRequestIdRef.current) {
          setAnalysisProgress(
            `Analyzing page ${progress.currentPage} of ${progress.pageCount}...`,
          );
        }
      });

      if (requestId !== analysisRequestIdRef.current) return;

      setAnalysis(analysisResult);
      setSelectedPages(
        new Set(
          analysisResult.pages
            .filter((page) => page.status === "likely-rotated")
            .map((page) => page.pageNumber),
        ),
      );
    } catch (analysisError) {
      console.error("PDF orientation analysis error:", analysisError);

      if (requestId !== analysisRequestIdRef.current) return;

      setError(
        analysisError instanceof Error
          ? `Orientation analysis failed: ${analysisError.message}`
          : "Unable to analyze this PDF's page orientation.",
      );
    } finally {
      if (requestId === analysisRequestIdRef.current) {
        setIsAnalyzing(false);
        setAnalysisProgress("");
      }
    }
  };

  const selectFile = (file: File | undefined) => {
    if (!file) return;

    if (!isPdfFile(file)) {
      analysisRequestIdRef.current += 1;
      setSelectedFile(null);
      setAnalysis(null);
      setSelectedPages(new Set());
      setManualCorrections(new Map());
      setError("Please select a valid PDF file.");
      setSuccessMessage(null);
      setIsAnalyzing(false);
      return;
    }

    setSelectedFile(file);
    setResult(null);
    setError(null);
    setSuccessMessage(null);
    void startAnalysis(file);
  };

  const togglePage = (pageNumber: number) => {
    setSelectedPages((current) => {
      const next = new Set(current);

      if (next.has(pageNumber)) {
        next.delete(pageNumber);
      } else {
        next.add(pageNumber);
      }

      return next;
    });
  };

  const setManualCorrection = (pageNumber: number, value: string) => {
    setManualCorrections((current) => {
      const next = new Map(current);
      const rotation = Number(value);

      if (rotation === 90 || rotation === 180 || rotation === 270) {
        next.set(pageNumber, rotation);
      } else {
        next.delete(pageNumber);
      }

      return next;
    });
  };

  const handleFixDetectedPages = async () => {
    if (isProcessingRef.current || !selectedFile || !analysis) return;

    const corrections: PageRotationCorrection[] = analysis.pages.flatMap((page) => {
      if (!selectedPages.has(page.pageNumber)) return [];

      const rotation = page.proposedCorrection ?? manualCorrections.get(page.pageNumber);

      return rotation ? [{ pageNumber: page.pageNumber, rotation }] : [];
    });

    if (corrections.length === 0) {
      setError("Select at least one high-confidence detected page to fix.");
      return;
    }

    isProcessingRef.current = true;
    setIsProcessing(true);
    setError(null);
    setSuccessMessage(null);

    try {
      const rotationResult = await applyPageRotations(selectedFile, corrections);

      setResult(rotationResult);
      downloadPdfBytes(
        rotationResult.bytes,
        getOrientationFixedFilename(selectedFile.name),
      );
      setSuccessMessage(
        `Fixed the orientation of ${rotationResult.appliedCorrections.length} page${
          rotationResult.appliedCorrections.length === 1 ? "" : "s"
        }.`,
      );
    } catch (rotationError) {
      console.error("PDF orientation fix error:", rotationError);
      setError(
        rotationError instanceof Error
          ? `Orientation fix failed: ${rotationError.message}`
          : "Failed to fix the selected page orientations.",
      );
    } finally {
      isProcessingRef.current = false;
      setIsProcessing(false);
    }
  };

  const handleFixAnother = () => {
    analysisRequestIdRef.current += 1;
    setSelectedFile(null);
    setAnalysis(null);
    setSelectedPages(new Set());
    setManualCorrections(new Map());
    setResult(null);
    setError(null);
    setSuccessMessage(null);
    setIsAnalyzing(false);
    setAnalysisProgress("");

    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  const detectedPageCount = analysis?.pages.filter((page) =>
    selectedPages.has(page.pageNumber) &&
    (page.proposedCorrection !== null || manualCorrections.has(page.pageNumber)),
  ).length ?? 0;
  const canFix =
    selectedFile !== null &&
    analysis !== null &&
    detectedPageCount > 0 &&
    !isAnalyzing &&
    !isProcessing;

  return (
    <div className="w-full max-w-2xl mx-auto px-4 sm:px-6">
      <div className="bg-white rounded-2xl shadow-lg border border-gray-100 overflow-hidden">
        <div className="px-4 sm:px-6 pt-6 sm:pt-8">
          <h2 className="text-xl font-bold text-gray-900">Fix Page Orientation</h2>
          <p className="mt-1 text-sm text-gray-500">
            Text fixes are high-confidence. Image-only outliers require you to choose a rotation before applying.
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
            Choose a PDF to analyze
          </p>
          <p className="mt-1 text-sm text-gray-500">or drag and drop it here</p>
        </div>

        <div className="px-4 sm:px-6 pb-6">
          {selectedFile && (
            <div className="rounded-lg bg-gray-50 border border-gray-200 px-4 py-3">
              <p className="text-sm font-medium text-gray-800 truncate">
                {selectedFile.name}
              </p>
              <p className="mt-1 text-sm text-gray-500">
                {(selectedFile.size / 1024).toFixed(2)} KB
              </p>
            </div>
          )}

          {isAnalyzing && (
            <p className="mt-4 text-sm font-medium text-gray-500">
              {analysisProgress}
            </p>
          )}
          {error && (
            <p className="mt-4 text-sm font-medium text-red-600">{error}</p>
          )}
          {successMessage && (
            <p className="mt-4 text-sm font-medium text-green-600">
              {successMessage}
            </p>
          )}

          {analysis && (
            <div className="mt-4 rounded-lg border border-gray-200 bg-gray-50 divide-y divide-gray-200">
              {analysis.pages.map((page) => {
                const isSuggested =
                  page.status === "likely-rotated" ||
                  page.status === "likely-misaligned";
                const requiresManualCorrection =
                  page.status === "likely-misaligned";

                return (
                  <div
                    key={page.pageNumber}
                    className="flex items-center gap-3 px-4 py-3"
                  >
                    {isSuggested ? (
                      <input
                        id={`orientation-page-${page.pageNumber}`}
                        type="checkbox"
                        checked={selectedPages.has(page.pageNumber)}
                        disabled={isProcessing}
                        onChange={() => togglePage(page.pageNumber)}
                        className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                      />
                    ) : (
                      <span className="w-4" aria-hidden="true" />
                    )}

                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-gray-800">
                        Page {page.pageNumber}
                      </p>
                      <p className={`mt-0.5 text-xs font-medium ${getStatusClass(page.status)}`}>
                        {getStatusLabel(page)}
                      </p>
                      {requiresManualCorrection && (
                        <label
                          htmlFor={`orientation-correction-${page.pageNumber}`}
                          className="mt-1 block text-xs text-gray-600"
                        >
                          Rotation
                          <select
                            id={`orientation-correction-${page.pageNumber}`}
                            value={manualCorrections.get(page.pageNumber) ?? ""}
                            disabled={isProcessing}
                            onChange={(event) =>
                              setManualCorrection(page.pageNumber, event.target.value)
                            }
                            className="ml-2 rounded border border-gray-300 bg-white px-1.5 py-0.5 text-xs text-gray-700"
                          >
                            <option value="">Choose direction</option>
                            <option value="90">90 degrees clockwise</option>
                            <option value="270">270 degrees clockwise</option>
                          </select>
                        </label>
                      )}
                    </div>

                    {page.status !== "unable-to-detect" && (
                      <p className="text-xs text-gray-500">
                        {Math.round(page.confidence * 100)}% confidence
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {analysis && detectedPageCount === 0 && (
            <p className="mt-4 text-sm text-gray-500">
              No confirmed orientation fixes were selected. Pages needing review are left unchanged.
            </p>
          )}

          <button
            type="button"
            onClick={handleFixDetectedPages}
            disabled={!canFix}
            className={`mt-6 w-full rounded-lg px-4 py-3 text-sm font-semibold transition-colors ${
              canFix
                ? "bg-blue-600 text-white hover:bg-blue-700"
                : "bg-gray-200 text-gray-400 cursor-not-allowed"
            }`}
          >
            {isProcessing
              ? "Fixing page orientation..."
              : `Fix ${detectedPageCount} detected page${detectedPageCount === 1 ? "" : "s"}`}
          </button>

          {result && (
            <>
              <p className="mt-2 text-sm text-gray-500">
                Completed in {(result.processingTime / 1000).toFixed(2)}s.
              </p>
              <button
                type="button"
                onClick={handleFixAnother}
                className="mt-3 w-full rounded-lg border border-gray-300 bg-white px-4 py-3 text-sm font-semibold text-gray-700 transition-colors hover:bg-gray-50"
              >
                Fix another PDF
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
