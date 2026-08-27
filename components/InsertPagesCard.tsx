"use client";

import { useRef, useState } from "react";
import { getPdfPageCount } from "../services/pdf/split";
import { parsePageSelection } from "../services/pdf/extract";
import {
  insertPages,
  validateInsertPosition,
  type InsertPagesResult,
} from "../services/pdf/insertPages";
import ResultPanel from "./ResultPanel";
import UploadZone from "./UploadZone";

function isPdfFile(file: File): boolean {
  return (
    file.type === "application/pdf" ||
    file.name.toLowerCase().endsWith(".pdf")
  );
}

function getInsertedFilename(originalName: string): string {
  if (originalName.toLowerCase().endsWith(".pdf")) {
    return `${originalName.slice(0, -4)}-inserted.pdf`;
  }

  return `${originalName}-inserted.pdf`;
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

interface PdfPickerProps {
  label: string;
  helperText: string;
  file: File | null;
  pageCount: number | null;
  isReading: boolean;
  disabled: boolean;
  onSelect: (file: File | undefined) => void;
}

function PdfPicker({
  label,
  helperText,
  file,
  pageCount,
  isReading,
  disabled,
  onSelect,
}: PdfPickerProps) {
  return (
    <div>
      <p className="text-sm font-medium text-gray-700">{label}</p>

      <UploadZone
        accept=".pdf,application/pdf"
        title={helperText}
        helperText="or drag and drop it here"
        onFileSelect={onSelect}
        disabled={disabled}
        className="mt-2 px-4 py-6"
      />

      {file && (
        <div className="mt-2 rounded-lg bg-gray-50 border border-gray-200 px-3 py-2">
          <p className="truncate text-sm font-medium text-gray-800">
            {file.name}
          </p>
          <p className="text-xs text-gray-500">
            {isReading
              ? "Reading PDF..."
              : pageCount !== null
                ? `${pageCount} page${pageCount === 1 ? "" : "s"}`
                : ""}
          </p>
        </div>
      )}
    </div>
  );
}

export default function InsertPagesCard() {
  const isProcessingRef = useRef(false);
  const targetPageCountRequestIdRef = useRef(0);
  const sourcePageCountRequestIdRef = useRef(0);

  const [targetFile, setTargetFile] = useState<File | null>(null);
  const [targetPageCount, setTargetPageCount] = useState<number | null>(null);
  const [isReadingTarget, setIsReadingTarget] = useState(false);

  const [sourceFile, setSourceFile] = useState<File | null>(null);
  const [sourcePageCount, setSourcePageCount] = useState<number | null>(null);
  const [isReadingSource, setIsReadingSource] = useState(false);

  const [sourcePageSelection, setSourcePageSelection] = useState("");
  const [insertPositionInput, setInsertPositionInput] = useState("");

  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<InsertPagesResult | null>(null);

  const resetOutput = () => {
    setResult(null);
    setError(null);
  };

  const resetAll = () => {
    targetPageCountRequestIdRef.current += 1;
    sourcePageCountRequestIdRef.current += 1;
    setTargetFile(null);
    setTargetPageCount(null);
    setSourceFile(null);
    setSourcePageCount(null);
    setSourcePageSelection("");
    setInsertPositionInput("");
    setIsReadingTarget(false);
    setIsReadingSource(false);
    setResult(null);
    setError(null);
  };

  const selectTargetFile = async (file: File | undefined) => {
    if (!file) return;

    if (!isPdfFile(file)) {
      targetPageCountRequestIdRef.current += 1;
      setError("Please select a valid PDF file for the target.");
      return;
    }

    const requestId = ++targetPageCountRequestIdRef.current;

    setTargetFile(file);
    setTargetPageCount(null);
    setInsertPositionInput("");
    resetOutput();
    setIsReadingTarget(true);

    try {
      const count = await getPdfPageCount(file);

      // A newer target file may have been selected while this read was in
      // flight — never let a stale count overwrite state belonging to that
      // newer file.
      if (requestId !== targetPageCountRequestIdRef.current) return;

      setTargetPageCount(count);
    } catch (readError) {
      console.error("Target PDF read error:", readError);

      if (requestId !== targetPageCountRequestIdRef.current) return;

      setError(
        readError instanceof Error
          ? `Unable to read the target PDF: ${readError.message}`
          : "Unable to read the target PDF.",
      );
    } finally {
      if (requestId === targetPageCountRequestIdRef.current) {
        setIsReadingTarget(false);
      }
    }
  };

  const selectSourceFile = async (file: File | undefined) => {
    if (!file) return;

    if (!isPdfFile(file)) {
      sourcePageCountRequestIdRef.current += 1;
      setError("Please select a valid PDF file for the source.");
      return;
    }

    const requestId = ++sourcePageCountRequestIdRef.current;

    setSourceFile(file);
    setSourcePageCount(null);
    resetOutput();
    setIsReadingSource(true);

    try {
      const count = await getPdfPageCount(file);

      // A newer source file may have been selected while this read was in
      // flight — never let a stale count overwrite state belonging to that
      // newer file.
      if (requestId !== sourcePageCountRequestIdRef.current) return;

      setSourcePageCount(count);
    } catch (readError) {
      console.error("Source PDF read error:", readError);

      if (requestId !== sourcePageCountRequestIdRef.current) return;

      setError(
        readError instanceof Error
          ? `Unable to read the source PDF: ${readError.message}`
          : "Unable to read the source PDF.",
      );
    } finally {
      if (requestId === sourcePageCountRequestIdRef.current) {
        setIsReadingSource(false);
      }
    }
  };

  let selectedSourcePages: number[] | null = null;
  let previewError: string | null = null;
  let insertPosition: number | null = null;

  if (sourcePageCount !== null && sourcePageSelection.trim() !== "") {
    try {
      selectedSourcePages = parsePageSelection(
        sourcePageSelection,
        sourcePageCount,
      );
    } catch (parseError) {
      previewError =
        parseError instanceof Error
          ? parseError.message
          : "Invalid page selection.";
    }
  }

  if (!previewError && targetPageCount !== null && insertPositionInput.trim() !== "") {
    const trimmedPosition = insertPositionInput.trim();

    if (!/^\d+$/.test(trimmedPosition)) {
      previewError = "Insert position must be a whole number.";
    } else {
      const parsedPosition = Number(trimmedPosition);

      try {
        validateInsertPosition(parsedPosition, targetPageCount);
        insertPosition = parsedPosition;
      } catch (positionError) {
        previewError =
          positionError instanceof Error
            ? positionError.message
            : "Invalid insert position.";
      }
    }
  }

  const insertPositionLabel =
    insertPosition === null
      ? null
      : insertPosition === 0
        ? "Beginning"
        : insertPosition === targetPageCount
          ? "End (after last page)"
          : `After page ${insertPosition}`;

  const canProcess =
    targetFile !== null &&
    sourceFile !== null &&
    targetPageCount !== null &&
    sourcePageCount !== null &&
    selectedSourcePages !== null &&
    selectedSourcePages.length > 0 &&
    insertPosition !== null &&
    previewError === null &&
    !isProcessing &&
    !isReadingTarget &&
    !isReadingSource;

  const handleInsert = async () => {
    if (isProcessingRef.current || !canProcess || !targetFile || !sourceFile) {
      return;
    }
    if (insertPosition === null) return;

    isProcessingRef.current = true;
    setIsProcessing(true);
    setError(null);

    try {
      const insertResult = await insertPages(
        targetFile,
        sourceFile,
        sourcePageSelection,
        insertPosition,
      );

      setResult(insertResult);
      downloadPdfBytes(insertResult.bytes, getInsertedFilename(targetFile.name));
    } catch (insertError) {
      console.error("PDF insert error:", insertError);
      setError(
        insertError instanceof Error
          ? `Insert failed: ${insertError.message}`
          : "Failed to insert pages.",
      );
    } finally {
      isProcessingRef.current = false;
      setIsProcessing(false);
    }
  };

  const handleDownloadResult = () => {
    if (!result || !targetFile) return;
    downloadPdfBytes(result.bytes, getInsertedFilename(targetFile.name));
  };

  return (
    <div className="w-full max-w-2xl mx-auto px-4 sm:px-6">
      <div
        className="bg-white rounded-2xl shadow-lg border border-gray-100 overflow-hidden"
        aria-busy={isProcessing}
      >
        <div className="px-4 sm:px-6 pt-6 sm:pt-8">
          <h2 className="text-xl font-bold text-gray-900">Insert Pages</h2>
          <p className="mt-1 text-sm text-gray-500">
            Copy pages from one PDF into another at a chosen position.
          </p>
        </div>

        <div className="px-4 sm:px-6 mt-6 grid grid-cols-1 sm:grid-cols-2 gap-4">
          <PdfPicker
            label="Target PDF"
            helperText="Choose the PDF to insert into"
            file={targetFile}
            pageCount={targetPageCount}
            isReading={isReadingTarget}
            disabled={isProcessing}
            onSelect={(file) => void selectTargetFile(file)}
          />
          <PdfPicker
            label="Source PDF"
            helperText="Choose the PDF to copy pages from"
            file={sourceFile}
            pageCount={sourcePageCount}
            isReading={isReadingSource}
            disabled={isProcessing}
            onSelect={(file) => void selectSourceFile(file)}
          />
        </div>

        <div className="px-4 sm:px-6 pb-6">
          {targetFile && sourceFile && targetPageCount !== null && sourcePageCount !== null && (
            <>
              <label
                htmlFor="insert-source-page-selection"
                className="mt-6 block text-sm font-medium text-gray-700"
              >
                Source pages to insert
              </label>
              <input
                id="insert-source-page-selection"
                type="text"
                value={sourcePageSelection}
                onChange={(event) => {
                  resetOutput();
                  setSourcePageSelection(event.target.value);
                }}
                disabled={isProcessing}
                placeholder="e.g. 2,4,7 or 2-5"
                className="mt-2 w-full rounded-lg border border-gray-300 px-4 py-2.5 text-sm text-gray-900 placeholder:text-gray-400 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
              />
              <p className="mt-2 text-xs text-gray-500">
                Enter individual pages or ranges from the {sourcePageCount}-page
                source, separated by commas.
              </p>

              <label
                htmlFor="insert-position"
                className="mt-4 block text-sm font-medium text-gray-700"
              >
                Insert after target page
              </label>
              <input
                id="insert-position"
                type="text"
                inputMode="numeric"
                value={insertPositionInput}
                onChange={(event) => {
                  resetOutput();
                  setInsertPositionInput(event.target.value);
                }}
                disabled={isProcessing}
                placeholder={`0 to ${targetPageCount} (0 = beginning, ${targetPageCount} = end)`}
                className="mt-2 w-full rounded-lg border border-gray-300 px-4 py-2.5 text-sm text-gray-900 placeholder:text-gray-400 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
              />
              <p className="mt-2 text-xs text-gray-500">
                0 inserts at the beginning, {targetPageCount} inserts at the
                end, of this {targetPageCount}-page target.
              </p>

              {previewError && (
                <p className="mt-3 text-sm font-medium text-amber-600" role="alert">
                  {previewError}
                </p>
              )}

              {!previewError &&
                selectedSourcePages &&
                selectedSourcePages.length > 0 &&
                insertPositionLabel !== null && (
                  <div className="mt-4 rounded-lg bg-gray-50 border border-gray-200 px-4 py-3 space-y-1">
                    <p className="text-sm font-medium text-gray-700">Preview</p>
                    <p className="text-sm text-gray-500">
                      Target: {targetFile.name} — {targetPageCount} pages
                    </p>
                    <p className="text-sm text-gray-500">
                      Source: {sourceFile.name} — {sourcePageCount} pages
                    </p>
                    <p className="text-sm text-gray-500">
                      Selected source pages: {selectedSourcePages.join(", ")}
                    </p>
                    <p className="text-sm text-gray-500">
                      Insert position: {insertPositionLabel}
                    </p>
                    <p className="text-sm text-gray-500">
                      Result: {targetPageCount + selectedSourcePages.length} pages
                    </p>
                  </div>
                )}
            </>
          )}

          {error && (
            <p className="mt-4 text-sm font-medium text-red-600" role="alert">
              {error}
            </p>
          )}

          {result && (
            <ResultPanel
              icon="✓"
              title="Your PDF is ready"
              message="Pages inserted successfully"
              stats={[
                { label: "Inserted pages", value: result.insertedPageCount },
                { label: "Final pages", value: result.finalPageCount },
                {
                  label: "Processing time",
                  value: `${(result.processingTime / 1000).toFixed(2)}s`,
                },
                {
                  label: "Output size",
                  value: `${(result.bytes.byteLength / 1024).toFixed(1)} KB`,
                },
              ]}
              onDownload={handleDownloadResult}
              downloadLabel="Download PDF"
              onReset={resetAll}
              resetLabel="Insert pages into another PDF"
            >
              <div className="mb-4 rounded-lg border border-gray-200 bg-white px-4 py-3 space-y-1">
                <p className="text-sm font-medium text-gray-700">Operation details</p>
                <p className="text-sm text-gray-500">
                  Target: {result.targetPageCount} pages
                </p>
                <p className="text-sm text-gray-500">
                  Insert position: {insertPositionLabel ?? result.insertPosition}
                </p>
                <p className="text-sm text-gray-500">
                  Source pages inserted: {result.selectedSourcePageNumbers.join(", ")}
                </p>
              </div>
            </ResultPanel>
          )}

          {!result && (
            <button
              type="button"
              onClick={handleInsert}
              disabled={!canProcess}
              className={`mt-6 w-full rounded-lg px-4 py-3 text-sm font-semibold transition-colors ${
                canProcess
                  ? "bg-blue-600 text-white hover:bg-blue-700"
                  : "bg-gray-200 text-gray-400 cursor-not-allowed"
              }`}
            >
              {isProcessing ? (
                <span className="inline-flex items-center justify-center gap-2">
                  <span
                    className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent"
                    aria-hidden="true"
                  />
                  Inserting pages...
                </span>
              ) : (
                "Insert Pages"
              )}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
