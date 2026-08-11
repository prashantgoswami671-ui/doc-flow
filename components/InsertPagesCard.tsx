"use client";

import { useRef, useState } from "react";
import { getPdfPageCount } from "../services/pdf/split";
import { parsePageSelection } from "../services/pdf/extract";
import {
  insertPages,
  validateInsertPosition,
  type InsertPagesResult,
} from "../services/pdf/insertPages";

function isPdfFile(file: File): boolean {
  return (
    file.type === "application/pdf" ||
    file.name.toLowerCase().endsWith(".pdf")
  );
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
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);

  return (
    <div>
      <p className="text-sm font-medium text-gray-700">{label}</p>

      <input
        ref={fileInputRef}
        type="file"
        accept=".pdf,application/pdf"
        className="hidden"
        onChange={(event) => {
          onSelect(event.target.files?.[0]);
          event.target.value = "";
        }}
      />

      <div
        role="button"
        tabIndex={0}
        onClick={() => !disabled && fileInputRef.current?.click()}
        onKeyDown={(event) => {
          if (disabled) return;
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            fileInputRef.current?.click();
          }
        }}
        onDragEnter={() => !disabled && setIsDragging(true)}
        onDragLeave={() => setIsDragging(false)}
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          setIsDragging(false);
          if (!disabled) onSelect(event.dataTransfer.files?.[0]);
        }}
        className={`mt-2 flex flex-col items-center justify-center rounded-xl border-2 border-dashed px-4 py-6 transition-colors cursor-pointer ${
          isDragging
            ? "border-blue-500 bg-blue-50"
            : "border-gray-300 bg-gray-50 hover:border-blue-400 hover:bg-blue-50/50"
        }`}
      >
        <p className="text-sm font-medium text-gray-800 text-center">
          {helperText}
        </p>
        <p className="mt-1 text-xs text-gray-500">or drag and drop it here</p>
      </div>

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
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [result, setResult] = useState<InsertPagesResult | null>(null);

  const resetOutput = () => {
    setResult(null);
    setSuccessMessage(null);
    setError(null);
  };

  const selectTargetFile = async (file: File | undefined) => {
    if (!file) return;

    if (!isPdfFile(file)) {
      setError("Please select a valid PDF file for the target.");
      return;
    }

    setTargetFile(file);
    setTargetPageCount(null);
    setInsertPositionInput("");
    resetOutput();
    setIsReadingTarget(true);

    try {
      const count = await getPdfPageCount(file);

      setTargetPageCount(count);
    } catch (readError) {
      console.error("Target PDF read error:", readError);
      setError(
        readError instanceof Error
          ? `Unable to read the target PDF: ${readError.message}`
          : "Unable to read the target PDF.",
      );
    } finally {
      setIsReadingTarget(false);
    }
  };

  const selectSourceFile = async (file: File | undefined) => {
    if (!file) return;

    if (!isPdfFile(file)) {
      setError("Please select a valid PDF file for the source.");
      return;
    }

    setSourceFile(file);
    setSourcePageCount(null);
    resetOutput();
    setIsReadingSource(true);

    try {
      const count = await getPdfPageCount(file);

      setSourcePageCount(count);
    } catch (readError) {
      console.error("Source PDF read error:", readError);
      setError(
        readError instanceof Error
          ? `Unable to read the source PDF: ${readError.message}`
          : "Unable to read the source PDF.",
      );
    } finally {
      setIsReadingSource(false);
    }
  };

  // Live preview: validate selection + position against known page counts,
  // without touching PDF bytes yet.
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
    setSuccessMessage(null);

    try {
      const insertResult = await insertPages(
        targetFile,
        sourceFile,
        sourcePageSelection,
        insertPosition,
      );

      setResult(insertResult);
      downloadPdfBytes(insertResult.bytes, "document-with-inserted-pages.pdf");
      setSuccessMessage(
        `Inserted ${insertResult.insertedPageCount} page${
          insertResult.insertedPageCount === 1 ? "" : "s"
        }. Final PDF has ${insertResult.finalPageCount} pages.`,
      );
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

  return (
    <div className="w-full max-w-2xl mx-auto px-4 sm:px-6">
      <div className="bg-white rounded-2xl shadow-lg border border-gray-100 overflow-hidden">
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
                <p className="mt-3 text-sm font-medium text-amber-600">
                  {previewError}
                </p>
              )}

              {!previewError &&
                selectedSourcePages &&
                selectedSourcePages.length > 0 &&
                insertPositionLabel !== null && (
                  <div className="mt-4 rounded-lg bg-gray-50 border border-gray-200 px-4 py-3 space-y-1">
                    <p className="text-sm font-medium text-gray-700">
                      Preview
                    </p>
                    <p className="text-sm text-gray-500">
                      Target: {targetFile.name} — {targetPageCount} pages
                    </p>
                    <p className="text-sm text-gray-500">
                      Source: {sourceFile.name} — {sourcePageCount} pages
                    </p>
                    <p className="text-sm text-gray-500">
                      Selected source pages:{" "}
                      {selectedSourcePages.join(", ")}
                    </p>
                    <p className="text-sm text-gray-500">
                      Insert position: {insertPositionLabel}
                    </p>
                    <p className="text-sm text-gray-500">
                      Result: {targetPageCount + selectedSourcePages.length}{" "}
                      pages
                    </p>
                  </div>
                )}
            </>
          )}

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
              {result.targetPageCount}-page target + {result.insertedPageCount}{" "}
              inserted page{result.insertedPageCount === 1 ? "" : "s"} ={" "}
              {result.finalPageCount}-page result, completed in{" "}
              {(result.processingTime / 1000).toFixed(2)}s.
            </p>
          )}

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
            {isProcessing ? "Inserting pages..." : "Insert Pages"}
          </button>
        </div>
      </div>
    </div>
  );
}
