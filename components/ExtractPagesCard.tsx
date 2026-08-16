// components/ExtractPagesCard.tsx
"use client";

import { useRef, useState } from "react";
import {
  extractPages,
  type ExtractionResult,
} from "../services/pdf/extract";
import UploadZone from "./UploadZone";

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

export default function ExtractPagesCard() {
  const isProcessingRef = useRef(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [pageSelection, setPageSelection] = useState("");
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [result, setResult] = useState<ExtractionResult | null>(null);

  const selectFile = (file: File | undefined) => {
    if (!file) return;

    if (!isPdfFile(file)) {
      setSelectedFile(null);
      setResult(null);
      setSuccessMessage(null);
      setError("Please select a valid PDF file.");
      return;
    }

    setSelectedFile(file);
    setResult(null);
    setSuccessMessage(null);
    setError(null);
  };

  const handleExtract = async () => {
    if (isProcessingRef.current || !selectedFile) return;

    isProcessingRef.current = true;
    setIsProcessing(true);
    setError(null);
    setSuccessMessage(null);

    try {
      const extractionResult = await extractPages(selectedFile, pageSelection);

      setResult(extractionResult);
      downloadPdfBytes(
        extractionResult.bytes,
        getExtractedFilename(selectedFile.name),
      );
      setSuccessMessage(
        `Extracted ${extractionResult.extractedPageCount} page${
          extractionResult.extractedPageCount === 1 ? "" : "s"
        } successfully.`,
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

  const canExtract =
    selectedFile !== null && pageSelection.trim() !== "" && !isProcessing;

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
          onFileSelect={selectFile}
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

          <label
            htmlFor="extract-page-selection"
            className="mt-4 block text-sm font-medium text-gray-700"
          >
            Pages to extract
          </label>
          <input
            id="extract-page-selection"
            type="text"
            value={pageSelection}
            onChange={(event) => setPageSelection(event.target.value)}
            disabled={isProcessing}
            placeholder="e.g. 1-3, 5, 8-10"
            className="mt-2 w-full rounded-lg border border-gray-300 px-4 py-2.5 text-sm text-gray-900 placeholder:text-gray-400 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
          />
          <p className="mt-2 text-xs text-gray-500">
            Enter individual pages or ranges, separated by commas.
          </p>

          {error && (
            <p className="mt-4 text-sm font-medium text-red-600">{error}</p>
          )}
          {successMessage && (
            <p className="mt-4 text-sm font-medium text-green-600">
              {successMessage}
            </p>
          )}
          {result && (
            <p className="mt-2 text-sm text-gray-500">
              {result.sourcePageCount}-page source · {result.extractedPageCount}
              -page PDF created in {(result.processingTime / 1000).toFixed(2)}s.
            </p>
          )}

          <button
            type="button"
            onClick={handleExtract}
            disabled={!canExtract}
            className={`mt-6 w-full rounded-lg px-4 py-3 text-sm font-semibold transition-colors ${
              canExtract
                ? "bg-blue-600 text-white hover:bg-blue-700"
                : "bg-gray-200 text-gray-400 cursor-not-allowed"
            }`}
          >
            {isProcessing ? "Extracting pages..." : "Extract Pages"}
          </button>
        </div>
      </div>
    </div>
  );
}
