"use client";

import { useEffect, useRef, useState } from "react";
import {
  convertPdfToImages,
  type ImageOutputFormat,
  type PdfToImagePageResult,
} from "../services/pdf/pdfToImage";
import { renderPageThumbnails, type PageThumbnail } from "../services/pdf/thumbnails";
import PageThumbnailGrid from "./PageThumbnailGrid";

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

export default function PdfToImageCard() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const isProcessingRef = useRef(false);
  const previewRequestIdRef = useRef(0);
  const resultsRef = useRef<GeneratedImage[]>([]);

  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [thumbnails, setThumbnails] = useState<PageThumbnail[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [isLoadingPreviews, setIsLoadingPreviews] = useState(false);
  const [previewProgress, setPreviewProgress] = useState("");

  const [selectionMode, setSelectionMode] = useState<"all" | "selected">("all");
  const [selectedPages, setSelectedPages] = useState<Set<number>>(new Set());

  const [outputFormat, setOutputFormat] = useState<ImageOutputFormat>("jpg");
  const [jpgQuality, setJpgQuality] = useState(DEFAULT_JPG_QUALITY);
  const [resolutionDpi, setResolutionDpi] = useState(150);

  const [isProcessing, setIsProcessing] = useState(false);
  const [conversionProgress, setConversionProgress] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
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
    setSuccessMessage(null);
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

    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
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
    setSuccessMessage(null);
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
      setSuccessMessage(
        `Converted ${generated.length} page${
          generated.length === 1 ? "" : "s"
        } to ${outputFormat.toUpperCase()}.`,
      );
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
            Choose a PDF to convert
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
                        onPageClick={(page) => togglePageSelection(page.pageNumber)}
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
            className={`mt-6 w-full rounded-lg px-4 py-3 text-sm font-semibold transition-colors ${
              canConvert
                ? "bg-blue-600 text-white hover:bg-blue-700"
                : "bg-gray-200 text-gray-400 cursor-not-allowed"
            }`}
          >
            {isProcessing ? "Converting..." : "Convert to Images"}
          </button>

          {results.length > 0 && selectedFile && (
            <div className="mt-6">
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium text-gray-700">
                  {results.length} image{results.length === 1 ? "" : "s"} ready
                </p>
                {results.length > 1 && (
                  <button
                    type="button"
                    onClick={handleDownloadAll}
                    className="text-sm font-medium text-blue-600 hover:text-blue-700"
                  >
                    Download all
                  </button>
                )}
              </div>

              <div className="mt-3 grid grid-cols-2 sm:grid-cols-3 gap-3">
                {results.map((image) => (
                  <div
                    key={image.pageNumber}
                    className="flex flex-col rounded-lg border border-gray-200 bg-gray-50 p-2"
                  >
                    <span className="flex h-28 w-full items-center justify-center overflow-hidden rounded bg-white">
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
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
