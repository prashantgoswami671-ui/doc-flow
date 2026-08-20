"use client";

import { useEffect, useRef, useState } from "react";
import {
  convertPdfToImages,
  type ImageOutputFormat,
  type PdfToImagePageResult,
} from "../services/pdf/pdfToImage";
import {
  renderPageThumbnails,
  renderSinglePagePreview,
  type PageThumbnail,
} from "../services/pdf/thumbnails";
import PageThumbnailGrid from "./PageThumbnailGrid";
import ResultPanel from "./ResultPanel";
import UploadZone from "./UploadZone";
import { formatFileSize } from "./ResultCard";

function isPdfFile(file: File): boolean {
  return (
    file.type === "application/pdf" ||
    file.name.toLowerCase().endsWith(".pdf")
  );
}

function mimeForFormat(format: ImageOutputFormat): string {
  return format === "png" ? "image/png" : "image/jpeg";
}

function getPageImageFilename(
  originalName: string,
  pageNumber: number,
  format: ImageOutputFormat,
): string {
  const base = originalName.toLowerCase().endsWith(".pdf")
    ? originalName.slice(0, -4)
    : originalName;
  const extension = format === "png" ? "png" : "jpg";

  return `${base}-page-${pageNumber}.${extension}`;
}

function downloadImageBytes(
  bytes: Uint8Array,
  filename: string,
  format: ImageOutputFormat,
): void {
  const blob = new Blob([bytes as BlobPart], { type: mimeForFormat(format) });
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = objectUrl;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(objectUrl);
}

interface GeneratedImage extends PdfToImagePageResult {
  /** Object URL for the preview <img>/download; revoked when replaced or on unmount. */
  previewUrl: string;
}

function revokeGeneratedImages(images: GeneratedImage[]): void {
  for (const image of images) {
    URL.revokeObjectURL(image.previewUrl);
  }
}

const FORMAT_OPTIONS: { value: ImageOutputFormat; label: string }[] = [
  { value: "jpg", label: "JPG" },
  { value: "png", label: "PNG" },
];

const RESOLUTION_OPTIONS: { dpi: number; label: string }[] = [
  { dpi: 72, label: "72 DPI — screen" },
  { dpi: 150, label: "150 DPI — standard" },
  { dpi: 300, label: "300 DPI — print" },
];

const DEFAULT_JPG_QUALITY = 0.92;

// Longest edge, in CSS pixels, for the on-demand enlarged-preview render.
// This is only used for the single clicked page (via
// `renderSinglePagePreview`) — the thumbnail grid itself keeps using the
// much smaller `DEFAULT_MAX_DIMENSION` from `services/pdf/thumbnails.ts`.
const ENLARGED_PREVIEW_MAX_DIMENSION = 1600;

type EnlargedPreviewStatus = "loading" | "loaded" | "error";

