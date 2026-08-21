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
import {
  renderPageThumbnails,
  renderSinglePagePreview,
  type SinglePagePreview,
} from "../services/pdf/thumbnails";
import UploadZone from "./UploadZone";

type PreviewRotation = 0 | RotationDegrees;
type PreviewNavScope = "all" | "flagged";

const rotationClasses: Record<PreviewRotation, string> = {
  0: "",
  90: "rotate-90",
  180: "rotate-180",
  270: "-rotate-90",
};

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

function getStatusIcon(status: PageOrientationResult["status"]): string {
  switch (status) {
    case "normal":
      return "✓";
    case "unable-to-detect":
      return "–";
    default:
      return "⚠";
  }
}

function getPreviewHeadline(page: PageOrientationResult): string {
  switch (page.status) {
    case "normal":
      return "Orientation looks correct.";
    case "likely-rotated":
    case "likely-misaligned":
      return "Likely misoriented";
    case "needs-review":
      return "Review recommended";
    case "unable-to-detect":
      return "Unable to detect orientation";
  }
}

/**
 * Explains why a page was flagged using only fields the analysis service
 * already produces (`status`, `rasterAssessment`, `detectedOrientation`).
 * No new diagnostics are invented here.
 */
function getPreviewReason(page: PageOrientationResult): string {
  switch (page.status) {
    case "normal":
      return "No orientation issue was detected on this page.";
    case "likely-rotated":
      return page.detectedOrientation !== null
        ? `The page content appears rotated ${page.detectedOrientation}° from upright.`
        : "The page content appears rotated from upright.";
    case "likely-misaligned":
      return "This page's orientation doesn't match the rest of the document (a landscape/portrait mismatch). Choose the correct rotation below.";
    case "needs-review":
      return "There wasn't enough clear evidence to confidently auto-detect this page's orientation.";
    case "unable-to-detect":
      return "DocFlow could not analyze this page's orientation.";
  }
}

function getConfidenceLabel(page: PageOrientationResult): string {
  return page.status === "unable-to-detect"
    ? "—"
    : `${Math.round(page.confidence * 100)}%`;
}

