"use client";

import { useRef, useState } from "react";
import {
  buildPageOperations,
  createManagedPages,
  isReordered,
  movePage,
  normalizeRotation,
  organizePages,
  type ManagedPage,
  type OrganizeResult,
  type PageRotation,
} from "../services/pdf/organize";
import { renderPageThumbnails } from "../services/pdf/thumbnails";

const rotationOptions: { rotation: PageRotation; label: string }[] = [
  { rotation: 90, label: "Rotate 90°" },
  { rotation: 180, label: "Rotate 180°" },
  { rotation: 270, label: "Rotate 270°" },
];

const rotationClasses: Record<PageRotation, string> = {
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

function getOrganizedFilename(originalName: string): string {
  if (originalName.toLowerCase().endsWith(".pdf")) {
    return `${originalName.slice(0, -4)}-organized.pdf`;
  }

  return `${originalName}-organized.pdf`;
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

export default function OrganizePagesCard() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const isProcessingRef = useRef(false);
  const previewRequestIdRef = useRef(0);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [pages, setPages] = useState<ManagedPage[]>([]);
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
  const [dropTargetIndex, setDropTargetIndex] = useState<number | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isLoadingPreviews, setIsLoadingPreviews] = useState(false);
  const [previewProgress, setPreviewProgress] = useState("");
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [result, setResult] = useState<OrganizeResult | null>(null);

  const resetState = () => {
    previewRequestIdRef.current += 1;
    setSelectedFile(null);
    setPages([]);
    setDraggedIndex(null);
    setDropTargetIndex(null);
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
    setPages([]);

    try {
      const thumbnails = await renderPageThumbnails(file, {
        onProgress: (progress) => {
          if (requestId === previewRequestIdRef.current) {
            setPreviewProgress(
              `Rendering page ${progress.currentPage} of ${progress.pageCount}...`,
            );
          }
        },
      });

      if (requestId !== previewRequestIdRef.current) return;

      setPages(createManagedPages(thumbnails));
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
    setPages([]);
    setResult(null);
    setError(null);
    setSuccessMessage(null);
    void loadPreviews(file);
  };

  const toggleSelection = (sourcePageNumber: number) => {
    setPages((current) =>
      current.map((page) =>
        page.sourcePageNumber === sourcePageNumber
          ? { ...page, selected: !page.selected }
          : page,
      ),
    );
  };

  const rotateSelection = (rotation: PageRotation) => {
    setPages((current) =>
      current.map((page) =>
        page.selected && !page.deleted
          ? {
              ...page,
              rotation: normalizeRotation(page.rotation + rotation),
            }
          : page,
      ),
    );
  };

  const markSelectedDeleted = (deleted: boolean) => {
    setPages((current) =>
      current.map((page) =>
        page.selected ? { ...page, deleted } : page,
      ),
    );
  };

  const reorder = (fromIndex: number, toIndex: number) => {
    setPages((current) => movePage(current, fromIndex, toIndex));
  };

  const handleApplyChanges = async () => {
    if (isProcessingRef.current || !selectedFile) return;

    isProcessingRef.current = true;
    setIsProcessing(true);
    setError(null);
    setSuccessMessage(null);

    try {
      const organizeResult = await organizePages(
        selectedFile,
        buildPageOperations(pages),
      );

      setResult(organizeResult);
      downloadPdfBytes(
        organizeResult.bytes,
        getOrganizedFilename(selectedFile.name),
      );
      setSuccessMessage("Changes applied successfully.");
    } catch (organizeError) {
      console.error("PDF organize error:", organizeError);
      setError(
        organizeError instanceof Error
          ? `Could not apply changes: ${organizeError.message}`
          : "Failed to apply the requested page changes.",
      );
    } finally {
      isProcessingRef.current = false;
      setIsProcessing(false);
    }
  };

  const selectedCount = pages.filter((page) => page.selected).length;
  const deletedCount = pages.filter((page) => page.deleted).length;
  const rotatedCount = pages.filter(
    (page) => !page.deleted && page.rotation !== 0,
  ).length;
  const remainingCount = pages.length - deletedCount;
  const pagesReordered = isReordered(pages);
  const deletesEveryPage = pages.length > 0 && remainingCount === 0;
  const hasChanges = deletedCount > 0 || rotatedCount > 0 || pagesReordered;
  const canApply =
    selectedFile !== null &&
    pages.length > 0 &&
    hasChanges &&
    !deletesEveryPage &&
    !isLoadingPreviews &&
    !isProcessing;

  return (
    <div className="w-full max-w-2xl mx-auto px-4 sm:px-6">
      <div className="bg-white rounded-2xl shadow-lg border border-gray-100 overflow-hidden">
        <div className="px-4 sm:px-6 pt-6 sm:pt-8">
          <h2 className="text-xl font-bold text-gray-900">Organize Pages</h2>
          <p className="mt-1 text-sm text-gray-500">
            Select pages to delete or rotate them, drag thumbnails to reorder,
            then apply everything in one step.
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
            Choose a PDF to organize
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

          {pages.length > 0 && (
            <>
              <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-medium text-gray-700">
                  {selectedCount} page{selectedCount === 1 ? "" : "s"} selected
                </p>
                {selectedCount > 0 && (
                  <button
                    type="button"
                    onClick={() =>
                      setPages((current) =>
                        current.map((page) => ({ ...page, selected: false })),
                      )
                    }
                    disabled={isProcessing}
                    className="text-sm font-medium text-blue-600 hover:text-blue-700 disabled:text-gray-400"
                  >
                    Clear selection
                  </button>
                )}
              </div>

              <div className="mt-3 flex flex-wrap gap-2">
                {rotationOptions.map((option) => (
                  <button
                    key={option.rotation}
                    type="button"
                    onClick={() => rotateSelection(option.rotation)}
                    disabled={selectedCount === 0 || isProcessing}
                    className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-medium text-gray-700 transition-colors hover:border-blue-300 hover:bg-blue-50 disabled:cursor-not-allowed disabled:border-gray-200 disabled:bg-gray-100 disabled:text-gray-400"
                  >
                    {option.label}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => markSelectedDeleted(true)}
                  disabled={selectedCount === 0 || isProcessing}
                  className="rounded-lg border border-red-200 bg-white px-3 py-2 text-sm font-medium text-red-600 transition-colors hover:border-red-300 hover:bg-red-50 disabled:cursor-not-allowed disabled:border-gray-200 disabled:bg-gray-100 disabled:text-gray-400"
                >
                  Mark for deletion
                </button>
                <button
                  type="button"
                  onClick={() => markSelectedDeleted(false)}
                  disabled={selectedCount === 0 || isProcessing}
                  className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-medium text-gray-700 transition-colors hover:border-blue-300 hover:bg-blue-50 disabled:cursor-not-allowed disabled:border-gray-200 disabled:bg-gray-100 disabled:text-gray-400"
                >
                  Keep pages
                </button>
              </div>

              <div className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-3">
                {pages.map((page, index) => {
                  const isDropTarget =
                    dropTargetIndex === index && draggedIndex !== index;

                  return (
                    <div
                      key={page.sourcePageNumber}
                      draggable={!isProcessing}
                      onDragStart={() => setDraggedIndex(index)}
                      onDragEnter={() => setDropTargetIndex(index)}
                      onDragOver={(event) => event.preventDefault()}
                      onDragEnd={() => {
                        setDraggedIndex(null);
                        setDropTargetIndex(null);
                      }}
                      onDrop={(event) => {
                        event.preventDefault();

                        if (draggedIndex !== null) {
                          reorder(draggedIndex, index);
                        }

                        setDraggedIndex(null);
                        setDropTargetIndex(null);
                      }}
                      className={`flex flex-col rounded-lg border-2 p-2 transition-colors ${
                        draggedIndex === index ? "opacity-50" : ""
                      } ${
                        isDropTarget
                          ? "border-blue-500 bg-blue-50"
                          : page.deleted
                            ? "border-red-400 bg-red-50"
                            : page.selected
                              ? "border-blue-500 bg-blue-50"
                              : "border-gray-200 bg-white"
                      }`}
                    >
                      <button
                        type="button"
                        aria-pressed={page.selected}
                        aria-label={`Page ${page.sourcePageNumber}`}
                        onClick={() => toggleSelection(page.sourcePageNumber)}
                        disabled={isProcessing}
                        className="flex h-28 w-full cursor-pointer items-center justify-center overflow-hidden rounded bg-gray-100"
                      >
                        {page.thumbnailDataUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={page.thumbnailDataUrl}
                            alt={`Page ${page.sourcePageNumber} preview`}
                            className={`max-h-full object-contain transition-transform ${
                              page.rotation === 90 || page.rotation === 270
                                ? // Quarter turns swap the preview's axes, so cap
                                  // the pre-rotation width to the tile height.
                                  "max-w-[7rem]"
                                : "max-w-full"
                            } ${rotationClasses[page.rotation]} ${
                              page.deleted ? "opacity-40" : ""
                            }`}
                          />
                        ) : (
                          <span className="text-xs text-gray-500">
                            Preview off
                          </span>
                        )}
                      </button>

                      <div className="mt-2 flex items-center justify-between">
                        <button
                          type="button"
                          aria-label={`Move page ${page.sourcePageNumber} earlier`}
                          onClick={() => reorder(index, index - 1)}
                          disabled={index === 0 || isProcessing}
                          className="rounded px-1 text-xs text-gray-500 hover:bg-gray-100 disabled:text-gray-300"
                        >
                          ◀
                        </button>
                        <span
                          className={`text-xs font-semibold ${
                            page.deleted
                              ? "text-red-700 line-through"
                              : "text-gray-700"
                          }`}
                        >
                          Page {page.sourcePageNumber}
                        </span>
                        <button
                          type="button"
                          aria-label={`Move page ${page.sourcePageNumber} later`}
                          onClick={() => reorder(index, index + 1)}
                          disabled={index === pages.length - 1 || isProcessing}
                          className="rounded px-1 text-xs text-gray-500 hover:bg-gray-100 disabled:text-gray-300"
                        >
                          ▶
                        </button>
                      </div>

                      {page.rotation !== 0 && !page.deleted && (
                        <p className="mt-0.5 text-center text-xs text-blue-700">
                          {page.rotation}°
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>

              <p className="mt-3 text-sm text-gray-500">
                {deletedCount} to delete · {rotatedCount} to rotate ·{" "}
                {pagesReordered ? "reordered" : "original order"} ·{" "}
                {remainingCount} page{remainingCount === 1 ? "" : "s"} remaining
              </p>

              {deletesEveryPage && (
                <p className="mt-2 text-sm font-medium text-amber-600">
                  You cannot delete every page. Keep at least one page.
                </p>
              )}
            </>
          )}

          <button
            type="button"
            onClick={handleApplyChanges}
            disabled={!canApply}
            className={`mt-6 w-full rounded-lg px-4 py-3 text-sm font-semibold transition-colors ${
              canApply
                ? "bg-blue-600 text-white hover:bg-blue-700"
                : "bg-gray-200 text-gray-400 cursor-not-allowed"
            }`}
          >
            {isProcessing ? "Applying changes..." : "Apply Changes"}
          </button>

          {result && (
            <>
              <div className="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-3">
                <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2">
                  <p className="text-xs text-gray-500">Original pages</p>
                  <p className="mt-0.5 text-sm font-semibold text-gray-800">
                    {result.originalPageCount}
                  </p>
                </div>
                <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2">
                  <p className="text-xs text-gray-500">Deleted</p>
                  <p className="mt-0.5 text-sm font-semibold text-gray-800">
                    {result.deletedPageCount}
                  </p>
                </div>
                <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2">
                  <p className="text-xs text-gray-500">Rotated</p>
                  <p className="mt-0.5 text-sm font-semibold text-gray-800">
                    {result.rotatedPageCount}
                  </p>
                </div>
                <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2">
                  <p className="text-xs text-gray-500">Remaining</p>
                  <p className="mt-0.5 text-sm font-semibold text-gray-800">
                    {result.remainingPageCount}
                  </p>
                </div>
              </div>

              <p className="mt-2 text-sm text-gray-500">
                {result.reordered ? "Pages reordered · " : ""}Completed in{" "}
                {(result.processingTime / 1000).toFixed(2)}s.
              </p>

              <button
                type="button"
                onClick={() =>
                  downloadPdfBytes(
                    result.bytes,
                    getOrganizedFilename(selectedFile?.name ?? "Unknown.pdf"),
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
                Organize another PDF
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