export default function PdfToImageCard() {
  const isProcessingRef = useRef(false);
  const previewRequestIdRef = useRef(0);
  const resultsRef = useRef<GeneratedImage[]>([]);
  const enlargedPreviewCloseButtonRef = useRef<HTMLButtonElement>(null);
  const enlargedPreviewTriggerRef = useRef<HTMLElement | null>(null);
  const enlargedPreviewRequestIdRef = useRef(0);

  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [thumbnails, setThumbnails] = useState<PageThumbnail[]>([]);
  const [isLoadingPreviews, setIsLoadingPreviews] = useState(false);
  const [previewProgress, setPreviewProgress] = useState("");
  const [enlargedPreviewPage, setEnlargedPreviewPage] = useState<PageThumbnail | null>(
    null,
  );
  const [enlargedPreviewDataUrl, setEnlargedPreviewDataUrl] = useState<string | null>(
    null,
  );
  const [enlargedPreviewStatus, setEnlargedPreviewStatus] =
    useState<EnlargedPreviewStatus | null>(null);
  const [enlargedPreviewError, setEnlargedPreviewError] = useState<string | null>(
    null,
  );

  const [selectionMode, setSelectionMode] = useState<"all" | "selected">("all");
  const [selectedPages, setSelectedPages] = useState<Set<number>>(new Set());

  const [outputFormat, setOutputFormat] = useState<ImageOutputFormat>("jpg");
  const [jpgQuality, setJpgQuality] = useState(DEFAULT_JPG_QUALITY);
  const [resolutionDpi, setResolutionDpi] = useState(150);

  const [isProcessing, setIsProcessing] = useState(false);
  const [conversionProgress, setConversionProgress] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<GeneratedImage[]>([]);
  const [processingTime, setProcessingTime] = useState<number | null>(null);

  // Keep a ref mirror of the generated images so the unmount cleanup effect
  // always sees the latest set without needing `results` in its deps.
  useEffect(() => {
    resultsRef.current = results;
  }, [results]);

  // Revoke every remaining generated-image object URL on unmount.
  useEffect(() => {
    return () => {
      revokeGeneratedImages(resultsRef.current);
    };
  }, []);

  const resetOutput = () => {
    setResults((current) => {
      revokeGeneratedImages(current);
      return [];
    });
    setError(null);
    setProcessingTime(null);
  };

  const resetState = () => {
    previewRequestIdRef.current += 1;
    setSelectedFile(null);
    setThumbnails([]);
    setSelectionMode("all");
    setSelectedPages(new Set());
    resetOutput();
    setIsLoadingPreviews(false);
    setPreviewProgress("");
    enlargedPreviewRequestIdRef.current += 1;
    setEnlargedPreviewPage(null);
    setEnlargedPreviewDataUrl(null);
    setEnlargedPreviewStatus(null);
    setEnlargedPreviewError(null);
  };

  const loadPreviews = async (file: File) => {
    const requestId = ++previewRequestIdRef.current;

    setIsLoadingPreviews(true);
    setPreviewProgress("Loading page previews...");
    setThumbnails([]);

    try {
      const rendered = await renderPageThumbnails(file, {
        onProgress: (progress) => {
          if (requestId === previewRequestIdRef.current) {
            setPreviewProgress(
              `Rendering page ${progress.currentPage} of ${progress.pageCount}...`,
            );
          }
        },
      });

      if (requestId !== previewRequestIdRef.current) return;

      setThumbnails(rendered);
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
    setThumbnails([]);
    setSelectionMode("all");
    setSelectedPages(new Set());
    resetOutput();
    enlargedPreviewRequestIdRef.current += 1;
    setEnlargedPreviewPage(null);
    setEnlargedPreviewDataUrl(null);
    setEnlargedPreviewStatus(null);
    setEnlargedPreviewError(null);
    void loadPreviews(file);
  };

  const togglePageSelection = (pageNumber: number) => {
    resetOutput();
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

  // Opens the enlarged-preview modal for `page` and kicks off an on-demand,
  // higher-resolution render of just that page via `renderSinglePagePreview`
  // (see services/pdf/thumbnails.ts). The small thumbnail dataUrl already in
  // `page` is shown as a fallback only if this render fails; it is never
  // used as the enlarged image itself.
  const openEnlargedPreview = (page: PageThumbnail) => {
    // Remember whatever had focus (the clicked thumbnail button) so it can
    // be refocused when the modal closes.
    if (typeof document !== "undefined" && document.activeElement instanceof HTMLElement) {
      enlargedPreviewTriggerRef.current = document.activeElement;
    }

    // Bump the request id so any still-in-flight render for a previously
    // clicked page can no longer apply its result once it resolves.
    const requestId = ++enlargedPreviewRequestIdRef.current;

    setEnlargedPreviewPage(page);
    setEnlargedPreviewDataUrl(null);
    setEnlargedPreviewError(null);
    setEnlargedPreviewStatus("loading");

    if (!selectedFile) {
      setEnlargedPreviewStatus("error");
      setEnlargedPreviewError("No PDF is currently loaded.");
      return;
    }

    void renderSinglePagePreview(
      selectedFile,
      page.pageNumber,
      ENLARGED_PREVIEW_MAX_DIMENSION,
    )
      .then((preview) => {
        // A newer click (or a reset) has since invalidated this request.
        if (requestId !== enlargedPreviewRequestIdRef.current) return;

        setEnlargedPreviewDataUrl(preview.dataUrl);
        setEnlargedPreviewStatus("loaded");
      })
      .catch((previewError) => {
        console.error("Enlarged page preview error:", previewError);

        if (requestId !== enlargedPreviewRequestIdRef.current) return;

        setEnlargedPreviewStatus("error");
        setEnlargedPreviewError(
          previewError instanceof Error
            ? `Unable to render a high-resolution preview: ${previewError.message}`
            : "Unable to render a high-resolution preview for this page.",
        );
      });
  };

  const closeEnlargedPreview = () => {
    // Invalidate any render still in flight for the page being closed.
    enlargedPreviewRequestIdRef.current += 1;

    setEnlargedPreviewPage(null);
    setEnlargedPreviewDataUrl(null);
    setEnlargedPreviewStatus(null);
    setEnlargedPreviewError(null);

    const triggerElement = enlargedPreviewTriggerRef.current;
    enlargedPreviewTriggerRef.current = null;
    triggerElement?.focus();
  };

  const handleThumbnailClick = (page: PageThumbnail) => {
    togglePageSelection(page.pageNumber);
    openEnlargedPreview(page);
  };

  // Dismiss the enlarged preview with Escape while it's open.
  useEffect(() => {
    if (!enlargedPreviewPage) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeEnlargedPreview();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enlargedPreviewPage]);

  // Move keyboard focus into the dialog (onto its Close button) when it opens.
  useEffect(() => {
    if (enlargedPreviewPage) {
      enlargedPreviewCloseButtonRef.current?.focus();
    }
  }, [enlargedPreviewPage]);

  const handleConvert = async () => {
    if (isProcessingRef.current || !selectedFile) return;

    const pageNumbers =
      selectionMode === "all"
        ? undefined
        : Array.from(selectedPages).sort((a, b) => a - b);

    if (selectionMode === "selected" && (!pageNumbers || pageNumbers.length === 0)) {
      setError("Select at least one page to convert.");
      return;
    }

    isProcessingRef.current = true;
    setIsProcessing(true);
    setError(null);
    setConversionProgress("Starting conversion...");

    try {
      const conversionResult = await convertPdfToImages(selectedFile, {
        pageNumbers,
        format: outputFormat,
        quality: jpgQuality,
        scale: resolutionDpi / 72,
        onProgress: (progress) => {
          setConversionProgress(
            `Converting page ${progress.currentPage} of ${progress.pageCount}...`,
          );
        },
      });

      const generated: GeneratedImage[] = conversionResult.pages.map((page) => {
        const blob = new Blob([page.bytes as BlobPart], {
          type: mimeForFormat(page.format),
        });

        return { ...page, previewUrl: URL.createObjectURL(blob) };
      });

      setResults((current) => {
        revokeGeneratedImages(current);
        return generated;
      });
      setProcessingTime(conversionResult.processingTime);
    } catch (conversionError) {
      console.error("PDF to image error:", conversionError);
      setError(
        conversionError instanceof Error
          ? `Conversion failed: ${conversionError.message}`
          : "Failed to convert this PDF to images.",
      );
    } finally {
      isProcessingRef.current = false;
      setIsProcessing(false);
      setConversionProgress("");
    }
  };

  const handleDownloadAll = () => {
    if (!selectedFile) return;

    // No ZIP library exists in this project's dependencies, so — per the
    // same approach SplitPdfCard already uses — "Download All" triggers
    // individual downloads in sequence rather than bundling a .zip.
    results.forEach((image, index) => {
      setTimeout(() => {
        downloadImageBytes(
          image.bytes,
          getPageImageFilename(selectedFile.name, image.pageNumber, image.format),
          image.format,
        );
      }, index * 300);
    });
  };

  const selectedCount = selectedPages.size;
  const canConvert =
    selectedFile !== null &&
    !isLoadingPreviews &&
    !isProcessing &&
    (selectionMode === "all" || selectedCount > 0);

  // While a PDF's page previews are loading or a conversion is in flight,
  // the upload area must reject new files/drops so the in-progress work
  // can't be interrupted or replaced out from under itself.
  const uploadDisabled = isProcessing || isLoadingPreviews;

  const selectClasses =
    "mt-2 w-full rounded-lg border border-gray-300 px-4 py-2.5 text-sm text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20 disabled:bg-gray-50 disabled:text-gray-400";
  const labelClasses = "block text-sm font-medium text-gray-700";

  return (
    <div className="w-full max-w-2xl mx-auto px-4 sm:px-6">
      <div className="bg-white rounded-2xl shadow-lg border border-gray-100 overflow-hidden">
        <div className="px-4 sm:px-6 pt-6 sm:pt-8">
          <h2 className="text-xl font-bold text-gray-900">PDF to Image</h2>
          <p className="mt-1 text-sm text-gray-500">
            Convert PDF pages into JPG or PNG images, one image per page.
          </p>
        </div>

        <UploadZone
          accept=".pdf,application/pdf"
          title="Choose a PDF to convert"
          helperText="or drag and drop it here · PDF files only"
          onFileSelect={(file) => void selectFile(file)}
          disabled={uploadDisabled}
          className="mx-4 sm:mx-6 mt-6 mb-4"
        />

        <div className="px-4 sm:px-6 pb-6">
          {selectedFile && (
            <div className="rounded-lg bg-gray-50 border border-gray-200 px-4 py-3">
              <p className="text-sm font-medium text-gray-800 truncate">
                {selectedFile.name}
              </p>
              <p className="mt-1 text-sm text-gray-500">
                {thumbnails.length > 0
                  ? `${thumbnails.length} page${thumbnails.length === 1 ? "" : "s"} \u00b7 ${formatFileSize(selectedFile.size)}`
                  : formatFileSize(selectedFile.size)}
              </p>
            </div>
          )}

          {isLoadingPreviews && (
            <p className="mt-4 text-sm font-medium text-gray-500">
              {previewProgress}
            </p>
          )}
          {error && (
            <p role="alert" className="mt-4 text-sm font-medium text-red-600">
              {error}
            </p>
          )}

          {thumbnails.length > 0 && (
            <>
              {/* PAGE SELECTION */}
              <div className="mt-6">
                <p className={labelClasses}>Pages to convert</p>
                <div className="mt-2 flex gap-3">
                  <label className="flex items-center gap-2 text-sm text-gray-700">
                    <input
                      type="radio"
                      name="pdf-to-image-selection-mode"
                      checked={selectionMode === "all"}
                      disabled={isProcessing}
                      onChange={() => {
                        resetOutput();
                        setSelectionMode("all");
                      }}
                    />
                    All pages ({thumbnails.length})
                  </label>
                  <label className="flex items-center gap-2 text-sm text-gray-700">
                    <input
                      type="radio"
                      name="pdf-to-image-selection-mode"
                      checked={selectionMode === "selected"}
                      disabled={isProcessing}
                      onChange={() => {
                        resetOutput();
                        setSelectionMode("selected");
                      }}
                    />
                    Selected pages
                  </label>
                </div>

                <p className="mt-2 text-xs text-gray-500">
                  {selectionMode === "all"
                    ? `All ${thumbnails.length} page${thumbnails.length === 1 ? "" : "s"} will be converted`
                    : selectedCount > 0
                      ? `${selectedCount} page${selectedCount === 1 ? "" : "s"} selected \u00b7 ${selectedCount} image${selectedCount === 1 ? "" : "s"} will be created`
                      : "Select at least one page below"}
                </p>

                {selectionMode === "selected" && (
                  <>
                    <div className="mt-2 flex items-center justify-between">
                      <p className="text-xs text-gray-500">
                        {selectedCount} page{selectedCount === 1 ? "" : "s"}{" "}
                        selected
                      </p>
                      {selectedCount > 0 && (
                        <button
                          type="button"
                          onClick={() => {
                            resetOutput();
                            setSelectedPages(new Set());
                          }}
                          disabled={isProcessing}
                          className="text-xs font-medium text-blue-600 hover:text-blue-700 disabled:text-gray-400"
                        >
                          Clear selection
                        </button>
                      )}
                    </div>

                    <div className="mt-3">
                      <PageThumbnailGrid
                        pages={thumbnails}
                        isSelected={(page) => selectedPages.has(page.pageNumber)}
                        onPageClick={handleThumbnailClick}
                        disabled={isProcessing}
                      />
                    </div>
                  </>
                )}
              </div>

              {/* OUTPUT SETTINGS */}
              <div className="mt-6 rounded-xl border border-gray-200 p-4">
                <p className="text-sm font-semibold text-gray-800">
                  Output settings
                </p>

                <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label htmlFor="pdf-to-image-format" className={labelClasses}>
                      Format
                    </label>
                    <select
                      id="pdf-to-image-format"
                      value={outputFormat}
                      disabled={isProcessing}
                      onChange={(event) => {
                        resetOutput();
                        setOutputFormat(event.target.value as ImageOutputFormat);
                      }}
                      className={selectClasses}
                    >
                      {FORMAT_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                    <p className="mt-1 text-xs text-gray-500">
                      {outputFormat === "jpg"
                        ? "JPG \u2014 smaller files, adjustable quality."
                        : "PNG \u2014 lossless image quality, larger files."}
                    </p>
                  </div>

                  <div>
                    <label
                      htmlFor="pdf-to-image-resolution"
                      className={labelClasses}
                    >
                      Resolution
                    </label>
                    <select
                      id="pdf-to-image-resolution"
                      value={resolutionDpi}
                      disabled={isProcessing}
                      onChange={(event) => {
                        resetOutput();
                        setResolutionDpi(Number(event.target.value));
                      }}
                      className={selectClasses}
                    >
                      {RESOLUTION_OPTIONS.map((option) => (
                        <option key={option.dpi} value={option.dpi}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                    <p className="mt-1 text-xs text-gray-500">
                      Lower resolution means a smaller, faster file; higher
                      resolution means more detail and a larger file.
                    </p>
                  </div>
                </div>

                {outputFormat === "jpg" && (
                  <div className="mt-4">
                    <label htmlFor="pdf-to-image-quality" className={labelClasses}>
                      JPG quality ({Math.round(jpgQuality * 100)}%)
                    </label>
                    <input
                      id="pdf-to-image-quality"
                      type="range"
                      min={0.5}
                      max={1}
                      step={0.05}
                      value={jpgQuality}
                      disabled={isProcessing}
                      onChange={(event) => {
                        resetOutput();
                        setJpgQuality(Number(event.target.value));
                      }}
                      className="mt-2 w-full accent-blue-600 disabled:opacity-50"
                    />
                  </div>
                )}
              </div>
            </>
          )}

          {isProcessing && conversionProgress && (
            <p className="mt-4 text-sm font-medium text-gray-500">
              {conversionProgress}
            </p>
          )}

          {processingTime !== null && (
            <p className="mt-2 text-sm text-gray-500">
              Completed in {(processingTime / 1000).toFixed(2)}s.
            </p>
          )}

          <button
            type="button"
            onClick={handleConvert}
            disabled={!canConvert}
            aria-busy={isProcessing}
            className={`mt-6 flex w-full items-center justify-center rounded-lg px-4 py-3 text-sm font-semibold transition-colors ${
              canConvert
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
            {isProcessing ? "Converting..." : "Convert to Images"}
          </button>

        </div>

        {results.length > 0 && selectedFile && (
          <ResultPanel
            icon="✓"
            title="Your images are ready"
            message={`${results.length} image${results.length === 1 ? "" : "s"} \u00b7 ${outputFormat.toUpperCase()} \u00b7 ${resolutionDpi} DPI${
              processingTime !== null ? ` \u00b7 ${(processingTime / 1000).toFixed(2)}s` : ""
            }`}
            stats={[
              { label: "Images", value: results.length },
              { label: "Format", value: outputFormat.toUpperCase() },
              { label: "Resolution", value: `${resolutionDpi} DPI` },
              ...(processingTime !== null
                ? [{ label: "Processing time", value: `${(processingTime / 1000).toFixed(2)}s` }]
                : []),
            ]}
            onDownload={
              results.length > 1
                ? handleDownloadAll
                : () => {
                    const [onlyImage] = results;
                    if (!onlyImage) return;
                    downloadImageBytes(
                      onlyImage.bytes,
                      getPageImageFilename(
                        selectedFile.name,
                        onlyImage.pageNumber,
                        onlyImage.format,
                      ),
                      onlyImage.format,
                    );
                  }
            }
            downloadLabel={
              results.length > 1
                ? `Download all ${results.length} images`
                : "Download image"
            }
            onReset={resetState}
            resetLabel="Convert another PDF"
          >
            {results.length > 1 && (
              <p className="mb-3 text-xs text-gray-500">
                This downloads {results.length} separate image files one after
                another — not a single .zip.
              </p>
            )}

            <div className="mb-4 grid grid-cols-2 sm:grid-cols-3 gap-3">
              {results.map((image) => (
                <div
                  key={image.pageNumber}
                  className="flex flex-col rounded-lg border border-gray-200 bg-white p-2"
                >
                  <span className="flex h-28 w-full items-center justify-center overflow-hidden rounded bg-gray-50">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={image.previewUrl}
                      alt={`Page ${image.pageNumber} image preview`}
                      className="max-h-full max-w-full object-contain"
                    />
                  </span>
                  <p className="mt-2 truncate text-center text-xs font-semibold text-gray-700">
                    Page {image.pageNumber}
                  </p>
                  <p className="text-center text-xs text-gray-500">
                    {image.width}×{image.height} ·{" "}
                    {(image.bytes.byteLength / 1024).toFixed(1)} KB
                  </p>
                  <button
                    type="button"
                    aria-label={`Download page ${image.pageNumber} image`}
                    title={`Download page ${image.pageNumber}`}
                    onClick={() =>
                      downloadImageBytes(
                        image.bytes,
                        getPageImageFilename(
                          selectedFile.name,
                          image.pageNumber,
                          image.format,
                        ),
                        image.format,
                      )
                    }
                    className="mt-2 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-blue-700"
                  >
                    Download
                  </button>
                </div>
              ))}
            </div>
          </ResultPanel>
        )}
      </div>

      {enlargedPreviewPage && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4"
          onClick={closeEnlargedPreview}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="pdf-to-image-enlarged-preview-title"
            onClick={(event) => event.stopPropagation()}
            className="relative w-full max-w-lg rounded-2xl bg-white p-4 shadow-xl"
          >
            <div className="flex items-center justify-between">
              <h3
                id="pdf-to-image-enlarged-preview-title"
                className="text-sm font-semibold text-gray-800"
              >
                Page {enlargedPreviewPage.pageNumber} preview
              </h3>
              <button
                ref={enlargedPreviewCloseButtonRef}
                type="button"
                onClick={closeEnlargedPreview}
                aria-label="Close page preview"
                className="rounded-full p-1.5 text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-700"
              >
                <svg
                  className="h-5 w-5"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  aria-hidden="true"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <div className="mt-3 flex min-h-[200px] items-center justify-center rounded-lg bg-gray-50 p-2">
              {enlargedPreviewStatus === "loading" && (
                <div className="flex flex-col items-center gap-2 py-12">
                  <svg
                    className="h-6 w-6 animate-spin text-gray-400"
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
                  <p className="text-sm text-gray-500">
                    Rendering high-resolution preview...
                  </p>
                </div>
              )}

              {enlargedPreviewStatus === "loaded" && enlargedPreviewDataUrl && (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={enlargedPreviewDataUrl}
                  alt={`Page ${enlargedPreviewPage.pageNumber} enlarged preview`}
                  className="max-h-[70vh] w-auto max-w-full object-contain"
                />
              )}

              {enlargedPreviewStatus === "error" && (
                <div className="flex flex-col items-center gap-3 py-6 text-center">
                  <p className="text-sm font-medium text-red-600">
                    {enlargedPreviewError ??
                      "Unable to render a high-resolution preview for this page."}
                  </p>
                  {enlargedPreviewPage.dataUrl ? (
                    <>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={enlargedPreviewPage.dataUrl}
                        alt={`Page ${enlargedPreviewPage.pageNumber} lower-resolution preview`}
                        className="max-h-[50vh] w-auto max-w-full object-contain"
                      />
                      <p className="text-xs text-gray-500">
                        Showing the lower-resolution thumbnail instead.
                      </p>
                    </>
                  ) : (
                    <p className="text-xs text-gray-500">
                      No preview is available for this page.
                    </p>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