export default function FixPageOrientationCard() {
  const isProcessingRef = useRef(false);
  const analysisRequestIdRef = useRef(0);
  const thumbnailRequestIdRef = useRef(0);
  const previewRequestIdRef = useRef(0);
  const previewImageCacheRef = useRef<Map<number, SinglePagePreview>>(new Map());

  const [selectedFile, setSelectedFile] = useState<File | null>(null);
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

  // Thumbnail grid — reuses the existing thumbnail renderer. Preview only,
  // never mutates the source PDF.
  const [pageThumbnails, setPageThumbnails] = useState<Map<number, string | null>>(
    new Map(),
  );
  const [isLoadingThumbnails, setIsLoadingThumbnails] = useState(false);

  // Larger before/after orientation preview (thumbnail click, or "Review
  // suggested fixes"). All state here is ephemeral UI state; the only thing
  // that ever mutates the actual PDF is applyPageRotations, called from
  // handleFixDetectedPages below.
  const [previewPageNumber, setPreviewPageNumber] = useState<number | null>(null);
  const [previewNavScope, setPreviewNavScope] = useState<PreviewNavScope>("all");
  const [previewRotation, setPreviewRotation] = useState<PreviewRotation>(0);
  const [previewImage, setPreviewImage] = useState<SinglePagePreview | null>(null);
  const [isLoadingPreviewImage, setIsLoadingPreviewImage] = useState(false);
  const [previewImageError, setPreviewImageError] = useState<string | null>(null);

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

  const loadThumbnails = async (file: File) => {
    const requestId = ++thumbnailRequestIdRef.current;
    setIsLoadingThumbnails(true);
    setPageThumbnails(new Map());

    try {
      const thumbnails = await renderPageThumbnails(file);

      if (requestId !== thumbnailRequestIdRef.current) return;

      setPageThumbnails(
        new Map(thumbnails.map((thumbnail) => [thumbnail.pageNumber, thumbnail.dataUrl])),
      );
    } catch (thumbnailError) {
      console.error("PDF page thumbnail error:", thumbnailError);
      // Thumbnails are a preview convenience — analysis and corrections still
      // work without them, so a failure here doesn't block the page.
    } finally {
      if (requestId === thumbnailRequestIdRef.current) {
        setIsLoadingThumbnails(false);
      }
    }
  };

  const closePreview = () => {
    previewRequestIdRef.current += 1;
    setPreviewPageNumber(null);
    setPreviewImage(null);
    setIsLoadingPreviewImage(false);
    setPreviewImageError(null);
  };

  const loadPreviewImage = async (file: File, pageNumber: number) => {
    const requestId = ++previewRequestIdRef.current;
    setIsLoadingPreviewImage(true);
    setPreviewImageError(null);

    try {
      const preview = await renderSinglePagePreview(file, pageNumber);

      if (requestId !== previewRequestIdRef.current) return;

      previewImageCacheRef.current.set(pageNumber, preview);
      setPreviewImage(preview);
    } catch (previewError) {
      console.error("PDF orientation page preview error:", previewError);

      if (requestId !== previewRequestIdRef.current) return;

      setPreviewImageError(
        previewError instanceof Error
          ? `Unable to load a larger preview: ${previewError.message}`
          : "Unable to load a larger preview of this page.",
      );
    } finally {
      if (requestId === previewRequestIdRef.current) {
        setIsLoadingPreviewImage(false);
      }
    }
  };

  const openPreview = (pageNumber: number, scope: PreviewNavScope) => {
    if (!analysis || !selectedFile) return;

    const page = analysis.pages.find((candidate) => candidate.pageNumber === pageNumber);
    if (!page) return;

    previewRequestIdRef.current += 1;
    setPreviewNavScope(scope);
    setPreviewPageNumber(pageNumber);
    setPreviewImageError(null);
    setPreviewRotation(
      (manualCorrections.get(pageNumber) ?? page.proposedCorrection ?? 0) as PreviewRotation,
    );

    const cached = previewImageCacheRef.current.get(pageNumber);

    if (cached) {
      setPreviewImage(cached);
      setIsLoadingPreviewImage(false);
      return;
    }

    setPreviewImage(null);
    void loadPreviewImage(selectedFile, pageNumber);
  };

  const acceptPreviewRotation = () => {
    if (previewPageNumber === null) return;

    const pageNumber = previewPageNumber;

    if (previewRotation === 0) {
      // Explicitly "no rotation" — clear any pending correction for this
      // page, even if the system originally proposed one.
      setManualCorrections((current) => {
        const next = new Map(current);
        next.delete(pageNumber);
        return next;
      });
      setSelectedPages((current) => {
        const next = new Set(current);
        next.delete(pageNumber);
        return next;
      });
      return;
    }

    const rotation: RotationDegrees = previewRotation;

    setManualCorrections((current) => {
      const next = new Map(current);
      next.set(pageNumber, rotation);
      return next;
    });
    setSelectedPages((current) => new Set(current).add(pageNumber));
  };

  const selectFile = (file: File | undefined) => {
    if (!file) return;

    if (!isPdfFile(file)) {
      analysisRequestIdRef.current += 1;
      thumbnailRequestIdRef.current += 1;
      closePreview();
      previewImageCacheRef.current = new Map();
      setSelectedFile(null);
      setAnalysis(null);
      setSelectedPages(new Set());
      setManualCorrections(new Map());
      setPageThumbnails(new Map());
      setError("Please select a valid PDF file.");
      setSuccessMessage(null);
      setIsAnalyzing(false);
      setIsLoadingThumbnails(false);
      return;
    }

    closePreview();
    previewImageCacheRef.current = new Map();
    setSelectedFile(file);
    setResult(null);
    setError(null);
    setSuccessMessage(null);
    void startAnalysis(file);
    void loadThumbnails(file);
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

  const flaggedPages = analysis
    ? analysis.pages.filter(
        (page) => page.status !== "normal" && page.status !== "unable-to-detect",
      )
    : [];
  const previewPool = previewNavScope === "flagged" ? flaggedPages : analysis?.pages ?? [];
  const previewIndex =
    previewPageNumber !== null
      ? previewPool.findIndex((page) => page.pageNumber === previewPageNumber)
      : -1;
  const canGoToPreviousPreviewPage = previewIndex > 0;
  const canGoToNextPreviewPage =
    previewIndex !== -1 && previewIndex < previewPool.length - 1;

  const goToAdjacentPreviewPage = (direction: 1 | -1) => {
    if (previewIndex === -1) return;

    const nextIndex = previewIndex + direction;
    if (nextIndex < 0 || nextIndex >= previewPool.length) return;

    openPreview(previewPool[nextIndex].pageNumber, previewNavScope);
  };

  const previewPage =
    previewPageNumber !== null && analysis
      ? analysis.pages.find((page) => page.pageNumber === previewPageNumber) ?? null
      : null;

  const handleFixDetectedPages = async () => {
    if (isProcessingRef.current || !selectedFile || !analysis) return;

    const corrections: PageRotationCorrection[] = analysis.pages.flatMap((page) => {
      if (!selectedPages.has(page.pageNumber)) return [];

      // A user-chosen rotation (set inline, or accepted from the preview)
      // takes precedence over the system's proposed correction.
      const rotation = manualCorrections.get(page.pageNumber) ?? page.proposedCorrection;

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
    thumbnailRequestIdRef.current += 1;
    closePreview();
    previewImageCacheRef.current = new Map();
    setSelectedFile(null);
    setAnalysis(null);
    setSelectedPages(new Set());
    setManualCorrections(new Map());
    setPageThumbnails(new Map());
    setIsLoadingThumbnails(false);
    setResult(null);
    setError(null);
    setSuccessMessage(null);
    setIsAnalyzing(false);
    setAnalysisProgress("");
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

        <UploadZone
          accept=".pdf,application/pdf"
          onFileSelect={(file) => void selectFile(file)}
          disabled={isAnalyzing || isProcessing}
          title="Choose a PDF to analyze"
          helperText="or drag and drop it here"
          className="mx-4 sm:mx-6 mt-6 mb-4"
        />

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
            <div className="mt-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-medium text-gray-700">
                  {analysis.pageCount} page{analysis.pageCount === 1 ? "" : "s"} analyzed
                </p>
                {flaggedPages.length > 0 && (
                  <button
                    type="button"
                    onClick={() => openPreview(flaggedPages[0].pageNumber, "flagged")}
                    disabled={isProcessing}
                    className="text-sm font-medium text-blue-600 hover:text-blue-700 disabled:text-gray-400"
                  >
                    Review suggested fixes ({flaggedPages.length})
                  </button>
                )}
              </div>

              <div className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-3">
                {analysis.pages.map((page) => {
                  const isSuggested =
                    page.status === "likely-rotated" ||
                    page.status === "likely-misaligned";
                  const requiresManualCorrection =
                    page.status === "likely-misaligned";
                  const isSelected = selectedPages.has(page.pageNumber);
                  const thumbnailUrl = pageThumbnails.get(page.pageNumber);

                  return (
                    <div
                      key={page.pageNumber}
                      className={`relative flex flex-col rounded-lg border-2 p-2 transition-colors ${
                        isSelected
                          ? "border-blue-500 bg-blue-50"
                          : page.status !== "normal" && page.status !== "unable-to-detect"
                            ? "border-amber-300 bg-amber-50/40"
                            : "border-gray-200 bg-white"
                      }`}
                    >
                      {isSuggested && (
                        <input
                          id={`orientation-page-${page.pageNumber}`}
                          type="checkbox"
                          aria-label={`Select page ${page.pageNumber} for correction`}
                          checked={isSelected}
                          disabled={isProcessing}
                          onChange={() => togglePage(page.pageNumber)}
                          className="absolute left-2 top-2 z-10 h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                        />
                      )}

                      <span
                        aria-hidden="true"
                        title={getStatusLabel(page)}
                        className={`absolute right-2 top-2 z-10 text-sm ${getStatusClass(page.status)}`}
                      >
                        {getStatusIcon(page.status)}
                      </span>

                      <button
                        type="button"
                        onClick={() => openPreview(page.pageNumber, "all")}
                        disabled={!selectedFile}
                        aria-label={`Open orientation preview for page ${page.pageNumber}`}
                        className="flex h-28 w-full items-center justify-center overflow-hidden rounded bg-gray-100"
                      >
                        {thumbnailUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={thumbnailUrl}
                            alt={`Page ${page.pageNumber} preview`}
                            className="max-h-full max-w-full object-contain"
                          />
                        ) : (
                          <span className="text-xs text-gray-500">
                            {isLoadingThumbnails ? "Loading…" : "No preview"}
                          </span>
                        )}
                      </button>

                      <p className="mt-2 text-center text-xs font-semibold text-gray-800">
                        Page {page.pageNumber}
                      </p>
                      <p className={`mt-0.5 text-center text-[11px] font-medium ${getStatusClass(page.status)}`}>
                        {getStatusLabel(page)}
                      </p>
                      {page.status !== "unable-to-detect" && (
                        <p className="text-center text-[11px] text-gray-500">
                          {getConfidenceLabel(page)} confidence
                        </p>
                      )}

                      {requiresManualCorrection && (
                        <label
                          htmlFor={`orientation-correction-${page.pageNumber}`}
                          className="mt-1 block text-center text-[11px] text-gray-600"
                        >
                          <select
                            id={`orientation-correction-${page.pageNumber}`}
                            aria-label={`Rotation for page ${page.pageNumber}`}
                            value={manualCorrections.get(page.pageNumber) ?? ""}
                            disabled={isProcessing}
                            onChange={(event) =>
                              setManualCorrection(page.pageNumber, event.target.value)
                            }
                            className="mt-0.5 w-full rounded border border-gray-300 bg-white px-1 py-0.5 text-[11px] text-gray-700"
                          >
                            <option value="">Choose direction</option>
                            <option value="90">90° clockwise</option>
                            <option value="270">270° clockwise</option>
                          </select>
                        </label>
                      )}
                    </div>
                  );
                })}
              </div>
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

      {previewPageNumber !== null && previewPage && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`Page ${previewPageNumber} orientation preview`}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4 py-6"
          onClick={closePreview}
          onKeyDown={(event) => {
            if (event.key === "Escape") closePreview();
          }}
        >
          <div
            className="max-h-full w-full max-w-3xl overflow-y-auto rounded-2xl bg-white shadow-xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3 border-b border-gray-100 px-5 py-4">
              <div>
                <p className="text-sm font-medium text-gray-500">Page {previewPageNumber}</p>
                <h3 className="text-lg font-bold text-gray-900">
                  {getPreviewHeadline(previewPage)}
                </h3>
              </div>
              <button
                type="button"
                onClick={closePreview}
                aria-label="Close preview"
                className="rounded-full p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
              >
                ✕
              </button>
            </div>

            <div className="px-5 py-4">
              <dl className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
                <div>
                  <dt className="text-gray-500">Detected orientation</dt>
                  <dd className="mt-0.5 font-semibold text-gray-800">
                    {previewPage.detectedOrientation !== null
                      ? `${previewPage.detectedOrientation}°`
                      : "Not detected"}
                  </dd>
                </div>
                <div>
                  <dt className="text-gray-500">Suggested correction</dt>
                  <dd className="mt-0.5 font-semibold text-gray-800">
                    {previewPage.proposedCorrection !== null
                      ? `Rotate ${previewPage.proposedCorrection}° clockwise`
                      : previewPage.status === "likely-misaligned"
                        ? "Choose a rotation below"
                        : "No rotation needed"}
                  </dd>
                </div>
                <div>
                  <dt className="text-gray-500">Confidence</dt>
                  <dd className="mt-0.5 font-semibold text-gray-800">
                    {getConfidenceLabel(previewPage)}
                  </dd>
                </div>
                <div>
                  <dt className="text-gray-500">Correction status</dt>
                  <dd className={`mt-0.5 font-semibold ${getStatusClass(previewPage.status)}`}>
                    {selectedPages.has(previewPageNumber) ? "Pending correction" : "Not selected"}
                  </dd>
                </div>
              </dl>

              <p className="mt-3 text-sm text-gray-600">{getPreviewReason(previewPage)}</p>

              {isLoadingPreviewImage && (
                <p className="mt-4 text-sm font-medium text-gray-500">
                  Loading page preview...
                </p>
              )}
              {previewImageError && (
                <p className="mt-4 text-sm font-medium text-red-600">{previewImageError}</p>
              )}

              {previewImage && (
                <>
                  <div className="mt-4 flex flex-col sm:flex-row gap-4">
                    <div className="flex-1">
                      <p className="mb-1 text-center text-xs font-semibold uppercase tracking-wide text-gray-500">
                        Original
                      </p>
                      <div className="flex items-center justify-center rounded-lg border border-gray-200 bg-gray-50 p-3">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={previewImage.dataUrl}
                          alt={`Page ${previewPageNumber} original`}
                          className="max-h-64 w-auto object-contain"
                        />
                      </div>
                    </div>
                    <div className="flex-1">
                      <p className="mb-1 text-center text-xs font-semibold uppercase tracking-wide text-gray-500">
                        After correction
                      </p>
                      <div className="flex items-center justify-center rounded-lg border border-gray-200 bg-gray-50 p-3">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={previewImage.dataUrl}
                          alt={`Page ${previewPageNumber} after rotation`}
                          className={`max-h-64 w-auto object-contain transition-transform ${rotationClasses[previewRotation]}`}
                        />
                      </div>
                    </div>
                  </div>

                  <p className="mt-3 text-center text-xs text-gray-500">
                    This preview does not change your PDF. Nothing is applied until you accept the correction and click Fix.
                  </p>

                  <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
                    <button
                      type="button"
                      onClick={() =>
                        setPreviewRotation(((previewRotation + 270) % 360) as PreviewRotation)
                      }
                      className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:border-blue-300 hover:bg-blue-50"
                    >
                      ↺ Rotate left
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        setPreviewRotation(((previewRotation + 90) % 360) as PreviewRotation)
                      }
                      className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:border-blue-300 hover:bg-blue-50"
                    >
                      ↻ Rotate right
                    </button>
                    {([0, 90, 180, 270] as PreviewRotation[]).map((option) => (
                      <button
                        key={option}
                        type="button"
                        onClick={() => setPreviewRotation(option)}
                        className={`rounded-lg border px-3 py-2 text-sm font-medium transition-colors ${
                          previewRotation === option
                            ? "border-blue-500 bg-blue-600 text-white"
                            : "border-gray-200 bg-white text-gray-700 hover:border-blue-300 hover:bg-blue-50"
                        }`}
                      >
                        {option}°
                      </button>
                    ))}
                  </div>
                </>
              )}

              <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-gray-100 pt-4">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => goToAdjacentPreviewPage(-1)}
                    disabled={!canGoToPreviousPreviewPage}
                    className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:border-blue-300 hover:bg-blue-50 disabled:cursor-not-allowed disabled:text-gray-300"
                  >
                    ← Previous
                  </button>
                  <span className="text-xs text-gray-500">
                    {previewNavScope === "flagged"
                      ? `Flagged page ${previewIndex + 1} of ${flaggedPages.length}`
                      : `Page ${previewPageNumber} of ${analysis?.pageCount ?? 0}`}
                  </span>
                  <button
                    type="button"
                    onClick={() => goToAdjacentPreviewPage(1)}
                    disabled={!canGoToNextPreviewPage}
                    className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:border-blue-300 hover:bg-blue-50 disabled:cursor-not-allowed disabled:text-gray-300"
                  >
                    Next →
                  </button>
                </div>

                <button
                  type="button"
                  onClick={() => {
                    acceptPreviewRotation();
                    closePreview();
                  }}
                  className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-blue-700"
                >
                  Accept correction
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
