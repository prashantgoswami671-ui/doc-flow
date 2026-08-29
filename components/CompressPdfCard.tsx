"use client";

import { useRef, useState } from "react";
import { analyzePDF, type PdfAnalysis } from "../services/analyze";
import {
  compressPDF,
  type CompressionMode,
  type CompressionResult,
} from "../services/pdf/compress";

import ResultCard, { formatFileSize } from "./ResultCard";
import UploadZone from "./UploadZone";

interface CompressionOptionTrait {
  /** Small leading glyph, matching the emoji-tag pattern already used in ResultCard. */
  icon: string;
  text: string;
}

interface CompressionOptionMeta {
  id: CompressionMode;
  label: string;
  description: string;
  /** Short gain/loss cues shown under the description so the trade-off is visible before compressing. */
  traits: CompressionOptionTrait[];
}

const compressionOptions: CompressionOptionMeta[] = [
  {
    id: "light",
    label: "Light Compression",
    description: "Keeps quality high; reduces size where it's easy to.",
    traits: [
      { icon: "\ud83d\udd0d", text: "Higher visual quality" },
      { icon: "\ud83d\udcc9", text: "Smaller size reduction" },
    ],
  },
  {
    id: "heavy",
    label: "Heavy Compression",
    description: "Prioritizes a smaller file; quality loss may be more visible.",
    traits: [
      { icon: "\ud83d\udce6", text: "Largest size reduction" },
      { icon: "\u26a0\ufe0f", text: "More visible quality loss" },
    ],
  },
  {
    id: "custom",
    label: "Custom Size",
    description: "Set a target size and DocFlow will try to reach it.",
    traits: [{ icon: "\ud83c\udfaf", text: "You choose the target size" }],
  },
];

/** Returns true when the file is a PDF (by MIME type or extension). */
function isPdfFile(file: File): boolean {
  const isPdfMime = file.type === "application/pdf";
  const isPdfExtension = file.name.toLowerCase().endsWith(".pdf");
  return isPdfMime || isPdfExtension;
}

/** Maps compressibility values to user-facing labels. */
function formatCompressibilityLabel(
  value: PdfAnalysis["estimatedCompressibility"],
): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/** Builds a download filename from the original PDF name (e.g. report.pdf → report-compressed.pdf). */
function getCompressedFilename(originalName: string): string {
  if (originalName.toLowerCase().endsWith(".pdf")) {
    return `${originalName.slice(0, -4)}-compressed.pdf`;
  }

  return `${originalName}-compressed.pdf`;
}

/** Triggers a browser download for PDF bytes and cleans up the object URL. */
function downloadPdfBytes(bytes: Uint8Array, filename: string): void {
  const blob = new Blob([bytes as BlobPart], { type: "application/pdf" });
  const objectUrl = URL.createObjectURL(blob);

  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = filename;
  link.click();

  URL.revokeObjectURL(objectUrl);
}

