"use client";

import { useRef, useState } from "react";
import { parsePageSelection } from "../services/pdf/extract";
import {
  applyWatermarkAndPageNumbers,
  getWatermarkTargetPageCount,
  PAGE_NUMBER_DEFAULTS,
  WATERMARK_DEFAULTS,
  type PageNumberConfig,
  type PageNumberFormat,
  type PageNumberPosition,
  type PageRangeMode,
  type WatermarkConfig,
  type WatermarkPageNumbersResult,
  type WatermarkPosition,
  type WatermarkRotationDegrees,
} from "../services/pdf/watermark";
import PdfWatermarkPreview from "./PdfWatermarkPreview";
import { formatFileSize } from "./ResultCard";
import ResultPanel from "./ResultPanel";

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

function getResultFilename(
  originalName: string,
  watermarkApplied: boolean,
  pageNumbersApplied: boolean,
): string {
  const base = originalName.toLowerCase().endsWith(".pdf")
    ? originalName.slice(0, -4)
    : originalName;

  if (watermarkApplied && pageNumbersApplied) {
    return `${base}-watermarked-numbered.pdf`;
  }

  if (watermarkApplied) {
    return `${base}-watermarked.pdf`;
  }

  return `${base}-numbered.pdf`;
}

const WATERMARK_POSITIONS: { value: WatermarkPosition; label: string }[] = [
  { value: "top-left", label: "Top Left" },
  { value: "top-center", label: "Top Center" },
  { value: "top-right", label: "Top Right" },
  { value: "center", label: "Center" },
  { value: "bottom-left", label: "Bottom Left" },
  { value: "bottom-center", label: "Bottom Center" },
  { value: "bottom-right", label: "Bottom Right" },
];

const PAGE_NUMBER_POSITIONS: { value: PageNumberPosition; label: string }[] = [
  { value: "bottom-left", label: "Bottom Left" },
  { value: "bottom-center", label: "Bottom Center" },
  { value: "bottom-right", label: "Bottom Right" },
  { value: "top-left", label: "Top Left" },
  { value: "top-center", label: "Top Center" },
  { value: "top-right", label: "Top Right" },
];

const ROTATION_OPTIONS: { value: WatermarkRotationDegrees; label: string }[] = [
  { value: 0, label: "0°" },
  { value: 45, label: "45°" },
  { value: -45, label: "-45°" },
];

const FORMAT_OPTIONS: { value: PageNumberFormat; label: string }[] = [
  { value: "number", label: '"1"' },
  { value: "page-number", label: '"Page 1"' },
  { value: "page-number-of-total", label: '"Page 1 of N"' },
];

