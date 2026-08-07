"use client";

import { useRef, useState } from "react";
import {
  compressPDF,
  type CompressionMode,
} from "../services/pdf/compress";

const compressionOptions: { id: CompressionMode; label: string }[] = [
  { id: "light", label: "Light Compression" },
  { id: "heavy", label: "Heavy Compression" },
  { id: "custom", label: "Custom Size" },
];

/** Returns true when the file is a PDF (by MIME type or extension). */
function isPdfFile(file: File): boolean {
  const isPdfMime = file.type === "application/pdf";
  const isPdfExtension = file.name.toLowerCase().endsWith(".pdf");
  return isPdfMime || isPdfExtension;
}

/** Formats byte size into KB and MB strings for display. */
function formatFileSize(bytes: number) {
  const kb = (bytes / 1024).toFixed(2);
  const mb = (bytes / (1024 * 1024)).toFixed(2);
  return { kb, mb };
}

/** Triggers a browser download for PDF bytes and cleans up the object URL. */
function downloadPdfBytes(bytes: Uint8Array, filename: string): void {
  const blob = new Blob([bytes as BlobPart], { type: "application/pdf" });
  const objectUrl = URL.createObjectURL(blob);

  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = filename;
  link.click();

  URL.revokeObjectURL(objectUrl);
}

export default function UploadCard() {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [compressionMode, setCompressionMode] =
    useState<CompressionMode>("light");
  const [customSize, setCustomSize] = useState("");
  const [isDragging, setIsDragging] = useState(false);

  // Selected PDF file, validation error, and post-download success message
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);

  /** Validates and stores the chosen file, or shows an error. */
  const handleFileSelection = (file: File | undefined) => {
    if (!file) return;

    if (!isPdfFile(file)) {
      setSelectedFile(null);
      setError("Please select a valid PDF file.");
      return;
    }

    setSelectedFile(file);
    setError(null);
    setSuccessMessage(null);
  };

  /** Opens the hidden file picker when the drop zone is clicked. */
  const openFilePicker = () => {
    fileInputRef.current?.click();
  };

  /** Reads the file chosen via the hidden input. */
  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    handleFileSelection(e.target.files?.[0]);
    // Reset input so the same file can be re-selected after clearing
    e.target.value = "";
  };

  /** Accepts a file dropped onto the upload area. */
  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
    handleFileSelection(e.dataTransfer.files?.[0]);
  };

  const fileSize = selectedFile ? formatFileSize(selectedFile.size) : null;
  const canCompress = selectedFile !== null && !isProcessing;

  /** Delegates compression to the pdf service and surfaces success or failure. */
  const handleCompressPdf = async () => {
    if (!selectedFile) return;

    setIsProcessing(true);
    setSuccessMessage(null);
    setError(null);

    try {
      const compressedBytes = await compressPDF(selectedFile, compressionMode);

      downloadPdfBytes(compressedBytes, "compressed.pdf");
      setSuccessMessage("PDF compressed and downloaded as compressed.pdf.");
    } catch {
      setError(
        "Failed to compress the PDF. The file may be corrupted or password-protected.",
      );
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <div className="w-full max-w-2xl mx-auto px-4 sm:px-6">
      <div className="bg-white rounded-2xl shadow-lg border border-gray-100 overflow-hidden">
        {/* Hidden file input — opened programmatically on drop-zone click */}
        <input
          ref={fileInputRef}
          type="file"
          accept=".pdf,application/pdf"
          className="hidden"
          onChange={handleInputChange}
        />

        <div
          role="button"
          tabIndex={0}
          onClick={openFilePicker}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              openFilePicker();
            }
          }}
          className={`mx-4 sm:mx-6 mt-6 sm:mt-8 mb-6 flex flex-col items-center justify-center rounded-xl border-2 border-dashed px-6 py-12 sm:py-16 transition-colors cursor-pointer ${
            isDragging
              ? "border-blue-500 bg-blue-50"
              : "border-gray-300 bg-gray-50 hover:border-blue-400 hover:bg-blue-50/50"
          }`}
          onDragEnter={() => setIsDragging(true)}
          onDragLeave={() => setIsDragging(false)}
          onDragOver={(e) => e.preventDefault()}
          onDrop={handleDrop}
        >
          <div className="flex h-14 w-14 sm:h-16 sm:w-16 items-center justify-center rounded-full bg-blue-100 text-blue-600">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={1.5}
              stroke="currentColor"
              className="h-7 w-7 sm:h-8 sm:w-8"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5m-13.5-9L12 3m0 0 4.5 4.5M12 3v13.5"
              />
            </svg>
          </div>

          <p className="mt-4 text-base sm:text-lg font-medium text-gray-800 text-center">
            Drag &amp; Drop your PDF here
          </p>
          <p className="mt-1 text-sm text-gray-500">or click to browse</p>
        </div>

        {/* File details, validation error, or success message */}
        {(selectedFile || error || successMessage) && (
          <div className="mx-4 sm:mx-6 -mt-2 mb-4">
            {error && (
              <p className="text-sm text-red-600 font-medium">{error}</p>
            )}

            {successMessage && (
              <p className="text-sm text-green-600 font-medium">
                {successMessage}
              </p>
            )}

            {selectedFile && fileSize && (
              <div className="rounded-lg bg-gray-50 border border-gray-200 px-4 py-3">
                <p className="text-sm font-medium text-gray-800 truncate">
                  {selectedFile.name}
                </p>
                <p className="mt-1 text-sm text-gray-500">
                  {fileSize.kb} KB · {fileSize.mb} MB
                </p>
              </div>
            )}
          </div>
        )}

        <div className="px-4 sm:px-6 pb-6">
          <p className="mb-3 text-sm font-medium text-gray-700">
            Compression level
          </p>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {compressionOptions.map((option) => (
              <button
                key={option.id}
                type="button"
                onClick={() => setCompressionMode(option.id)}
                className={`rounded-lg border px-4 py-3 text-sm font-medium transition-colors ${
                  compressionMode === option.id
                    ? "border-blue-600 bg-blue-600 text-white shadow-sm"
                    : "border-gray-200 bg-white text-gray-700 hover:border-blue-300 hover:bg-blue-50"
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>

          {compressionMode === "custom" && (
            <div className="mt-4">
              <label
                htmlFor="custom-size"
                className="block text-sm font-medium text-gray-700 mb-2"
              >
                Target size (MB)
              </label>
              <input
                id="custom-size"
                type="number"
                min="0.1"
                step="0.1"
                placeholder="e.g. 5"
                value={customSize}
                onChange={(e) => setCustomSize(e.target.value)}
                className="w-full rounded-lg border border-gray-300 px-4 py-2.5 text-sm text-gray-900 placeholder:text-gray-400 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
              />
            </div>
          )}

          <button
            type="button"
            disabled={!canCompress}
            onClick={handleCompressPdf}
            className="mt-6 w-full rounded-lg bg-blue-600 px-6 py-3 text-sm sm:text-base font-semibold text-white shadow-sm transition-colors hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-blue-600"
          >
            Compress PDF
          </button>
        </div>
      </div>
    </div>
  );
}