export default function CompressPdfCard() {
  const isProcessingRef = useRef(false);
  const analysisRequestIdRef = useRef(0);

  const [compressionMode, setCompressionMode] =
    useState<CompressionMode>("light");
  const [customSize, setCustomSize] = useState("");

  // Selected PDF file, validation error, and post-download success message
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [result, setResult] = useState<CompressionResult | null>(null);
  const [analysis, setAnalysis] = useState<PdfAnalysis | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analysisError, setAnalysisError] = useState<string | null>(null);

  /** Runs PDF analysis and ignores stale results from earlier selections. */
  const startAnalysis = async (file: File) => {
    const requestId = ++analysisRequestIdRef.current;

    // Warm up the pdfjs-dist chunk now, while the "Analyzing PDF..." state
    // is already showing, so it isn't loaded for the first time right as
    // compression starts (which is what caused the processing-state flash).
    // Fire-and-forget: compression logic itself is untouched.
    void import("pdfjs-dist/legacy/build/pdf.mjs");

    setAnalysis(null);
    setAnalysisError(null);
    setIsAnalyzing(true);

    try {
      const analysisResult = await analyzePDF(file);

      if (requestId !== analysisRequestIdRef.current) {
        return;
      }

      setAnalysis(analysisResult);
    } catch (analysisFailure) {
      console.error("PDF analysis error:", analysisFailure);

      if (requestId !== analysisRequestIdRef.current) {
        return;
      }

      setAnalysisError(
        analysisFailure instanceof Error
          ? `Analysis unavailable: ${analysisFailure.message}`
          : "Analysis unavailable for this PDF.",
      );
    } finally {
      if (requestId === analysisRequestIdRef.current) {
        setIsAnalyzing(false);
      }
    }
  };

  /** Validates and stores the chosen file, or shows an error. */
  const handleFileSelection = (file: File | undefined) => {
    if (!file) return;

    if (!isPdfFile(file)) {
      analysisRequestIdRef.current += 1;
      setSelectedFile(null);
      setError("Please select a valid PDF file.");
      setAnalysis(null);
      setAnalysisError(null);
      setIsAnalyzing(false);
      return;
    }

    setSelectedFile(file);
    setError(null);
    setSuccessMessage(null);
    setResult(null);
    void startAnalysis(file);
  };

  /** Clears result state so the user can compress another PDF. */
  const handleCompressAnother = () => {
    analysisRequestIdRef.current += 1;
    setResult(null);
    setSelectedFile(null);
    setSuccessMessage(null);
    setError(null);
    setAnalysis(null);
    setAnalysisError(null);
    setIsAnalyzing(false);
  };

  const trimmedCustomSize = customSize.trim();
  const customSizeValue = Number(trimmedCustomSize);
  const isCustomSizeInvalid =
    compressionMode === "custom" &&
    (trimmedCustomSize === "" ||
      !Number.isFinite(customSizeValue) ||
      customSizeValue <= 0);
  // Only show the inline validation message once the user has typed
  // something invalid, not while the field is simply still empty.
  const showCustomSizeError =
    compressionMode === "custom" &&
    trimmedCustomSize !== "" &&
    isCustomSizeInvalid;

  const canCompress =
    selectedFile !== null && !isProcessing && !isCustomSizeInvalid;

  /** Delegates compression to the pdf service and surfaces success or failure. */
  const handleCompressPdf = async () => {
    if (isProcessingRef.current || !selectedFile || isCustomSizeInvalid) return;

    isProcessingRef.current = true;
    setIsProcessing(true);
    setSuccessMessage(null);
    setError(null);

    try {
      const compressionResult = await compressPDF(
        selectedFile,
        compressionMode,
        compressionMode === "custom" ? Number(customSize) : undefined,
      );

      setResult(compressionResult);

      downloadPdfBytes(
        compressionResult.bytes,
        getCompressedFilename(selectedFile.name),
      );

      setSuccessMessage("PDF processed and downloaded successfully.");
    } catch (error) {
      console.error("PDF compression error:", error);

      setError(
        error instanceof Error
          ? `Compression failed: ${error.message}`
          : "Failed to compress the PDF.",
      );
    } finally {
      isProcessingRef.current = false;
      setIsProcessing(false);
    }
  };

  return (
    <div className="w-full max-w-2xl mx-auto px-4 sm:px-6">
      <div className="bg-white rounded-2xl shadow-lg border border-gray-100 overflow-hidden">
        <UploadZone
          accept=".pdf,application/pdf"
          size="spacious"
          title={
            isProcessing
              ? "Upload locked while your PDF is being compressed"
              : "Drag & Drop your PDF here"
          }
          helperText={
            isProcessing ? "Please wait for the current file to finish." : "or click to browse"
          }
          onFileSelect={handleFileSelection}
          disabled={isProcessing}
          className="mx-4 sm:mx-6 mt-6 sm:mt-8 mb-6"
          icon={
            <div
              className={`mb-4 flex h-14 w-14 sm:h-16 sm:w-16 items-center justify-center rounded-full ${
                isProcessing
                  ? "bg-gray-200 text-gray-400"
                  : "bg-blue-100 text-blue-600"
              }`}
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
                strokeWidth={1.5}
                stroke="currentColor"
                className="h-7 w-7 sm:h-8 sm:w-8"
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5m-13.5-9L12 3m0 0 4.5 4.5M12 3v13.5"
                />
              </svg>
            </div>
          }
        />

        {/* File details, validation error, or success message */}
        {(selectedFile || error || successMessage) && (
          <div className="mx-4 sm:mx-6 -mt-2 mb-4">
            {error && (
              <p role="alert" className="text-sm text-red-600 font-medium">
                {error}
              </p>
            )}

            {successMessage && (
              <p
                role="status"
                aria-live="polite"
                aria-atomic="true"
                className="text-sm text-green-600 font-medium"
              >
                {successMessage}
              </p>
            )}

            {selectedFile && (
              <div className="rounded-lg bg-gray-50 border border-gray-200 px-4 py-3">
                <p className="text-sm font-medium text-gray-800 truncate">
                  {selectedFile.name}
                </p>
                <p className="mt-1 text-sm text-gray-500">
                  {formatFileSize(selectedFile.size)}
                </p>
              </div>
            )}

            {selectedFile && isAnalyzing && (
              <p
                role="status"
                aria-live="polite"
                aria-atomic="true"
                className="mt-3 text-sm font-medium text-gray-500"
              >
                Analyzing PDF...
              </p>
            )}

            {selectedFile && analysisError && (
              <p
                role="status"
                aria-live="polite"
                aria-atomic="true"
                className="mt-3 text-sm font-medium text-amber-600"
              >
                {analysisError}
              </p>
            )}

            {selectedFile && analysis && (
              <div className="mt-3 rounded-lg border border-gray-200 bg-gray-50 px-4 py-3">
                <p className="text-sm font-medium text-gray-700">PDF Analysis</p>

                <div className="mt-3 grid grid-cols-3 gap-3">
                  <div>
                    <p className="text-xs text-gray-500">Pages</p>
                    <p className="mt-0.5 text-sm font-semibold text-gray-800">
                      {analysis.pageCount}
                    </p>
                  </div>

                  <div>
                    <p className="text-xs text-gray-500">Images found</p>
                    <p className="mt-0.5 text-sm font-semibold text-gray-800">
                      {analysis.imageCount}
                    </p>
                  </div>

                  <div>
                    <p className="text-xs text-gray-500">Compression potential</p>
                    <p className="mt-0.5 text-sm font-semibold text-gray-800">
                      {formatCompressibilityLabel(
                        analysis.estimatedCompressibility,
                      )}
                    </p>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        <div className="px-4 sm:px-6 pb-6">
          <p
            className="mb-3 text-sm font-medium text-gray-700"
            id="compression-level-label"
          >
            Compression level
          </p>

          <div
            role="radiogroup"
            aria-labelledby="compression-level-label"
            className="grid grid-cols-1 sm:grid-cols-3 gap-3"
          >
            {compressionOptions.map((option) => {
              const isSelected = compressionMode === option.id;

              return (
                <button
                  key={option.id}
                  type="button"
                  role="radio"
                  aria-checked={isSelected}
                  onClick={() => setCompressionMode(option.id)}
                  disabled={isProcessing}
                  className={`flex flex-col items-start gap-1.5 rounded-lg border px-4 py-3 text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 ${
                    isSelected
                      ? "border-blue-600 bg-blue-50 ring-2 ring-blue-600 shadow-sm"
                      : "border-gray-200 bg-white hover:border-blue-300 hover:bg-blue-50/50"
                  } ${isProcessing ? "cursor-not-allowed opacity-60" : ""}`}
                >
                  <span className="flex w-full items-center justify-between gap-2">
                    <span
                      className={`text-sm font-semibold ${
                        isSelected ? "text-blue-700" : "text-gray-800"
                      }`}
                    >
                      {option.label}
                    </span>
                    {isSelected && (
                      <svg
                        xmlns="http://www.w3.org/2000/svg"
                        viewBox="0 0 20 20"
                        fill="currentColor"
                        className="h-4 w-4 shrink-0 text-blue-600"
                        aria-hidden="true"
                      >
                        <path
                          fillRule="evenodd"
                          d="M16.704 4.153a.75.75 0 0 1 .143 1.052l-8 10.5a.75.75 0 0 1-1.127.075l-4.5-4.5a.75.75 0 0 1 1.06-1.06l3.894 3.893 7.48-9.817a.75.75 0 0 1 1.05-.143Z"
                          clipRule="evenodd"
                        />
                      </svg>
                    )}
                  </span>
                  <span className="text-xs text-gray-500">
                    {option.description}
                  </span>
                  <span className="mt-1 flex flex-col gap-0.5">
                    {option.traits.map((trait) => (
                      <span
                        key={trait.text}
                        className="flex items-center gap-1 text-[11px] leading-tight text-gray-500"
                      >
                        <span aria-hidden="true">{trait.icon}</span>
                        {trait.text}
                      </span>
                    ))}
                  </span>
                </button>
              );
            })}
          </div>

          {compressionMode === "custom" && (
            <div className="mt-4">
              <label
                htmlFor="custom-size"
                className="block text-sm font-medium text-gray-700 mb-2"
              >
                Target size (MB)
              </label>
              <input
                id="custom-size"
                type="number"
                min="0.1"
                step="0.1"
                placeholder="e.g. 5"
                value={customSize}
                onChange={(e) => setCustomSize(e.target.value)}
                disabled={isProcessing}
                aria-describedby="custom-size-help"
                aria-invalid={showCustomSizeError || undefined}
                className={`w-full rounded-lg border px-4 py-2.5 text-sm text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500/20 ${
                  showCustomSizeError
                    ? "border-red-400 focus:border-red-500"
                    : "border-gray-300 focus:border-blue-500"
                }`}
              />
              <p id="custom-size-help" className="mt-2 text-xs text-gray-500">
                DocFlow will try to reduce the PDF to this size. It&apos;s a
                target, not a guarantee — if it can&apos;t be reached, you&apos;ll
                get the smallest file DocFlow could produce instead. A smaller
                target means stronger compression, so the output may look
                noticeably lower quality.
              </p>
              {showCustomSizeError && (
                <p className="mt-1 text-xs font-medium text-red-600">
                  Enter a target size greater than 0 MB.
                </p>
              )}
            </div>
          )}

          <button
            type="button"
            onClick={handleCompressPdf}
            disabled={!canCompress}
            aria-busy={isProcessing}
            className={`mt-6 flex w-full items-center justify-center rounded-lg px-4 py-3 text-sm font-semibold transition-colors ${
              canCompress
                ? "bg-blue-600 text-white hover:bg-blue-700"
                : "bg-gray-200 text-gray-400 cursor-not-allowed"
            }`}
          >
            {isProcessing && (
              <svg
                className="mr-2 h-4 w-4 animate-spin"
                viewBox="0 0 24 24"
                fill="none"
                aria-hidden="true"
              >
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="4"
                />
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                />
              </svg>
            )}
            {isProcessing ? "Compressing PDF..." : "Compress PDF"}
          </button>

          {isProcessing && (
            <p className="mt-2 text-center text-xs text-gray-500">
              Compressing your PDF — this may take a moment. Your options are
              locked until it finishes.
            </p>
          )}
        </div>

        {result && (
          <ResultCard
            fileName={selectedFile?.name ?? "Unknown.pdf"}
            pageCount={result.pageCount}
            originalSize={result.originalSize}
            processedSize={result.processedSize}
            reduction={result.reductionPercent}
            processingTime={result.processingTime}
            mode={result.mode}
            targetSizeMb={
              result.mode === "custom" ? Number(customSize) : undefined
            }
            onDownload={() =>
              downloadPdfBytes(
                result.bytes,
                getCompressedFilename(selectedFile?.name ?? "Unknown.pdf"),
              )
            }
            onCompressAnother={handleCompressAnother}
          />
        )}
      </div>
    </div>
  );
}
