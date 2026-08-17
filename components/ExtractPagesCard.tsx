// components/ExtractPagesCard.tsx
"use client";

import { useRef, useState } from "react";
import {
  extractPages,
  parsePageSelection,
  type ExtractionResult,
} from "../services/pdf/extract";
import { getPdfPageCount } from "../services/pdf/split";
import UploadZone from "./UploadZone";
import ResultPanel from "./ResultPanel";
import { formatFileSize } from "./ResultCard";

function isPdfFile(file: File): boolean {
  return (
    file.type === "application/pdf" ||
    file.name.toLowerCase().endsWith(".pdf")
  );
}

function getExtractedFilename(originalName: string): string {
  if (originalName.toLowerCase().endsWith(".pdf")) {
    return `${originalName.slice(0, -4)}-extracted.pdf`;
  }

  return `${originalName}-extracted.pdf`;
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

/** Above this count, listing every selected page number gets noisy — show the count only. */
const MAX_LISTED_PAGE_NUMBERS = 20;

export default function ExtractPagesCard() {
  const isProcessingRef = useRef(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [pageCount, setPageCount] = useState<number | null>(null);
  const [isReadingFile, setIsReadingFile] = useState(false);
  const [pageSelection, setPageSelection] = useState("");
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ExtractionResult | null>(null);

  const selectFile = async (file: File | undefined) => {
    if (!file) return;

    if (!isPdfFile(file)) {
      setSelectedFile(null);
      setPageCount(null);
      setResult(null);
      setError("Please select a valid PDF file.");
      return;
    }

    setSelectedFile(file);
    setPageCount(null);
    setResult(null);
    setError(null);
    setPageSelection("");
    setIsReadingFile(true);

    try {
      const count = await getPdfPageCount(file);

      setPageCount(count);
    } catch (readError) {
      console.error("PDF read error:", readError);
      setError(
        readError instanceof Error
          ? `Unable to read this PDF: ${readError.message}`
          : "Unable to read this PDF.",
      );
    } finally {
      setIsReadingFile(false);
    }
  };

  // Live preview: validate the typed selection against the known page count
  // without touching PDF bytes yet, the same pattern Split PDF and Insert
  // Pages already use for their own live previews.
  let previewPageNumbers: number[] | null = null;
  let previewError: string | null = null;

  if (pageCount !== null && pageSelection.trim() !== "") {
    try {
      previewPageNumbers = parsePageSelection(pageSelection, pageCount);
    } catch (parseError) {
      previewError =
        parseError instanceof Error
          ? parseError.message
          : "Invalid page selection.";
    }
  }

  const handleExtract = async () => {
    if (isProcessingRef.current || !selectedFile || pageCount === null) return;
    if (!previewPageNumbers || previewError) return;

    isProcessingRef.current = true;
    setIsProcessing(true);
    setError(null);

    try {
      const extractionResult = await extractPages(selectedFile, pageSelection);

      setResult(extractionResult);
      downloadPdfBytes(
        extractionResult.bytes,
        getExtractedFilename(selectedFile.name),
      );
    } catch (extractionError) {
      console.error("PDF extraction error:", extractionError);
      setError(
        extractionError instanceof Error
          ? `Extraction failed: ${extractionError.message}`
          : "Failed to extract pages from this PDF.",
      );
    } finally {
      isProcessingRef.current = false;
      setIsProcessing(false);
    }
  };

  /** Clears the current file/selection/result so the user can extract from a different PDF. */
  const handleExtractAnother = () => {
    setSelectedFile(null);
    setPageCount(null);
    setPageSelection("");
    setError(null);
    setResult(null);
  };

  const canExtract =
    selectedFile !== null &&
    pageCount !== null &&
    previewPageNumbers !== null &&
    previewError === null &&
    !isProcessing &&
    !isReadingFile;

  return (
    <div className="w-full max-w-2xl mx-auto px-4 sm:px-6">
      <div className="bg-white rounded-2xl shadow-lg border border-gray-100 overflow-hidden">
        <div className="px-4 sm:px-6 pt-6 sm:pt-8">
          <h2 className="text-xl font-bold text-gray-900">Extract Pages</h2>
          <p className="mt-1 text-sm text-gray-500">
            Create a new PDF from the pages you choose.
          </p>
        </div>

        <UploadZone
          accept=".pdf,application/pdf"
          title="Choose a PDF to extract pages from"
          helperText="or drag and drop it here"
          onFileSelect={(file) => void selectFile(file)}
          disabled={isProcessing}
          className="mx-4 sm:mx-6 mt-6 mb-4"
        />

        <div className="px-4 sm:px-6 pb-6">
          {selectedFile && (
            <div className="rounded-lg bg-gray-50 border border-gray-200 px-4 py-3">
              <p className="text-sm font-medium text-gray-800 truncate">
                {selectedFile.name}
              </p>
              <p className="mt-1 text-sm text-gray-500">
                {isReadingFile
                  ? "Reading PDF..."
                  : pageCount !== null
                    ? `${pageCount} page${pageCount === 1 ? "" : "s"} · ${formatFileSize(selectedFile.size)}`
                    : formatFileSize(selectedFile.size)}
              </p>
            </div>
          )}

          {error && (
            <p role="alert" className="mt-4 text-sm font-medium text-red-600">
              {error}
            </p>
          )}

          {selectedFile && pageCount !== null && (
            <>
              <label
                htmlFor="extract-page-selection"
                className="mt-4 block text-sm font-medium text-gray-700"
              >
                Pages to extract
              </label>
              <input
                id="extract-page-selection"
                type="text"
                inputMode="numeric"
                value={pageSelection}
                onChange={(event) => {
                  setPageSelection(event.target.value);
                  setResult(null);
                }}
                disabled={isProcessing}
                placeholder="e.g. 1-3, 5, 8-10"
                aria-describedby="extract-page-selection-help"
                aria-invalid={previewError ? true : undefined}
                className="mt-2 w-full rounded-lg border border-gray-300 px-4 py-2.5 text-sm text-gray-900 placeholder:text-gray-400 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
              />
              <p
                id="extract-page-selection-help"
                className="mt-2 text-xs text-gray-500"
              >
                Enter individual pages or ranges, separated by commas. This
                PDF has {pageCount} page{pageCount === 1 ? "" : "s"}.
              </p>

              {previewError && (
                <p
                  role="alert"
                  className="mt-2 text-sm font-medium text-amber-600"
                >
                  {previewError}
                </p>
              )}

              {previewPageNumbers && (
                <p className="mt-2 text-sm font-medium text-gray-700">
                  {previewPageNumbers.length} page
                  {previewPageNumbers.length === 1 ? "" : "s"} selected
                  {previewPageNumbers.length <= MAX_LISTED_PAGE_NUMBERS
                    ? ` — ${previewPageNumbers.join(", ")}`
                    : ""}
                </p>
              )}
            </>
          )}

          <button
            type="button"
            onClick={handleExtract}
            disabled={!canExtract}
            aria-busy={isProcessing}
            className={`mt-6 flex w-full items-center justify-center rounded-lg px-4 py-3 text-sm font-semibold transition-colors ${
              canExtract
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
            {isProcessing ? "Extracting pages..." : "Extract Pages"}
          </button>

          {isProcessing && (
            <p className="mt-2 text-center text-xs text-gray-500">
              Extracting your pages — this should only take a moment.
            </p>
          )}
        </div>

        {result && selectedFile && (
          <ResultPanel
            icon="✓"
            title="Your extracted PDF is ready"
            message={`${result.extractedPageCount} of ${result.sourcePageCount} pages extracted · ${(result.processingTime / 1000).toFixed(2)}s`}
            stats={[
              {
                label: "Output file",
                value: getExtractedFilename(selectedFile.name),
              },
              { label: "Pages extracted", value: result.extractedPageCount },
              { label: "Source pages", value: result.sourcePageCount },
              { label: "File size", value: formatFileSize(result.bytes.length) },
            ]}
            onDownload={() =>
              downloadPdfBytes(
                result.bytes,
                getExtractedFilename(selectedFile.name),
              )
            }
            downloadLabel="Download Extracted PDF"
            onReset={handleExtractAnother}
            resetLabel="Extract another PDF"
          />
        )}
      </div>
    </div>
  );
}
