"use client";

import { useRef, useState } from "react";
import {
  deletePages,
  type DeletePagesResult,
} from "../services/pdf/deletePages";
import {
  renderPageThumbnails,
  type PageThumbnail,
} from "../services/pdf/thumbnails";

function isPdfFile(file: File): boolean {
  return (
    file.type === "application/pdf" ||
    file.name.toLowerCase().endsWith(".pdf")
  );
}

function getDeletedPagesFilename(originalName: string): string {
  if (originalName.toLowerCase().endsWith(".pdf")) {
    return `${originalName.slice(0, -4)}-pages-deleted.pdf`;
  }

  return `${originalName}-pages-deleted.pdf`;
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

export default function DeletePagesCard() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const isProcessingRef = useRef(false);
  const previewRequestIdRef = useRef(0);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [thumbnails, setThumbnails] = useState<PageThumbnail[]>([]);
  const [selectedPages, setSelectedPages] = useState<Set<number>>(new Set());
  const [isDragging, setIsDragging] = useState(false);
  const [isLoadingPreviews, setIsLoadingPreviews] = useState(false);
  const [previewProgress, setPreviewProgress] = useState("");
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [result, setResult] = useState<DeletePagesResult | null>(null);

  const resetState = () => {
    previewRequestIdRef.current += 1;
    setSelectedFile(null);
    setThumbnails([]);
    setSelectedPages(new Set());
    setResult(null);
    setError(null);
    setSuccessMessage(null);
    setIsLoadingPreviews(false);
    setPreviewProgress("");

    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  const loadPreviews = async (file: File) => {
    const requestId = ++previewRequestIdRef.current;

    setIsLoadingPreviews(true);
    setPreviewProgress("Loading page previews...");
    setThumbnails([]);
    setSelectedPages(new Set());

    try {
      const pageThumbnails = await renderPageThumbnails(file, {
        onProgress: (progress) => {
          if (requestId === previewRequestIdRef.current) {
            setPreviewProgress(
              `Rendering page ${progress.currentPage} of ${progress.pageCount}...`,
            );
          }
        },
      });

      if (requestId !== previewRequestIdRef.current) return;

      setThumbnails(pageThumbnails);
    } catch (previewError) {
      console.error("PDF page preview error:", previewError);

      if (requestId !== previewRequestIdRef.current) return;

      setError(
        previewError instanceof Error
          ? `Unable to load page previews: ${previewError.message}`
          : "Unable to load page previews for this PDF.",
      );
    } finally {
      if (requestId === previewRequestIdRef.current) {
        setIsLoadingPreviews(false);
        setPreviewProgress("");
      }
    }
  };

  const selectFile = (file: File | undefined) => {
    if (!file) return;

    if (!isPdfFile(file)) {
      resetState();
      setError("Please select a valid PDF file.");
      return;
    }

    previewRequestIdRef.current += 1;
    setSelectedFile(file);
    setResult(null);
    setError(null);
    setSuccessMessage(null);
    void loadPreviews(file);
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

  const handleDelete = async () => {
    if (isProcessingRef.current || !selectedFile) return;

    isProcessingRef.current = true;
    setIsProcessing(true);
    setError(null);
    setSuccessMessage(null);

    try {
      const deleteResult = await deletePages(selectedFile, selectedPages);

      setResult(deleteResult);
      downloadPdfBytes(
        deleteResult.bytes,
        getDeletedPagesFilename(selectedFile.name),
      );
      setSuccessMessage(
        `Deleted ${deleteResult.deletedPageCount} page${
          deleteResult.deletedPageCount === 1 ? "" : "s"
        } successfully.`,
      );
    } catch (deleteError) {
      console.error("PDF page deletion error:", deleteError);
      setError(
        deleteError instanceof Error
          ? `Delete failed: ${deleteError.message}`
          : "Failed to delete the selected pages.",
      );
    } finally {
      isProcessingRef.current = false;
      setIsProcessing(false);
    }
  };

  const pageCount = thumbnails.length;
  const selectedCount = selectedPages.size;
  const wouldDeleteEveryPage = pageCount > 0 && selectedCount === pageCount;
  const canDelete =
    selectedFile !== null &&
    selectedCount > 0 &&
    !wouldDeleteEveryPage &&
    !isLoadingPreviews &&
    !isProcessing;

  return (
    <div className="w-full max-w-2xl mx-auto px-4 sm:px-6">
      <div className="bg-white rounded-2xl shadow-lg border border-gray-100 overflow-hidden">
        <div className="px-4 sm:px-6 pt-6 sm:pt-8">
          <h2 className="text-xl font-bold text-gray-900">Delete Pages</h2>
          <p className="mt-1 text-sm text-gray-500">
            Select the pages you want to remove and download the remaining pages
            as a new PDF.
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
            Choose a PDF to delete pages from
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

          {isLoadingPreviews && (
            <p className="mt-4 text-sm font-medium text-gray-500">
              {previewProgress}
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

          {pageCount > 0 && (
            <>
              <div className="mt-4 flex items-center justify-between">
                <p className="text-sm font-medium text-gray-700">
                  {selectedCount} page{selectedCount === 1 ? "" : "s"} selected
                </p>
                {selectedCount > 0 && (
                  <button
                    type="button"
                    onClick={() => setSelectedPages(new Set())}
                    disabled={isProcessing}
                    className="text-sm font-medium text-blue-600 hover:text-blue-700 disabled:text-gray-400"
                  >
                    Clear selection
                  </button>
                )}
              </div>

              <div className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-3">
                {thumbnails.map((thumbnail) => {
                  const isSelected = selectedPages.has(thumbnail.pageNumber);

                  return (
                    <button
                      key={thumbnail.pageNumber}
                      type="button"
                      aria-pressed={isSelected}
                      onClick={() => togglePage(thumbnail.pageNumber)}
                      disabled={isProcessing}
                      className={`flex flex-col items-center rounded-lg border-2 p-2 transition-colors ${
                        isSelected
                          ? "border-red-500 bg-red-50"
                          : "border-gray-200 bg-white hover:border-blue-300 hover:bg-blue-50/50"
                      }`}
                    >
                      <div className="flex h-28 w-full items-center justify-center overflow-hidden rounded bg-gray-100">
                        {thumbnail.dataUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={thumbnail.dataUrl}
                            alt={`Page ${thumbnail.pageNumber} preview`}
                            className="max-h-full max-w-full object-contain"
                          />
                        ) : (
                          <span className="text-xs text-gray-500">
                            Preview off
                          </span>
                        )}
                      </div>
                      <span
                        className={`mt-2 text-xs font-semibold ${
                          isSelected ? "text-red-700" : "text-gray-700"
                        }`}
                      >
                        Page {thumbnail.pageNumber}
                        {isSelected ? " · selected" : ""}
                      </span>
                    </button>
                  );
                })}
              </div>

              {wouldDeleteEveryPage && (
                <p className="mt-3 text-sm font-medium text-amber-600">
                  You cannot delete every page. Keep at least one page.
                </p>
              )}
            </>
          )}

          <button
            type="button"
            onClick={handleDelete}
            disabled={!canDelete}
            className={`mt-6 w-full rounded-lg px-4 py-3 text-sm font-semibold transition-colors ${
              canDelete
                ? "bg-red-600 text-white hover:bg-red-700"
                : "bg-gray-200 text-gray-400 cursor-not-allowed"
            }`}
          >
            {isProcessing ? "Deleting pages..." : "Delete Selected Pages"}
          </button>

          {result && (
            <>
              <div className="mt-4 grid grid-cols-3 gap-3">
                <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2">
                  <p className="text-xs text-gray-500">Original pages</p>
                  <p className="mt-0.5 text-sm font-semibold text-gray-800">
                    {result.originalPageCount}
                  </p>
                </div>
                <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2">
                  <p className="text-xs text-gray-500">Deleted pages</p>
                  <p className="mt-0.5 text-sm font-semibold text-gray-800">
                    {result.deletedPageCount}
                  </p>
                </div>
                <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2">
                  <p className="text-xs text-gray-500">Remaining pages</p>
                  <p className="mt-0.5 text-sm font-semibold text-gray-800">
                    {result.remainingPageCount}
                  </p>
                </div>
              </div>

              <p className="mt-2 text-sm text-gray-500">
                Completed in {(result.processingTime / 1000).toFixed(2)}s.
              </p>

              <button
                type="button"
                onClick={() =>
                  downloadPdfBytes(
                    result.bytes,
                    getDeletedPagesFilename(selectedFile?.name ?? "Unknown.pdf"),
                  )
                }
                className="mt-3 w-full rounded-lg bg-blue-600 px-4 py-3 text-sm font-semibold text-white transition-colors hover:bg-blue-700"
              >
                Download PDF Again
              </button>

              <button
                type="button"
                onClick={resetState}
                className="mt-3 w-full rounded-lg border border-gray-300 bg-white px-4 py-3 text-sm font-semibold text-gray-700 transition-colors hover:bg-gray-50"
              >
                Delete pages from another PDF
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
