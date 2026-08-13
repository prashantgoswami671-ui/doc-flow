"use client";

import { useEffect, useRef, useState } from "react";
import {
  applyImageFilter,
  FILTER_PRESETS,
  isImageFile,
  type FilterPreset,
  type ProcessedImage,
} from "../services/imageFilters";
import {
  imagesToPdf,
  type FitModeOption,
  type ImageToPdfResult,
  type OrientationOption,
  type PageSizeOption,
} from "../services/pdf/imageToPdf";

interface QueuedImage {
  id: string;
  file: File;
  /** Stable object URL for the untouched original file. Never revoked until removal/unmount. */
  originalUrl: string;
  /** URL currently rendered as the thumbnail/preview — either `originalUrl` or a generated preview URL. */
  previewUrl: string;
  /** Which filter `previewUrl` currently reflects. Used to skip redundant preview regeneration. */
  previewFilter: FilterPreset;
  /** Blob URL for a generated (non-"original") preview, if one exists — tracked so it can be revoked. */
  generatedUrl: string | null;
  isPreviewLoading: boolean;
  previewError: string | null;
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

const PAGE_SIZE_OPTIONS: { value: PageSizeOption; label: string }[] = [
  { value: "a4", label: "A4" },
  { value: "letter", label: "Letter" },
  { value: "original", label: "Original" },
];

const ORIENTATION_OPTIONS: { value: OrientationOption; label: string }[] = [
  { value: "auto", label: "Auto" },
  { value: "portrait", label: "Portrait" },
  { value: "landscape", label: "Landscape" },
];

const FIT_MODE_OPTIONS: { value: FitModeOption; label: string }[] = [
  { value: "fit", label: "Fit to page" },
  { value: "fill", label: "Fill page" },
  { value: "original", label: "Original size" },
];

let nextQueuedImageId = 0;

export default function ImageToPdfCard() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const isProcessingRef = useRef(false);
  const queuedImagesRef = useRef<QueuedImage[]>([]);

  const [queuedImages, setQueuedImages] = useState<QueuedImage[]>([]);
  const [isDragging, setIsDragging] = useState(false);

  const [filterPreset, setFilterPreset] = useState<FilterPreset>("original");
  const [pageSize, setPageSize] = useState<PageSizeOption>("a4");
  const [orientation, setOrientation] = useState<OrientationOption>("auto");
  const [fitMode, setFitMode] = useState<FitModeOption>("fit");

  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [result, setResult] = useState<ImageToPdfResult | null>(null);

