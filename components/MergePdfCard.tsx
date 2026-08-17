"use client";

import { useRef, useState } from "react";
import { mergePdfs, type MergeResult } from "../services/pdf/merge";
import ResultPanel from "./ResultPanel";
import { formatFileSize } from "./ResultCard";

interface QueuedFile {
  id: string;
  file: File;
}

/** Filename used for the downloaded merged PDF, shared between the merge action and the result card. */
const MERGED_FILENAME = "merged.pdf";

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

function moveItem<T>(items: T[], fromIndex: number, toIndex: number): T[] {
  if (
    fromIndex === toIndex ||
    fromIndex < 0 ||
    toIndex < 0 ||
    fromIndex >= items.length ||
    toIndex >= items.length
  ) {
    return items;
  }

  const reordered = [...items];
  const [moved] = reordered.splice(fromIndex, 1);

  reordered.splice(toIndex, 0, moved);

  return reordered;
}

let nextQueuedFileId = 0;

export default function MergePdfCard() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const isProcessingRef = useRef(false);
  const [queuedFiles, setQueuedFiles] = useState<QueuedFile[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<MergeResult | null>(null);

  // While merging, the queue must stay frozen so the output can't change
  // out from under an in-flight request.
  const uploadDisabled = isProcessing;

  const addFiles = (fileList: FileList | File[] | null | undefined) => {
    if (uploadDisabled || !fileList) return;

    const incoming = Array.from(fileList);
    const invalid = incoming.find((file) => !isPdfFile(file));

    if (invalid) {
      setError("Please select valid PDF files only.");
      return;
    }

    setResult(null);
    setError(null);
    setQueuedFiles((current) => [
      ...current,
      ...incoming.map((file) => ({ id: `${nextQueuedFileId++}`, file })),
    ]);
  };

  const removeFile = (id: string) => {
    setQueuedFiles((current) => current.filter((entry) => entry.id !== id));
    setResult(null);
  };

  const reorder = (fromIndex: number, toIndex: number) => {
    setQueuedFiles((current) => moveItem(current, fromIndex, toIndex));
  };

  const handleMerge = async () => {
    if (isProcessingRef.current || queuedFiles.length < 2) return;

    isProcessingRef.current = true;
    setIsProcessing(true);
    setError(null);

    try {
      const mergeResult = await mergePdfs(queuedFiles.map((entry) => entry.file));

      setResult(mergeResult);
      downloadPdfBytes(mergeResult.bytes, MERGED_FILENAME);
    } catch (mergeError) {
      console.error("PDF merge error:", mergeError);
      setError(
        mergeError instanceof Error
          ? `Merge failed: ${mergeError.message}`
          : "Failed to merge the selected PDFs.",
      );
    } finally {
      isProcessingRef.current = false;
      setIsProcessing(false);
    }
  };

  /** Clears the queue and result so the user can start a fresh merge, without leaving old files behind. */
  const handleMergeAnother = () => {
    setQueuedFiles([]);
    setResult(null);
    setError(null);

    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  const canMerge = queuedFiles.length >= 2 && !isProcessing;
  const totalQueuedSize = queuedFiles.reduce(
    (sum, entry) => sum + entry.file.size,
    0,
  );

  return (
    <div className="w-full max-w-2xl mx-auto px-4 sm:px-6">
      <div className="bg-white rounded-2xl shadow-lg border border-gray-100 overflow-hidden">
        <div className="px-4 sm:px-6 pt-6 sm:pt-8">
          <h2 className="text-xl font-bold text-gray-900">Merge PDF</h2>
          <p className="mt-1 text-sm text-gray-500">
            Combine multiple PDFs into one, in the order you choose.
          </p>
        </div>

        <input
          ref={fileInputRef}
          type="file"
          accept=".pdf,application/pdf"
          multiple
          className="hidden"
          onChange={(event) => {
            addFiles(event.target.files);
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
            addFiles(event.dataTransfer.files);
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
            Choose PDFs to merge
          </p>
          <p className="mt-1 text-sm text-gray-500 text-center">
            or drag and drop multiple files here &middot; they&apos;ll be
            combined into one PDF in the order you set below
          </p>
        </div>

        <div className="px-4 sm:px-6 pb-6">
          {error && (
            <p role="alert" className="mt-2 text-sm font-medium text-red-600">
              {error}
            </p>
          )}

          {queuedFiles.length > 0 && (
            <>
              <div className="mt-4 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <p className="text-sm font-medium text-gray-700">
                  {queuedFiles.length} PDF
                  {queuedFiles.length === 1 ? "" : "s"} ready to merge
                </p>
                <p className="text-xs text-gray-500">
                  Total {formatFileSize(totalQueuedSize)}
                </p>
              </div>
              <p className="mt-1 text-xs text-gray-500">
                Pages will appear in this order — use the arrows to move a
                file earlier or later.
              </p>

              <div role="list" className="mt-3 space-y-2">
                {queuedFiles.map((entry, index) => (
                  <div
                    key={entry.id}
                    role="listitem"
                    className="flex items-center gap-3 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2.5"
                  >
                    <span
                      aria-hidden="true"
                      className="flex h-6 w-6 flex-none items-center justify-center rounded-full bg-blue-100 text-xs font-semibold text-blue-700"
                    >
                      {index + 1}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-gray-800">
                        {entry.file.name}
                      </p>
                      <p className="text-xs text-gray-500">
                        {formatFileSize(entry.file.size)}
                      </p>
                    </div>
                    <div className="flex flex-none items-center gap-0.5">
                      <button
                        type="button"
                        aria-label={`Move ${entry.file.name} earlier in the merge order`}
                        title="Move earlier"
                        onClick={() => reorder(index, index - 1)}
                        disabled={index === 0 || isProcessing}
                        className="rounded px-2 py-1.5 text-xs text-gray-500 hover:bg-gray-100 disabled:text-gray-300"
                      >
                        ▲
                      </button>
                      <button
                        type="button"
                        aria-label={`Move ${entry.file.name} later in the merge order`}
                        title="Move later"
                        onClick={() => reorder(index, index + 1)}
                        disabled={
                          index === queuedFiles.length - 1 || isProcessing
                        }
                        className="rounded px-2 py-1.5 text-xs text-gray-500 hover:bg-gray-100 disabled:text-gray-300"
                      >
                        ▼
                      </button>
                      <button
                        type="button"
                        aria-label={`Remove ${entry.file.name} from the merge queue`}
                        title="Remove"
                        onClick={() => removeFile(entry.id)}
                        disabled={isProcessing}
                        className="rounded px-2 py-1.5 text-xs text-red-500 hover:bg-red-50 disabled:text-gray-300"
                      >
                        ✕
                      </button>
                    </div>
                  </div>
                ))}
              </div>

              {queuedFiles.length === 1 && (
                <p className="mt-2 text-xs text-amber-600">
                  Add at least one more PDF to merge.
                </p>
              )}
            </>
          )}

          <button
            type="button"
            onClick={handleMerge}
            disabled={!canMerge}
            aria-busy={isProcessing}
            className={`mt-6 flex w-full items-center justify-center rounded-lg px-4 py-3 text-sm font-semibold transition-colors ${
              canMerge
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
            {isProcessing ? "Merging PDFs..." : "Merge PDFs"}
          </button>

          {isProcessing && (
            <p className="mt-2 text-center text-xs text-gray-500">
              Merging your PDFs — this should only take a moment.
            </p>
          )}
        </div>

        {result && (
          <ResultPanel
            icon="✓"
            title="Your merged PDF is ready"
            message={`${result.fileCount} PDFs merged into one ${result.totalPageCount}-page file · ${(result.processingTime / 1000).toFixed(2)}s`}
            stats={[
              { label: "Output file", value: MERGED_FILENAME },
              { label: "Pages", value: result.totalPageCount },
              { label: "File size", value: formatFileSize(result.bytes.length) },
              { label: "Files merged", value: result.fileCount },
            ]}
            onDownload={() => downloadPdfBytes(result.bytes, MERGED_FILENAME)}
            downloadLabel="Download Merged PDF"
            onReset={handleMergeAnother}
            resetLabel="Merge another set"
          />
        )}
      </div>
    </div>
  );
}
