"use client";

import { useRef, useState } from "react";
import {
  buildRanges,
  getPdfPageCount,
  parseSplitPoints,
  splitPdf,
  type SplitPart,
  type SplitRange,
} from "../services/pdf/split";
import { formatFileSize } from "./ResultCard";

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

function getPartFilename(originalName: string, partNumber: number): string {
  const base = originalName.toLowerCase().endsWith(".pdf")
    ? originalName.slice(0, -4)
    : originalName;

  return `${base}-part-${partNumber}.pdf`;
}

let nextSplitPointId = 0;

interface SplitPointField {
  id: string;
  value: string;
}

function createField(value = ""): SplitPointField {
  return { id: `${nextSplitPointId++}`, value };
}

export default function SplitPdfCard() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const isProcessingRef = useRef(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [pageCount, setPageCount] = useState<number | null>(null);
  const [isReadingFile, setIsReadingFile] = useState(false);
  const [splitPointFields, setSplitPointFields] = useState<SplitPointField[]>([
    createField(),
  ]);
  const [isDragging, setIsDragging] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [parts, setParts] = useState<SplitPart[]>([]);
  const [processingTime, setProcessingTime] = useState<number | null>(null);

  // While splitting, the file and split points must stay frozen so the
  // output can't change out from under an in-flight request.
  const uploadDisabled = isProcessing;

  const resetOutput = () => {
    setParts([]);
    setProcessingTime(null);
    setError(null);
  };

  const selectFile = async (file: File | undefined) => {
    if (uploadDisabled || !file) return;

    if (!isPdfFile(file)) {
      setSelectedFile(null);
      setPageCount(null);
      setParts([]);
      setProcessingTime(null);
      setError("Please select a valid PDF file.");
      return;
    }

    setSelectedFile(file);
    setPageCount(null);
    setParts([]);
    setProcessingTime(null);
    setError(null);
    setSplitPointFields([createField()]);
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

  const updateField = (id: string, value: string) => {
    resetOutput();
    setSplitPointFields((current) =>
      current.map((field) => (field.id === id ? { ...field, value } : field)),
    );
  };

  const addField = () => {
    resetOutput();
    setSplitPointFields((current) => [...current, createField()]);
  };

  const removeField = (id: string) => {
    resetOutput();
    setSplitPointFields((current) =>
      current.length === 1
        ? current
        : current.filter((field) => field.id !== id),
    );
  };

  const rawSplitInput = splitPointFields
    .map((field) => field.value.trim())
    .filter((value) => value !== "")
    .join(",");

  // Live preview: validate the split points against the known page count and
  // show the resulting parts before anything is processed.
  let previewPoints: number[] | null = null;
  let previewRanges: SplitRange[] | null = null;
  let previewError: string | null = null;

  if (pageCount !== null && rawSplitInput !== "") {
    try {
      const points = parseSplitPoints(rawSplitInput, pageCount);

      previewPoints = points;
      previewRanges = buildRanges(points, pageCount);
    } catch (parseError) {
      previewError =
        parseError instanceof Error
          ? parseError.message
          : "Invalid split points.";
    }
  }

  const handleSplit = async () => {
    if (isProcessingRef.current || !selectedFile || pageCount === null) return;
    if (!previewRanges || previewError) return;

    isProcessingRef.current = true;
    setIsProcessing(true);
    setError(null);

    try {
      const points = parseSplitPoints(rawSplitInput, pageCount);
      const splitResult = await splitPdf(selectedFile, points);

      setParts(splitResult.parts);
      setProcessingTime(splitResult.processingTime);
    } catch (splitError) {
      console.error("PDF split error:", splitError);
      setError(
        splitError instanceof Error
          ? `Split failed: ${splitError.message}`
          : "Failed to split this PDF.",
      );
    } finally {
      isProcessingRef.current = false;
      setIsProcessing(false);
    }
  };

  const handleDownloadAll = () => {
    if (!selectedFile) return;

    parts.forEach((part, index) => {
      setTimeout(() => {
        downloadPdfBytes(
          part.bytes,
          getPartFilename(selectedFile.name, part.range.partNumber),
        );
      }, index * 300);
    });
  };

  /** Clears the current file/split points/result so the user can split a different PDF. */
  const handleSplitAnother = () => {
    setSelectedFile(null);
    setPageCount(null);
    setSplitPointFields([createField()]);
    setParts([]);
    setProcessingTime(null);
    setError(null);

    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  const canSplit =
    selectedFile !== null &&
    pageCount !== null &&
    previewRanges !== null &&
    previewError === null &&
    !isProcessing &&
    !isReadingFile;

  const totalOutputSize = parts.reduce(
    (sum, part) => sum + part.bytes.length,
    0,
  );

  return (
    <div className="w-full max-w-2xl mx-auto px-4 sm:px-6">
      <div className="bg-white rounded-2xl shadow-lg border border-gray-100 overflow-hidden">
        <div className="px-4 sm:px-6 pt-6 sm:pt-8">
          <h2 className="text-xl font-bold text-gray-900">Split PDF</h2>
          <p className="mt-1 text-sm text-gray-500">
            Divide one PDF into multiple PDFs at the page numbers you choose.
          </p>
        </div>

        <input
          ref={fileInputRef}
          type="file"
          accept=".pdf,application/pdf"
          className="hidden"
          onChange={(event) => {
            void selectFile(event.target.files?.[0]);
            event.target.value = "";
          }}
        />

        <div
          role="button"
          tabIndex={0}
          aria-disabled={uploadDisabled || undefined}
          onClick={() => {
            if (!uploadDisabled) fileInputRef.current?.click();
          }}
          onKeyDown={(event) => {
            if (uploadDisabled) return;
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              fileInputRef.current?.click();
            }
          }}
          onDragEnter={() => {
            if (!uploadDisabled) setIsDragging(true);
          }}
          onDragLeave={() => setIsDragging(false)}
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault();
            setIsDragging(false);
            if (uploadDisabled) return;
            void selectFile(event.dataTransfer.files?.[0]);
          }}
          className={`mx-4 sm:mx-6 mt-6 mb-4 flex flex-col items-center justify-center rounded-xl border-2 border-dashed px-6 py-10 transition-colors ${
            uploadDisabled
              ? "cursor-not-allowed border-gray-200 bg-gray-50 opacity-60"
              : isDragging
                ? "cursor-pointer border-blue-500 bg-blue-50"
                : "cursor-pointer border-gray-300 bg-gray-50 hover:border-blue-400 hover:bg-blue-50/50"
          }`}
        >
          <p className="text-base font-medium text-gray-800 text-center">
            Choose a PDF to split
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
              <p className="mt-4 block text-sm font-medium text-gray-700">
                Split points
              </p>
              <p className="mt-1 text-xs text-gray-500">
                Each point is the last page of a part. E.g. 20, 50, 75 splits a
                100-page PDF into four parts. This PDF has {pageCount} page
                {pageCount === 1 ? "" : "s"}.
              </p>

              <div className="mt-3 flex flex-wrap gap-2">
                {splitPointFields.map((field, index) => (
                  <div key={field.id} className="flex items-center gap-1">
                    <input
                      type="text"
                      inputMode="numeric"
                      value={field.value}
                      onChange={(event) =>
                        updateField(field.id, event.target.value)
                      }
                      disabled={isProcessing}
                      aria-label={`Split point ${index + 1}`}
                      aria-invalid={previewError ? true : undefined}
                      placeholder="e.g. 20"
                      className="w-24 rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                    />
                    <button
                      type="button"
                      aria-label={`Remove split point ${index + 1}`}
                      title="Remove split point"
                      onClick={() => removeField(field.id)}
                      disabled={splitPointFields.length === 1 || isProcessing}
                      className="rounded px-2 py-1.5 text-xs text-red-500 hover:bg-red-50 disabled:text-gray-300"
                    >
                      ✕
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={addField}
                  disabled={isProcessing}
                  className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-medium text-blue-600 transition-colors hover:border-blue-300 hover:bg-blue-50 disabled:cursor-not-allowed disabled:text-gray-400"
                >
                  + Add split point
                </button>
              </div>

              {previewError && (
                <p
                  role="alert"
                  className="mt-3 text-sm font-medium text-amber-600"
                >
                  {previewError}
                </p>
              )}

              {previewRanges && previewPoints && (
                <div className="mt-4 space-y-1.5">
                  <p className="text-sm font-medium text-gray-700">
                    {previewPoints.length === 0
                      ? "No split points yet — the whole PDF is one part."
                      : `Splitting after page${previewPoints.length === 1 ? "" : "s"} ${previewPoints.join(", ")}`}
                    {" · "}
                    {previewRanges.length} PDF
                    {previewRanges.length === 1 ? "" : "s"} will be created
                  </p>
                  {previewRanges.map((range) => (
                    <p
                      key={range.partNumber}
                      className="text-sm text-gray-500"
                    >
                      Part {range.partNumber}: pages {range.startPage}–
                      {range.endPage} ({range.pageCount} page
                      {range.pageCount === 1 ? "" : "s"})
                    </p>
                  ))}
                </div>
              )}
            </>
          )}

          <button
            type="button"
            onClick={handleSplit}
            disabled={!canSplit}
            aria-busy={isProcessing}
            className={`mt-6 flex w-full items-center justify-center rounded-lg px-4 py-3 text-sm font-semibold transition-colors ${
              canSplit
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
            {isProcessing ? "Splitting PDF..." : "Split PDF"}
          </button>

          {isProcessing && (
            <p className="mt-2 text-center text-xs text-gray-500">
              Splitting your PDF — this should only take a moment.
            </p>
          )}
        </div>

        {parts.length > 0 && selectedFile && (
          <div className="border-t border-gray-100 bg-gray-50 px-4 sm:px-6 py-6">
            <div className="mb-4 flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-green-100 text-xl">
                ✓
              </div>
              <div>
                <p className="text-base font-semibold text-gray-900">
                  Your split PDFs are ready
                </p>
                <p className="text-sm text-gray-500">
                  {parts.length} PDF{parts.length === 1 ? "" : "s"} created
                  {processingTime !== null
                    ? ` · ${(processingTime / 1000).toFixed(2)}s`
                    : ""}
                  {" · "}
                  {formatFileSize(totalOutputSize)} total
                </p>
              </div>
            </div>

            <div className="space-y-2">
              {parts.map((part) => (
                <div
                  key={part.range.partNumber}
                  className="flex items-center justify-between gap-3 rounded-lg border border-gray-200 bg-white px-4 py-3"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-gray-800">
                      {getPartFilename(
                        selectedFile.name,
                        part.range.partNumber,
                      )}
                    </p>
                    <p className="text-xs text-gray-500">
                      Pages {part.range.startPage}–{part.range.endPage} (
                      {part.range.pageCount} page
                      {part.range.pageCount === 1 ? "" : "s"}) ·{" "}
                      {formatFileSize(part.bytes.length)}
                    </p>
                  </div>
                  <button
                    type="button"
                    aria-label={`Download part ${part.range.partNumber}`}
                    onClick={() =>
                      downloadPdfBytes(
                        part.bytes,
                        getPartFilename(
                          selectedFile.name,
                          part.range.partNumber,
                        ),
                      )
                    }
                    className="flex-none rounded-lg bg-blue-600 px-3 py-2 text-xs font-semibold text-white transition-colors hover:bg-blue-700"
                  >
                    Download
                  </button>
                </div>
              ))}
            </div>

            {parts.length > 1 && (
              <button
                type="button"
                onClick={handleDownloadAll}
                className="mt-3 w-full rounded-xl bg-blue-600 py-3 text-base font-semibold text-white transition hover:bg-blue-700"
              >
                Download all {parts.length} PDFs
              </button>
            )}

            <button
              type="button"
              onClick={handleSplitAnother}
              className="mt-3 w-full rounded-xl border border-gray-300 bg-white py-3 text-base font-semibold text-gray-700 transition hover:bg-gray-50"
            >
              Split another PDF
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
