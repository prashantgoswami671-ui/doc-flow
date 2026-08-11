"use client";

import { useRef, useState } from "react";
import {
  readPdfMetadata,
  updatePdfMetadata,
  type PdfMetadataFields,
  type UpdateMetadataResult,
} from "../services/pdf/metadata";

function isPdfFile(file: File): boolean {
  return (
    file.type === "application/pdf" ||
    file.name.toLowerCase().endsWith(".pdf")
  );
}

function getMetadataFilename(originalName: string): string {
  if (originalName.toLowerCase().endsWith(".pdf")) {
    return `${originalName.slice(0, -4)}-metadata.pdf`;
  }

  return `${originalName}-metadata.pdf`;
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

const EMPTY_FIELDS: PdfMetadataFields = {
  title: "",
  author: "",
  subject: "",
  keywords: "",
  creator: "",
  producer: "",
};

const FIELD_CONFIG: {
  key: keyof PdfMetadataFields;
  label: string;
  placeholder: string;
}[] = [
  { key: "title", label: "Title", placeholder: "e.g. Q3 Financial Report" },
  { key: "author", label: "Author", placeholder: "e.g. Jane Doe" },
  { key: "subject", label: "Subject", placeholder: "e.g. Quarterly summary" },
  { key: "keywords", label: "Keywords", placeholder: "e.g. finance, quarterly, 2026" },
  { key: "creator", label: "Creator", placeholder: "e.g. DocFlow" },
  { key: "producer", label: "Producer", placeholder: "e.g. DocFlow" },
];

export default function MetadataEditorCard() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const isProcessingRef = useRef(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [pageCount, setPageCount] = useState<number | null>(null);
  const [fields, setFields] = useState<PdfMetadataFields>(EMPTY_FIELDS);
  const [isDragging, setIsDragging] = useState(false);
  const [isReading, setIsReading] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [result, setResult] = useState<UpdateMetadataResult | null>(null);

  const selectFile = async (file: File | undefined) => {
    if (!file) return;

    if (!isPdfFile(file)) {
      setSelectedFile(null);
      setPageCount(null);
      setFields(EMPTY_FIELDS);
      setResult(null);
      setSuccessMessage(null);
      setError("Please select a valid PDF file.");
      return;
    }

    setSelectedFile(file);
    setFields(EMPTY_FIELDS);
    setPageCount(null);
    setResult(null);
    setSuccessMessage(null);
    setError(null);
    setIsReading(true);

    try {
      const metadata = await readPdfMetadata(file);

      setFields(metadata.fields);
      setPageCount(metadata.pageCount);
    } catch (readError) {
      console.error("PDF metadata read error:", readError);
      setSelectedFile(null);
      setError(
        readError instanceof Error
          ? `Unable to read this PDF: ${readError.message}`
          : "Unable to read this PDF.",
      );
    } finally {
      setIsReading(false);
    }
  };

  const updateField = (key: keyof PdfMetadataFields, value: string) => {
    setResult(null);
    setSuccessMessage(null);
    setFields((current) => ({ ...current, [key]: value }));
  };

  const handleSave = async () => {
    if (isProcessingRef.current || !selectedFile) return;

    isProcessingRef.current = true;
    setIsProcessing(true);
    setError(null);
    setSuccessMessage(null);

    try {
      const updateResult = await updatePdfMetadata(selectedFile, fields);

      setResult(updateResult);
      downloadPdfBytes(
        updateResult.bytes,
        getMetadataFilename(selectedFile.name),
      );
      setSuccessMessage("Metadata updated and PDF downloaded.");
    } catch (saveError) {
      console.error("PDF metadata save error:", saveError);
      setError(
        saveError instanceof Error
          ? `Save failed: ${saveError.message}`
          : "Failed to save metadata for this PDF.",
      );
    } finally {
      isProcessingRef.current = false;
      setIsProcessing(false);
    }
  };

  const canSave = selectedFile !== null && !isProcessing && !isReading;

  return (
    <div className="w-full max-w-2xl mx-auto px-4 sm:px-6">
      <div className="bg-white rounded-2xl shadow-lg border border-gray-100 overflow-hidden">
        <div className="px-4 sm:px-6 pt-6 sm:pt-8">
          <h2 className="text-xl font-bold text-gray-900">Edit Metadata</h2>
          <p className="mt-1 text-sm text-gray-500">
            View and update a PDF&apos;s title, author, and other document
            properties.
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
            void selectFile(event.dataTransfer.files?.[0]);
          }}
          className={`mx-4 sm:mx-6 mt-6 mb-4 flex flex-col items-center justify-center rounded-xl border-2 border-dashed px-6 py-10 transition-colors cursor-pointer ${
            isDragging
              ? "border-blue-500 bg-blue-50"
              : "border-gray-300 bg-gray-50 hover:border-blue-400 hover:bg-blue-50/50"
          }`}
        >
          <p className="text-base font-medium text-gray-800 text-center">
            Choose a PDF to edit metadata
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
                {isReading
                  ? "Reading metadata..."
                  : pageCount !== null
                    ? `${pageCount} page${pageCount === 1 ? "" : "s"}`
                    : ""}
              </p>
            </div>
          )}

          {selectedFile && !isReading && pageCount !== null && (
            <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-4">
              {FIELD_CONFIG.map(({ key, label, placeholder }) => (
                <div key={key}>
                  <label
                    htmlFor={`metadata-${key}`}
                    className="block text-sm font-medium text-gray-700"
                  >
                    {label}
                  </label>
                  <input
                    id={`metadata-${key}`}
                    type="text"
                    value={fields[key]}
                    onChange={(event) => updateField(key, event.target.value)}
                    disabled={isProcessing}
                    placeholder={placeholder}
                    className="mt-2 w-full rounded-lg border border-gray-300 px-4 py-2.5 text-sm text-gray-900 placeholder:text-gray-400 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                  />
                </div>
              ))}
            </div>
          )}

          {error && (
            <p className="mt-4 text-sm font-medium text-red-600">{error}</p>
          )}
          {successMessage && (
            <p className="mt-4 text-sm font-medium text-green-600">
              {successMessage}
            </p>
          )}
          {result && (
            <p className="mt-2 text-sm text-gray-500">
              Saved in {(result.processingTime / 1000).toFixed(2)}s.
            </p>
          )}

          <button
            type="button"
            onClick={handleSave}
            disabled={!canSave}
            className={`mt-6 w-full rounded-lg px-4 py-3 text-sm font-semibold transition-colors ${
              canSave
                ? "bg-blue-600 text-white hover:bg-blue-700"
                : "bg-gray-200 text-gray-400 cursor-not-allowed"
            }`}
          >
            {isProcessing ? "Saving metadata..." : "Save Metadata"}
          </button>
        </div>
      </div>
    </div>
  );
}