export default function WatermarkPdfCard() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const isProcessingRef = useRef(false);

  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [pageCount, setPageCount] = useState<number | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isReading, setIsReading] = useState(false);

  const [watermarkEnabled, setWatermarkEnabled] = useState(
    WATERMARK_DEFAULTS.enabled,
  );
  const [watermarkText, setWatermarkText] = useState(WATERMARK_DEFAULTS.text);
  const [watermarkPosition, setWatermarkPosition] = useState<WatermarkPosition>(
    WATERMARK_DEFAULTS.position,
  );
  const [watermarkRotation, setWatermarkRotation] =
    useState<WatermarkRotationDegrees>(WATERMARK_DEFAULTS.rotation);
  const [watermarkOpacityPercent, setWatermarkOpacityPercent] = useState(
    Math.round(WATERMARK_DEFAULTS.opacity * 100),
  );
  const [watermarkFontSize, setWatermarkFontSize] = useState(
    WATERMARK_DEFAULTS.fontSize,
  );

  const [pageNumbersEnabled, setPageNumbersEnabled] = useState(
    PAGE_NUMBER_DEFAULTS.enabled,
  );
  const [pageNumberFormat, setPageNumberFormat] = useState<PageNumberFormat>(
    PAGE_NUMBER_DEFAULTS.format,
  );
  const [pageNumberPosition, setPageNumberPosition] =
    useState<PageNumberPosition>(PAGE_NUMBER_DEFAULTS.position);
  const [startingNumberInput, setStartingNumberInput] = useState(
    String(PAGE_NUMBER_DEFAULTS.startingNumber),
  );
  const [pageNumberFontSize, setPageNumberFontSize] = useState(
    PAGE_NUMBER_DEFAULTS.fontSize,
  );
  const [pageRangeMode, setPageRangeMode] = useState<PageRangeMode>(
    PAGE_NUMBER_DEFAULTS.pageRange,
  );
  const [pageSelectionInput, setPageSelectionInput] = useState(
    PAGE_NUMBER_DEFAULTS.pageSelection,
  );

  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<WatermarkPageNumbersResult | null>(null);

  // Upload and configuration must stay locked while an operation is
  // in-flight, so the output can't change out from under it.
  const uploadDisabled = isReading || isProcessing;

  const resetOutput = () => {
    setResult(null);
    setError(null);
  };

  const selectFile = async (file: File | undefined) => {
    if (uploadDisabled || !file) return;

    if (!isPdfFile(file)) {
      setSelectedFile(null);
      setPageCount(null);
      setError("Please select a valid PDF file.");
      setResult(null);
      return;
    }

    setSelectedFile(file);
    setPageCount(null);
    resetOutput();
    setIsReading(true);

    try {
      const count = await getWatermarkTargetPageCount(file);
      setPageCount(count);
    } catch (readError) {
      console.error("PDF read error:", readError);
      setSelectedFile(null);
      setError(
        readError instanceof Error
          ? readError.message
          : "Unable to read this PDF.",
      );
    } finally {
      setIsReading(false);
    }
  };

  // Live validation of the "selected pages" input, without touching bytes.
  let selectedPagesPreview: number[] | null = null;
  let pageSelectionError: string | null = null;

  if (
    pageNumbersEnabled &&
    pageRangeMode === "selected" &&
    pageCount !== null &&
    pageSelectionInput.trim() !== ""
  ) {
    try {
      selectedPagesPreview = parsePageSelection(pageSelectionInput, pageCount);
    } catch (parseError) {
      pageSelectionError =
        parseError instanceof Error
          ? parseError.message
          : "Invalid page selection.";
    }
  }

  const startingNumber = Number(startingNumberInput);
  const isStartingNumberValid =
    /^\d+$/.test(startingNumberInput.trim()) &&
    Number.isInteger(startingNumber) &&
    startingNumber >= 1;

  const numberedPageCountPreview =
    pageRangeMode === "all"
      ? pageCount ?? 0
      : selectedPagesPreview?.length ?? 0;
  const lastPageNumberPreview =
    startingNumber + numberedPageCountPreview - 1;

  const pageNumberPreviewLabel = (() => {
    if (!pageNumbersEnabled || numberedPageCountPreview === 0) return null;

    switch (pageNumberFormat) {
      case "number":
        return String(startingNumber);
      case "page-number":
        return `Page ${startingNumber}`;
      case "page-number-of-total":
        return `Page ${startingNumber} of ${lastPageNumberPreview}`;
    }
  })();

  const canApply =
    selectedFile !== null &&
    pageCount !== null &&
    !isReading &&
    !isProcessing &&
    (watermarkEnabled || pageNumbersEnabled) &&
    (!watermarkEnabled || watermarkText.trim() !== "") &&
    (!pageNumbersEnabled || isStartingNumberValid) &&
    (!pageNumbersEnabled ||
      pageRangeMode === "all" ||
      (selectedPagesPreview !== null && pageSelectionError === null));

  const handleApply = async () => {
    if (isProcessingRef.current || !canApply || !selectedFile) return;

    isProcessingRef.current = true;
    setIsProcessing(true);
    setError(null);
    setResult(null);

    const watermarkConfig: WatermarkConfig = {
      enabled: watermarkEnabled,
      text: watermarkText,
      position: watermarkPosition,
      rotation: watermarkRotation,
      opacity: watermarkOpacityPercent / 100,
      fontSize: watermarkFontSize,
    };

    const pageNumberConfig: PageNumberConfig = {
      enabled: pageNumbersEnabled,
      format: pageNumberFormat,
      position: pageNumberPosition,
      startingNumber,
      fontSize: pageNumberFontSize,
      pageRange: pageRangeMode,
      pageSelection: pageSelectionInput,
    };

    try {
      const applyResult = await applyWatermarkAndPageNumbers(
        selectedFile,
        watermarkConfig,
        pageNumberConfig,
      );

      setResult(applyResult);
      downloadPdfBytes(
        applyResult.bytes,
        getResultFilename(
          selectedFile.name,
          applyResult.watermarkApplied,
          applyResult.pageNumbersApplied,
        ),
      );
    } catch (applyError) {
      console.error("Watermark/page numbers error:", applyError);
      setError(
        applyError instanceof Error
          ? applyError.message
          : "Failed to apply watermark and page numbers.",
      );
    } finally {
      isProcessingRef.current = false;
      setIsProcessing(false);
    }
  };

  /**
   * Clears the current file, restores the watermark/page-number
   * configuration to its established defaults, and clears the result so a
   * different PDF can be configured from a clean slate.
   */
  const handleApplyToAnother = () => {
    setSelectedFile(null);
    setPageCount(null);
    setIsDragging(false);
    setIsReading(false);
    setIsProcessing(false);
    isProcessingRef.current = false;

    setWatermarkEnabled(WATERMARK_DEFAULTS.enabled);
    setWatermarkText(WATERMARK_DEFAULTS.text);
    setWatermarkPosition(WATERMARK_DEFAULTS.position);
    setWatermarkRotation(WATERMARK_DEFAULTS.rotation);
    setWatermarkOpacityPercent(Math.round(WATERMARK_DEFAULTS.opacity * 100));
    setWatermarkFontSize(WATERMARK_DEFAULTS.fontSize);

    setPageNumbersEnabled(PAGE_NUMBER_DEFAULTS.enabled);
    setPageNumberFormat(PAGE_NUMBER_DEFAULTS.format);
    setPageNumberPosition(PAGE_NUMBER_DEFAULTS.position);
    setStartingNumberInput(String(PAGE_NUMBER_DEFAULTS.startingNumber));
    setPageNumberFontSize(PAGE_NUMBER_DEFAULTS.fontSize);
    setPageRangeMode(PAGE_NUMBER_DEFAULTS.pageRange);
    setPageSelectionInput(PAGE_NUMBER_DEFAULTS.pageSelection);

    resetOutput();

    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  const inputClasses =
    "mt-2 w-full rounded-lg border border-gray-300 px-4 py-2.5 text-sm text-gray-900 placeholder:text-gray-400 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20 disabled:bg-gray-50 disabled:text-gray-400";
  const labelClasses = "block text-sm font-medium text-gray-700";

  return (
    <div className="w-full max-w-2xl mx-auto px-4 sm:px-6">
      <div className="bg-white rounded-2xl shadow-lg border border-gray-100 overflow-hidden">
        <input
          ref={fileInputRef}
          type="file"
          accept=".pdf,application/pdf"
          className="hidden"
          disabled={uploadDisabled}
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
          className={`mx-4 sm:mx-6 mt-6 flex flex-col items-center justify-center rounded-xl border-2 border-dashed px-6 py-10 transition-colors ${
            uploadDisabled
              ? "cursor-not-allowed border-gray-200 bg-gray-50 opacity-60"
              : isDragging
                ? "cursor-pointer border-blue-500 bg-blue-50"
                : "cursor-pointer border-gray-300 bg-gray-50 hover:border-blue-400 hover:bg-blue-50/50"
          }`}
        >
          <p className="text-base font-medium text-gray-800 text-center">
            Choose a PDF to edit
          </p>
          <p className="mt-1 text-sm text-gray-500">or drag and drop it here</p>
        </div>

        <div className="px-4 sm:px-6 pb-6">
          {selectedFile && (
            <div className="mt-4 min-w-0 rounded-lg bg-gray-50 border border-gray-200 px-4 py-3">
              <p className="text-sm font-medium text-gray-800 truncate">
                {selectedFile.name}
              </p>
              <p className="mt-1 text-sm text-gray-500">
                {isReading
                  ? "Reading PDF..."
                  : pageCount !== null
                    ? `${pageCount} page${pageCount === 1 ? "" : "s"} · ${formatFileSize(selectedFile.size)}`
                    : formatFileSize(selectedFile.size)}
              </p>
            </div>
          )}

          {isReading && (
            <p
              className="mt-4 text-sm font-medium text-gray-600"
              role="status"
              aria-live="polite"
            >
              Reading your PDF...
            </p>
          )}

          {selectedFile && !isReading && pageCount !== null && (
            <>
              {/* LIVE PREVIEW */}
              <div className="mt-6">
                <p className="text-sm font-semibold text-gray-800">
                  Live Preview
                </p>
                <p className="mt-1 text-xs text-gray-500">
                  Preview shows how your watermark and page numbers will
                  appear on the PDF.
                </p>

                <div className="mt-3 rounded-xl border border-gray-200 bg-gray-50 p-4">
                  <PdfWatermarkPreview
                    file={selectedFile!}
                    pageCount={pageCount!}
                    watermarkEnabled={watermarkEnabled}
                    watermarkText={watermarkText}
                    watermarkPosition={watermarkPosition}
                    watermarkRotation={watermarkRotation}
                    watermarkOpacity={watermarkOpacityPercent / 100}
                    watermarkFontSize={watermarkFontSize}
                    pageNumbersEnabled={pageNumbersEnabled}
                    pageNumberFormat={pageNumberFormat}
                    pageNumberPosition={pageNumberPosition}
                    startingNumber={startingNumber}
                    pageNumberFontSize={pageNumberFontSize}
                    pageRangeMode={pageRangeMode}
                    selectedPagesPreview={selectedPagesPreview}
                  />
                </div>
              </div>

              {/* WATERMARK */}
              <div
                className={`mt-6 rounded-xl border p-4 transition-colors ${
                  watermarkEnabled
                    ? "border-gray-200"
                    : "border-gray-100 bg-gray-50/60"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <label className="flex items-center gap-2 text-sm font-semibold text-gray-800">
                    <input
                      type="checkbox"
                      checked={watermarkEnabled}
                      disabled={isProcessing}
                      onChange={(event) => {
                        resetOutput();
                        setWatermarkEnabled(event.target.checked);
                      }}
                      className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                    />
                    Watermark
                  </label>
                  <span
                    className={`text-xs font-medium ${
                      watermarkEnabled ? "text-blue-600" : "text-gray-400"
                    }`}
                  >
                    {watermarkEnabled ? "Enabled" : "Disabled"}
                  </span>
                </div>

                {watermarkEnabled && (
                  <div className="mt-4 space-y-4">
                    <div>
                      <label htmlFor="watermark-text" className={labelClasses}>
                        Watermark text
                      </label>
                      <input
                        id="watermark-text"
                        type="text"
                        value={watermarkText}
                        disabled={isProcessing}
                        onChange={(event) => {
                          resetOutput();
                          setWatermarkText(event.target.value);
                        }}
                        placeholder="e.g. CONFIDENTIAL"
                        className={inputClasses}
                      />
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <div>
                        <label htmlFor="watermark-position" className={labelClasses}>
                          Position
                        </label>
                        <select
                          id="watermark-position"
                          value={watermarkPosition}
                          disabled={isProcessing}
                          onChange={(event) => {
                            resetOutput();
                            setWatermarkPosition(
                              event.target.value as WatermarkPosition,
                            );
                          }}
                          className={inputClasses}
                        >
                          {WATERMARK_POSITIONS.map((option) => (
                            <option key={option.value} value={option.value}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                      </div>

                      <div>
                        <label htmlFor="watermark-rotation" className={labelClasses}>
                          Rotation
                        </label>
                        <select
                          id="watermark-rotation"
                          value={watermarkRotation}
                          disabled={isProcessing}
                          onChange={(event) => {
                            resetOutput();
                            setWatermarkRotation(
                              Number(event.target.value) as WatermarkRotationDegrees,
                            );
                          }}
                          className={inputClasses}
                        >
                          {ROTATION_OPTIONS.map((option) => (
                            <option key={option.value} value={option.value}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                        <p className="mt-1 text-xs text-gray-500">
                          Choose the angle used for the watermark text.
                        </p>
                      </div>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <div>
                        <label htmlFor="watermark-opacity" className={labelClasses}>
                          Opacity: {watermarkOpacityPercent}%
                        </label>
                        <input
                          id="watermark-opacity"
                          type="range"
                          min={10}
                          max={100}
                          step={5}
                          value={watermarkOpacityPercent}
                          disabled={isProcessing}
                          onChange={(event) => {
                            resetOutput();
                            setWatermarkOpacityPercent(Number(event.target.value));
                          }}
                          className="mt-4 w-full accent-blue-600"
                        />
                        <p className="mt-1 text-xs text-gray-500">
                          Controls how transparent the watermark appears.
                        </p>
                      </div>

                      <div>
                        <label htmlFor="watermark-font-size" className={labelClasses}>
                          Font size
                        </label>
                        <input
                          id="watermark-font-size"
                          type="number"
                          min={6}
                          max={200}
                          value={watermarkFontSize}
                          disabled={isProcessing}
                          onChange={(event) => {
                            resetOutput();
                            setWatermarkFontSize(Number(event.target.value));
                          }}
                          className={inputClasses}
                        />
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* PAGE NUMBERS */}
              <div
                className={`mt-4 rounded-xl border p-4 transition-colors ${
                  pageNumbersEnabled
                    ? "border-gray-200"
                    : "border-gray-100 bg-gray-50/60"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <label className="flex items-center gap-2 text-sm font-semibold text-gray-800">
                    <input
                      type="checkbox"
                      checked={pageNumbersEnabled}
                      disabled={isProcessing}
                      onChange={(event) => {
                        resetOutput();
                        setPageNumbersEnabled(event.target.checked);
                      }}
                      className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                    />
                    Page numbers
                  </label>
                  <span
                    className={`text-xs font-medium ${
                      pageNumbersEnabled ? "text-blue-600" : "text-gray-400"
                    }`}
                  >
                    {pageNumbersEnabled ? "Enabled" : "Disabled"}
                  </span>
                </div>

                {pageNumbersEnabled && (
                  <div className="mt-4 space-y-4">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <div>
                        <label htmlFor="page-number-format" className={labelClasses}>
                          Format
                        </label>
                        <select
                          id="page-number-format"
                          value={pageNumberFormat}
                          disabled={isProcessing}
                          onChange={(event) => {
                            resetOutput();
                            setPageNumberFormat(
                              event.target.value as PageNumberFormat,
                            );
                          }}
                          className={inputClasses}
                        >
                          {FORMAT_OPTIONS.map((option) => (
                            <option key={option.value} value={option.value}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                      </div>

                      <div>
                        <label htmlFor="page-number-position" className={labelClasses}>
                          Position
                        </label>
                        <select
                          id="page-number-position"
                          value={pageNumberPosition}
                          disabled={isProcessing}
                          onChange={(event) => {
                            resetOutput();
                            setPageNumberPosition(
                              event.target.value as PageNumberPosition,
                            );
                          }}
                          className={inputClasses}
                        >
                          {PAGE_NUMBER_POSITIONS.map((option) => (
                            <option key={option.value} value={option.value}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <div>
                        <label htmlFor="page-number-start" className={labelClasses}>
                          Starting number
                        </label>
                        <input
                          id="page-number-start"
                          type="text"
                          inputMode="numeric"
                          value={startingNumberInput}
                          disabled={isProcessing}
                          aria-invalid={
                            !isStartingNumberValid &&
                            startingNumberInput.trim() !== ""
                              ? true
                              : undefined
                          }
                          onChange={(event) => {
                            resetOutput();
                            setStartingNumberInput(event.target.value);
                          }}
                          placeholder="1"
                          className={inputClasses}
                        />
                        {!isStartingNumberValid &&
                          startingNumberInput.trim() !== "" && (
                            <p
                              role="alert"
                              className="mt-1 text-xs font-medium text-amber-600"
                            >
                              Must be a whole number of 1 or greater.
                            </p>
                          )}
                      </div>

                      <div>
                        <label htmlFor="page-number-font-size" className={labelClasses}>
                          Font size
                        </label>
                        <input
                          id="page-number-font-size"
                          type="number"
                          min={6}
                          max={200}
                          value={pageNumberFontSize}
                          disabled={isProcessing}
                          onChange={(event) => {
                            resetOutput();
                            setPageNumberFontSize(Number(event.target.value));
                          }}
                          className={inputClasses}
                        />
                      </div>
                    </div>

                    <div>
                      <p className={labelClasses}>Page range</p>
                      <p className="mt-1 text-xs text-gray-500">
                        Apply page numbers to every page or only selected
                        pages.
                      </p>
                      <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:gap-6">
                        <label className="flex items-center gap-2 text-sm text-gray-700">
                          <input
                            type="radio"
                            name="page-range"
                            checked={pageRangeMode === "all"}
                            disabled={isProcessing}
                            onChange={() => {
                              resetOutput();
                              setPageRangeMode("all");
                            }}
                            className="h-4 w-4 border-gray-300 text-blue-600 focus:ring-blue-500"
                          />
                          All pages
                        </label>
                        <label className="flex items-center gap-2 text-sm text-gray-700">
                          <input
                            type="radio"
                            name="page-range"
                            checked={pageRangeMode === "selected"}
                            disabled={isProcessing}
                            onChange={() => {
                              resetOutput();
                              setPageRangeMode("selected");
                            }}
                            className="h-4 w-4 border-gray-300 text-blue-600 focus:ring-blue-500"
                          />
                          Selected pages
                        </label>
                      </div>

                      {pageRangeMode === "selected" && (
                        <>
                          <label htmlFor="page-selection" className="sr-only">
                            Selected pages
                          </label>
                          <input
                            id="page-selection"
                            type="text"
                            value={pageSelectionInput}
                            disabled={isProcessing}
                            aria-invalid={pageSelectionError ? true : undefined}
                            onChange={(event) => {
                              resetOutput();
                              setPageSelectionInput(event.target.value);
                            }}
                            placeholder="e.g. 1-5, 8"
                            className={`${inputClasses} mt-2`}
                          />
                          <p className="mt-2 text-xs text-gray-500">
                            Use page numbers and ranges such as{" "}
                            <span className="font-medium text-gray-600">
                              1, 3-5, 8
                            </span>{" "}
                            from this {pageCount}-page PDF.
                          </p>
                          {pageSelectionError && (
                            <p
                              role="alert"
                              className="mt-1 text-xs font-medium text-amber-600"
                            >
                              {pageSelectionError}
                            </p>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                )}
              </div>

              {/* ACTION SUMMARY */}
              {(watermarkEnabled || pageNumbersEnabled) && (
                <div className="mt-4 rounded-lg bg-gray-50 border border-gray-200 px-4 py-3 space-y-1">
                  <p className="text-sm font-medium text-gray-700">Summary</p>
                  {watermarkEnabled && (
                    <p className="text-sm text-gray-500">
                      Watermark {"“"}
                      {watermarkText.trim() === "" ? "(no text entered)" : watermarkText}
                      {"”"} will be added to all {pageCount} page
                      {pageCount === 1 ? "" : "s"}.
                    </p>
                  )}
                  {pageNumbersEnabled && pageNumberPreviewLabel && (
                    <p className="text-sm text-gray-500">
                      Page numbers ({pageNumberPreviewLabel}
                      {pageNumberFormat !== "page-number-of-total" &&
                        numberedPageCountPreview > 0 &&
                        ` … ${startingNumber + numberedPageCountPreview - 1}`}
                      ) will be added to{" "}
                      {pageRangeMode === "all"
                        ? `all ${pageCount} page${pageCount === 1 ? "" : "s"}`
                        : `${numberedPageCountPreview} selected page${
                            numberedPageCountPreview === 1 ? "" : "s"
                          }`}
                      .
                    </p>
                  )}
                </div>
              )}

              {!watermarkEnabled && !pageNumbersEnabled && (
                <p className="mt-4 text-sm text-gray-500">
                  Enable a watermark, page numbers, or both to apply changes.
                </p>
              )}
            </>
          )}

          {error && (
            <p role="alert" className="mt-4 text-sm font-medium text-red-600">
              {error}
            </p>
          )}

          <button
            type="button"
            onClick={handleApply}
            disabled={!canApply}
            aria-busy={isProcessing}
            className={`mt-6 flex w-full items-center justify-center rounded-lg px-4 py-3 text-sm font-semibold transition-colors ${
              canApply
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
            {isProcessing ? "Applying changes..." : "Apply Changes"}
          </button>
        </div>

        {result && selectedFile && (
          <ResultPanel
            icon="✓"
            title="PDF ready"
            message="Your changes were applied and the PDF downloaded."
            stats={[
              { label: "Pages processed", value: result.pageCount },
              {
                label: "Watermark",
                value: result.watermarkApplied ? "Applied" : "Not applied",
              },
              {
                label: "Page numbers",
                value: result.pageNumbersApplied
                  ? `Applied (${result.numberedPageCount})`
                  : "Not applied",
              },
              { label: "Output size", value: formatFileSize(result.bytes.length) },
              {
                label: "Processing time",
                value: `${(result.processingTime / 1000).toFixed(2)}s`,
              },
            ]}
            onDownload={() =>
              downloadPdfBytes(
                result.bytes,
                getResultFilename(
                  selectedFile.name,
                  result.watermarkApplied,
                  result.pageNumbersApplied,
                ),
              )
            }
            downloadLabel="Download PDF"
            onReset={handleApplyToAnother}
            resetLabel="Apply to another PDF"
          />
        )}
      </div>
    </div>
  );
}