  // Index into `queuedImages` for the click-to-preview lightbox, or `null`
  // when the modal is closed.
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);

  // Keep a ref mirror of the queue so async preview generation and the
  // unmount cleanup effect always see the latest queue without needing
  // `queuedImages` itself in their dependency arrays.
  useEffect(() => {
    queuedImagesRef.current = queuedImages;
  }, [queuedImages]);

  // Revoke every remaining object URL (original + generated preview) when
  // the card unmounts.
  useEffect(() => {
    return () => {
      for (const entry of queuedImagesRef.current) {
        URL.revokeObjectURL(entry.originalUrl);
        if (entry.generatedUrl) {
          URL.revokeObjectURL(entry.generatedUrl);
        }
      }
    };
  }, []);

  // Live filter preview: regenerate a thumbnail only for images whose
  // `previewFilter` doesn't match the currently selected filter. Reuses
  // the exact filtering logic in services/imageFilters.ts — no separate
  // preview implementation. Runs against `queuedImagesRef` (not the
  // `queuedImages` state directly) so this effect's dependency array can
  // stay limited to `filterPreset` and the current set of queued image
  // ids, instead of re-triggering on every preview state update it makes.
  // The lightbox modal below reads `previewUrl`/`isPreviewLoading` from the
  // same queued-image state, so it updates automatically once this effect
  // finishes — no separate preview generation for the modal.
  const queuedImageIdsKey = queuedImages.map((entry) => entry.id).join(",");

  useEffect(() => {
    let cancelled = false;

    async function syncPreviews() {
      const pending = queuedImagesRef.current.filter(
        (entry) => entry.previewFilter !== filterPreset,
      );

      if (pending.length === 0) return;

      setQueuedImages((current) =>
        current.map((entry) =>
          entry.previewFilter !== filterPreset
            ? { ...entry, isPreviewLoading: true, previewError: null }
            : entry,
        ),
      );

      for (const target of pending) {
        if (cancelled) return;

        const stillQueued = queuedImagesRef.current.some(
          (entry) => entry.id === target.id,
        );

        if (!stillQueued) continue;

        if (filterPreset === "original") {
          setQueuedImages((current) =>
            current.map((entry) => {
              if (entry.id !== target.id) return entry;
              if (entry.generatedUrl) URL.revokeObjectURL(entry.generatedUrl);

              return {
                ...entry,
                previewUrl: entry.originalUrl,
                previewFilter: "original",
                generatedUrl: null,
                isPreviewLoading: false,
                previewError: null,
              };
            }),
          );
          continue;
        }

        try {
          const processed = await applyImageFilter(target.file, filterPreset);

          if (cancelled) return;

          const mimeType =
            processed.format === "png" ? "image/png" : "image/jpeg";
          const blob = new Blob([processed.bytes as BlobPart], {
            type: mimeType,
          });
          const url = URL.createObjectURL(blob);

          if (cancelled) {
            URL.revokeObjectURL(url);
            return;
          }

          setQueuedImages((current) =>
            current.map((entry) => {
              if (entry.id !== target.id) return entry;
              if (entry.generatedUrl) URL.revokeObjectURL(entry.generatedUrl);

              return {
                ...entry,
                previewUrl: url,
                previewFilter: filterPreset,
                generatedUrl: url,
                isPreviewLoading: false,
                previewError: null,
              };
            }),
          );
        } catch (previewGenerationError) {
          console.error("Preview generation error:", previewGenerationError);

          if (cancelled) return;

          setQueuedImages((current) =>
            current.map((entry) =>
              entry.id === target.id
                ? {
                    ...entry,
                    isPreviewLoading: false,
                    previewError: "Preview unavailable",
                  }
                : entry,
            ),
          );
        }
      }
    }

    syncPreviews();

    return () => {
      cancelled = true;
    };
    // Deliberately excludes `queuedImages`: preview sync reads the latest
    // queue via `queuedImagesRef` so that state updates made *by this
    // effect* don't retrigger it. `queuedImageIdsKey` still catches newly
    // added/removed images.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterPreset, queuedImageIdsKey]);

  // Keep the lightbox index valid: if the previewed image is removed (or
  // the queue is cleared) while the modal is open, close it instead of
  // pointing at a stale/incorrect index.
  useEffect(() => {
    if (previewIndex !== null && !queuedImages[previewIndex]) {
      setPreviewIndex(null);
    }
  }, [previewIndex, queuedImages]);

  // Lightbox keyboard support: Escape closes, ArrowLeft/ArrowRight navigate.
  useEffect(() => {
    if (previewIndex === null) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setPreviewIndex(null);
      } else if (event.key === "ArrowLeft") {
        setPreviewIndex((current) => {
          if (current === null || queuedImages.length === 0) return current;
          return (current - 1 + queuedImages.length) % queuedImages.length;
        });
      } else if (event.key === "ArrowRight") {
        setPreviewIndex((current) => {
          if (current === null || queuedImages.length === 0) return current;
          return (current + 1) % queuedImages.length;
        });
      }
    };

    window.addEventListener("keydown", handleKeyDown);

    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [previewIndex, queuedImages.length]);

  const resetOutput = () => {
    setResult(null);
    setSuccessMessage(null);
    setError(null);
  };

  const addFiles = (fileList: FileList | File[] | null | undefined) => {
    if (!fileList) return;

    const incoming = Array.from(fileList);
    const invalid = incoming.find((file) => !isImageFile(file));

    if (invalid) {
      setError("Please select JPG, JPEG, or PNG images only.");
      return;
    }

    resetOutput();
    setQueuedImages((current) => [
      ...current,
      ...incoming.map((file) => {
        const originalUrl = URL.createObjectURL(file);

        return {
          id: `${nextQueuedImageId++}`,
          file,
          originalUrl,
          previewUrl: originalUrl,
          previewFilter: "original" as FilterPreset,
          generatedUrl: null,
          isPreviewLoading: false,
          previewError: null,
        };
      }),
    ]);
  };

  const removeImage = (id: string) => {
    setQueuedImages((current) => {
      const target = current.find((entry) => entry.id === id);

      if (target) {
        URL.revokeObjectURL(target.originalUrl);
        if (target.generatedUrl) {
          URL.revokeObjectURL(target.generatedUrl);
        }
      }

      return current.filter((entry) => entry.id !== id);
    });
    resetOutput();
  };

  const reorder = (fromIndex: number, toIndex: number) => {
    setQueuedImages((current) => moveItem(current, fromIndex, toIndex));
  };

  const canGenerate = queuedImages.length >= 1 && !isProcessing;

  const handleGenerate = async () => {
    if (isProcessingRef.current || queuedImages.length === 0) return;

    isProcessingRef.current = true;
    setIsProcessing(true);
    setError(null);
    setSuccessMessage(null);

    try {
      // Filters are applied here, once per generate click — never on every
      // settings change — and the original uploaded Files are only read
      // from, never mutated. This is independent of the live preview
      // thumbnails above, which are generated from the same File objects.
      const processedImages: ProcessedImage[] = [];

      for (const entry of queuedImages) {
        const processed = await applyImageFilter(entry.file, filterPreset);
        processedImages.push(processed);
      }

      const pdfResult = await imagesToPdf(processedImages, {
        pageSize,
        orientation,
        fitMode,
      });

      setResult(pdfResult);
      downloadPdfBytes(pdfResult.bytes, "images.pdf");
      setSuccessMessage(
        `Created a ${pdfResult.imageCount}-page PDF and downloaded it.`,
      );
    } catch (generateError) {
      console.error("Image to PDF error:", generateError);
      setError(
        generateError instanceof Error
          ? generateError.message
          : "Failed to generate the PDF from the selected images.",
      );
    } finally {
      isProcessingRef.current = false;
      setIsProcessing(false);
    }
  };

  const selectClasses =
    "mt-2 w-full rounded-lg border border-gray-300 px-4 py-2.5 text-sm text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20 disabled:bg-gray-50 disabled:text-gray-400";
  const labelClasses = "block text-sm font-medium text-gray-700";

  const previewEntry = previewIndex !== null ? queuedImages[previewIndex] ?? null : null;

  const showPreviousPreview = () => {
    setPreviewIndex((current) => {
      if (current === null || queuedImages.length === 0) return current;
      return (current - 1 + queuedImages.length) % queuedImages.length;
    });
  };

  const showNextPreview = () => {
    setPreviewIndex((current) => {
      if (current === null || queuedImages.length === 0) return current;
      return (current + 1) % queuedImages.length;
    });
  };

  return (
    <div className="w-full max-w-2xl mx-auto px-4 sm:px-6">
      <div className="bg-white rounded-2xl shadow-lg border border-gray-100 overflow-hidden">
        <div className="px-4 sm:px-6 pt-6 sm:pt-8">
          <h2 className="text-xl font-bold text-gray-900">Image to PDF</h2>
          <p className="mt-1 text-sm text-gray-500">
            Combine JPG and PNG images into a single PDF, in the order you
            choose.
          </p>
        </div>

        <input
          ref={fileInputRef}
          type="file"
          accept=".jpg,.jpeg,.png,image/jpeg,image/png"
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
            Choose images to convert
          </p>
          <p className="mt-1 text-sm text-gray-500">
            or drag and drop them here &middot; JPG, JPEG, or PNG &middot;
            select multiple files
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

          {queuedImages.length > 0 && (
            <>
              <p className="mt-4 text-sm font-medium text-gray-700">
                {queuedImages.length} image
                {queuedImages.length === 1 ? "" : "s"} &middot; one page each,
                in this order
              </p>

              <div className="mt-3 space-y-2">
                {queuedImages.map((entry, index) => (
                  <div
                    key={entry.id}
                    className="flex items-center gap-3 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2.5"
                  >
                    <span className="flex h-6 w-6 flex-none items-center justify-center rounded-full bg-blue-100 text-xs font-semibold text-blue-700">
                      {index + 1}
                    </span>
                    <button
                      type="button"
                      onClick={() => setPreviewIndex(index)}
                      aria-label={`View larger preview of ${entry.file.name}`}
                      className="relative h-12 w-12 flex-none overflow-hidden rounded-md border border-gray-200 focus:outline-none focus:ring-2 focus:ring-blue-500/40"
                    >
                      <img
                        src={entry.previewUrl}
                        alt={entry.file.name}
                        className="h-12 w-12 object-cover"
                      />
                      {entry.isPreviewLoading && (
                        <div
                          role="status"
                          aria-label="Processing preview"
                          className="absolute inset-0 flex items-center justify-center bg-white/70"
                        >
                          <span className="h-4 w-4 animate-spin rounded-full border-2 border-blue-500 border-t-transparent" />
                        </div>
                      )}
                    </button>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-gray-800">
                        {entry.file.name}
                      </p>
                      <p className="text-xs text-gray-500">
                        {(entry.file.size / 1024).toFixed(2)} KB
                      </p>
                      {entry.isPreviewLoading && (
                        <p className="text-xs text-gray-400">
                          Processing preview...
                        </p>
                      )}
                      {!entry.isPreviewLoading && entry.previewError && (
                        <p className="text-xs text-amber-600">
                          {entry.previewError}
                        </p>
                      )}
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
                          index === queuedImages.length - 1 || isProcessing
                        }
                        className="rounded px-1.5 py-1 text-xs text-gray-500 hover:bg-gray-100 disabled:text-gray-300"
                      >
                        ▼
                      </button>
                      <button
                        type="button"
                        aria-label={`Remove ${entry.file.name}`}
                        onClick={() => removeImage(entry.id)}
                        disabled={isProcessing}
                        className="rounded px-1.5 py-1 text-xs text-red-500 hover:bg-red-50 disabled:text-gray-300"
                      >
                        ✕
                      </button>
                    </div>
                  </div>
                ))}
              </div>

              {/* FILTER */}
              <div className="mt-6">
                <p className={labelClasses}>Filter</p>
                <div className="mt-2 grid grid-cols-2 gap-3">
                  {FILTER_PRESETS.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      onClick={() => {
                        resetOutput();
                        setFilterPreset(option.value);
                      }}
                      disabled={isProcessing}
                      className={`rounded-lg border px-4 py-3 text-sm font-medium transition-colors ${
                        filterPreset === option.value
                          ? "border-blue-600 bg-blue-600 text-white shadow-sm"
                          : "border-gray-200 bg-white text-gray-700 hover:border-blue-300 hover:bg-blue-50"
                      }`}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* PDF SETTINGS */}
              <div className="mt-6 rounded-xl border border-gray-200 p-4">
                <p className="text-sm font-semibold text-gray-800">
                  PDF settings
                </p>

                <div className="mt-4 grid grid-cols-1 sm:grid-cols-3 gap-4">
                  <div>
                    <label htmlFor="image-pdf-page-size" className={labelClasses}>
                      Page size
                    </label>
                    <select
                      id="image-pdf-page-size"
                      value={pageSize}
                      disabled={isProcessing}
                      onChange={(event) => {
                        resetOutput();
                        setPageSize(event.target.value as PageSizeOption);
                      }}
                      className={selectClasses}
                    >
                      {PAGE_SIZE_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label
                      htmlFor="image-pdf-orientation"
                      className={labelClasses}
                    >
                      Orientation
                    </label>
                    <select
                      id="image-pdf-orientation"
                      value={orientation}
                      disabled={isProcessing || pageSize === "original"}
                      onChange={(event) => {
                        resetOutput();
                        setOrientation(event.target.value as OrientationOption);
                      }}
                      className={selectClasses}
                    >
                      {ORIENTATION_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                    {pageSize === "original" && (
                      <p className="mt-1 text-xs text-gray-500">
                        Not used with an Original page size.
                      </p>
                    )}
                  </div>

                  <div>
                    <label htmlFor="image-pdf-fit-mode" className={labelClasses}>
                      Image fitting
                    </label>
                    <select
                      id="image-pdf-fit-mode"
                      value={fitMode}
                      disabled={isProcessing}
                      onChange={(event) => {
                        resetOutput();
                        setFitMode(event.target.value as FitModeOption);
                      }}
                      className={selectClasses}
                    >
                      {FIT_MODE_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              </div>
            </>
          )}

          {result && (
            <p className="mt-4 text-sm text-gray-500">
              {result.imageCount} image{result.imageCount === 1 ? "" : "s"}
              &middot; completed in{" "}
              {(result.processingTime / 1000).toFixed(2)}s.
            </p>
          )}

          <button
            type="button"
            onClick={handleGenerate}
            disabled={!canGenerate}
            className={`mt-6 w-full rounded-lg px-4 py-3 text-sm font-semibold transition-colors ${
              canGenerate
                ? "bg-blue-600 text-white hover:bg-blue-700"
                : "bg-gray-200 text-gray-400 cursor-not-allowed"
            }`}
          >
            {isProcessing ? "Generating PDF..." : "Generate PDF"}
          </button>

          {result && (
            <button
              type="button"
              onClick={() => downloadPdfBytes(result.bytes, "images.pdf")}
              className="mt-3 w-full rounded-lg border border-gray-300 bg-white px-4 py-3 text-sm font-semibold text-gray-700 transition-colors hover:bg-gray-50"
            >
              Download PDF Again
            </button>
          )}
        </div>
      </div>

      {/* LIGHTBOX PREVIEW MODAL */}
      {previewEntry && previewIndex !== null && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 p-4"
          onClick={() => setPreviewIndex(null)}
          role="dialog"
          aria-modal="true"
          aria-label={`Preview of ${previewEntry.file.name}`}
        >
          <button
            type="button"
            aria-label="Close preview"
            onClick={(event) => {
              event.stopPropagation();
              setPreviewIndex(null);
            }}
            className="absolute right-3 top-3 sm:right-5 sm:top-5 flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-2xl leading-none text-white transition-colors hover:bg-white/20"
          >
            ×
          </button>

          {queuedImages.length > 1 && (
            <button
              type="button"
              aria-label="Previous image"
              onClick={(event) => {
                event.stopPropagation();
                showPreviousPreview();
              }}
              className="absolute left-2 sm:left-5 flex h-10 w-10 flex-none items-center justify-center rounded-full bg-white/10 text-2xl leading-none text-white transition-colors hover:bg-white/20"
            >
              ‹
            </button>
          )}

          {queuedImages.length > 1 && (
            <button
              type="button"
              aria-label="Next image"
              onClick={(event) => {
                event.stopPropagation();
                showNextPreview();
              }}
              className="absolute right-2 sm:right-5 flex h-10 w-10 flex-none items-center justify-center rounded-full bg-white/10 text-2xl leading-none text-white transition-colors hover:bg-white/20"
            >
              ›
            </button>
          )}

          <div
            className="flex max-h-full max-w-full flex-col items-center gap-3"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="relative flex max-h-[78vh] max-w-[90vw] items-center justify-center sm:max-h-[80vh] sm:max-w-[85vw]">
              <img
                src={previewEntry.previewUrl}
                alt={previewEntry.file.name}
                className="max-h-[78vh] max-w-[90vw] rounded-lg object-contain shadow-2xl sm:max-h-[80vh] sm:max-w-[85vw]"
              />
              {previewEntry.isPreviewLoading && (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 rounded-lg bg-black/60">
                  <span className="h-8 w-8 animate-spin rounded-full border-2 border-white border-t-transparent" />
                  <span className="text-sm font-medium text-white">
                    Processing preview...
                  </span>
                </div>
              )}
            </div>

            <div className="text-center">
              <p className="max-w-[90vw] truncate text-sm font-medium text-white">
                {previewEntry.file.name}
              </p>
              <p className="mt-1 text-xs text-white/70">
                {previewIndex + 1} / {queuedImages.length}
              </p>
              {!previewEntry.isPreviewLoading && previewEntry.previewError && (
                <p className="mt-1 text-xs text-amber-400">
                  {previewEntry.previewError} — showing last available preview.
                </p>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
