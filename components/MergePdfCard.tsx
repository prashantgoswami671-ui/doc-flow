"use client";

import { useRef, useState } from "react";
import { mergePdfs, type MergeResult } from "../services/pdf/merge";

interface QueuedFile {
  id: string;
  file: File;
}

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
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [result, setResult] = useState<MergeResult | null>(null);

  const addFiles = (fileList: FileList | File[] | null | undefined) => {
    if (!fileList) return;

    const incoming = Array.from(fileList);
    const invalid = incoming.find((file) => !isPdfFile(file));

    if (invalid) {
      setError("Please select valid PDF files only.");
      return;
    }

    setResult(null);
    setSuccessMessage(null);
    setError(null);
    setQueuedFiles((current) => [
      ...current,
      ...incoming.map((file) => ({ id: `${nextQueuedFileId++}`, file })),
    ]);
  };

  const removeFile = (id: string) => {
    setQueuedFiles((current) => current.filter((entry) => entry.id !== id));
    setResult(null);
    setSuccessMessage(null);
  };

  const reorder = (fromIndex: number, toIndex: number) => {
    setQueuedFiles((current) => moveItem(current, fromIndex, toIndex));
  };

  const handleMerge = async () => {
    if (isProcessingRef.current || queuedFiles.length < 2) return;

    isProcessingRef.current = true;
    setIsProcessing(true);
    setError(null);
    setSuccessMessage(null);

    try {
      const mergeResult = await mergePdfs(queuedFiles.map((entry) => entry.file));

      setResult(mergeResult);
      downloadPdfBytes(mergeResult.bytes, "merged.pdf");
      setSuccessMessage(
        `Merged ${mergeResult.fileCount} PDFs into one ${mergeResult.totalPageCount}-page file.`,
      );
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

  const canMerge = queuedFiles.length >= 2 && !isProcessing;

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
            addFiles(event.dataTransfer.files);
          }}
          className={`mx-4 sm:mx-6 mt-6 mb-4 flex flex-col items-center justify-center rounded-xl border-2 border-dashed px-6 py-10 transition-colors cursor-pointer ${
            isDragging
              ? "border-blue-500 bg-blue-50"
              : "border-gray-300 bg-gray-50 hover:border-blue-400 hover:bg-blue-50/50"
          }`}
        >
          <p className="text-base font-medium text-gray-800 text-center">
            Choose PDFs to merge
          </p>
          <p className="mt-1 text-sm text-gray-500">
            or drag and drop them here &middot; select multiple files
          </p>
        </div>

        <div className="px-4 sm:px-6 pb-6">
          {error && (
            <p className="mt-2 text-sm font-medium text-red-600">{error}</p>
          )}
          {successMessage && (
            <p className="mt-2 text-sm font-medium text-green-600">
              {successMessage}
            </p>
          )}

          {queuedFiles.length > 0 && (
            <>
              <p className="mt-4 text-sm font-medium text-gray-700">
                {queuedFiles.length} file{queuedFiles.length === 1 ? "" : "s"}{" "}
                &middot; merged in this order
              </p>

              <div className="mt-3 space-y-2">
                {queuedFiles.map((entry, index) => (
                  <div
                    key={entry.id}
                    className="flex items-center gap-3 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2.5"
                  >
                    <span className="flex h-6 w-6 flex-none items-center justify-center rounded-full bg-blue-100 text-xs font-semibold text-blue-700">
                      {index + 1}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-gray-800">
                        {entry.file.name}
                      </p>
                      <p className="text-xs text-gray-500">
                        {(entry.file.size / 1024).toFixed(2)} KB
                      </p>
                    </div>
                    <div className="flex flex-none items-center gap-1">
                      <button
                        type="button"
                        aria-label={`Move ${entry.file.name} earlier`}
                        onClick={() => reorder(index, index - 1)}
                        disabled={index === 0 || isProcessing}
                        className="rounded px-1.5 py-1 text-xs text-gray-500 hover:bg-gray-100 disabled:text-gray-300"
                      >
                        ▲
                      </button>
                      <button
                        type="button"
                        aria-label={`Move ${entry.file.name} later`}
                        onClick={() => reorder(index, index + 1)}
                        disabled={
                          index === queuedFiles.length - 1 || isProcessing
                        }
                        className="rounded px-1.5 py-1 text-xs text-gray-500 hover:bg-gray-100 disabled:text-gray-300"
                      >
                        ▼
                      </button>
                      <button
                        type="button"
                        aria-label={`Remove ${entry.file.name}`}
                        onClick={() => removeFile(entry.id)}
                        disabled={isProcessing}
                        className="rounded px-1.5 py-1 text-xs text-red-500 hover:bg-red-50 disabled:text-gray-300"
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

          {result && (
            <p className="mt-4 text-sm text-gray-500">
              {result.fileCount} files &middot; {result.totalPageCount} total
              pages &middot; completed in{" "}
              {(result.processingTime / 1000).toFixed(2)}s.
            </p>
          )}

          <button
            type="button"
            onClick={handleMerge}
            disabled={!canMerge}
            className={`mt-6 w-full rounded-lg px-4 py-3 text-sm font-semibold transition-colors ${
              canMerge
                ? "bg-blue-600 text-white hover:bg-blue-700"
                : "bg-gray-200 text-gray-400 cursor-not-allowed"
            }`}
          >
            {isProcessing ? "Merging PDFs..." : "Merge PDFs"}
          </button>
        </div>
      </div>
    </div>
  );
}
