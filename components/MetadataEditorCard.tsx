"use client";

import { useRef, useState } from "react";
import {
  readPdfMetadata,
  updatePdfMetadata,
  type PdfMetadataFields,
  type UpdateMetadataResult,
} from "../services/pdf/metadata";
import { formatFileSize } from "./ResultCard";
import ResultPanel from "./ResultPanel";
import UploadZone from "./UploadZone";

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

/** Two visual groups so the form reads as an organized editor rather than an arbitrary input list. */
const FIELD_GROUPS: {
  heading: string;
  fields: {
    key: keyof PdfMetadataFields;
    label: string;
    placeholder: string;
    helperText: string;
  }[];
}[] = [
  {
    heading: "Document information",
    fields: [
      {
        key: "title",
        label: "Title",
        placeholder: "e.g. Q3 Financial Report",
        helperText: "The document title shown in PDF viewers.",
      },
      {
        key: "author",
        label: "Author",
        placeholder: "e.g. Jane Doe",
        helperText: "Who created or owns this document.",
      },
      {
        key: "subject",
        label: "Subject",
        placeholder: "e.g. Quarterly summary",
        helperText: "A short description of the document's topic.",
      },
      {
        key: "keywords",
        label: "Keywords",
        placeholder: "e.g. finance, quarterly, 2026",
        helperText: "Search terms that help categorize the document.",
      },
    ],
  },
  {
    heading: "PDF application information",
    fields: [
      {
        key: "creator",
        label: "Creator",
        placeholder: "e.g. DocFlow",
        helperText: "The application or person that created the document.",
      },
      {
        key: "producer",
        label: "Producer",
        placeholder: "e.g. DocFlow",
        helperText: "The application or library that generated the PDF.",
      },
    ],
  },
];

export default function MetadataEditorCard() {
  const isProcessingRef = useRef(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [pageCount, setPageCount] = useState<number | null>(null);
  const [fields, setFields] = useState<PdfMetadataFields>(EMPTY_FIELDS);
  const [isReading, setIsReading] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<UpdateMetadataResult | null>(null);

  // Upload must stay locked while metadata is being read or saved, so the
  // file can't be swapped out from under an in-flight operation.
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
      setFields(EMPTY_FIELDS);
      setResult(null);
      setError("Please select a valid PDF file.");
      return;
    }

    setSelectedFile(file);
    setFields(EMPTY_FIELDS);
    setPageCount(null);
    setResult(null);
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
    resetOutput();
    setFields((current) => ({ ...current, [key]: value }));
  };

  const handleSave = async () => {
    if (isProcessingRef.current || !selectedFile) return;

    isProcessingRef.current = true;
    setIsProcessing(true);
    setError(null);
    setResult(null);

    try {
      const updateResult = await updatePdfMetadata(selectedFile, fields);

      setResult(updateResult);
      downloadPdfBytes(
        updateResult.bytes,
        getMetadataFilename(selectedFile.name),
      );
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

  /** Clears the current file, form state, and result so a different PDF can be edited. */
  const handleEditAnother = () => {
    setSelectedFile(null);
    setPageCount(null);
    setFields(EMPTY_FIELDS);
    setIsReading(false);
    setIsProcessing(false);
    isProcessingRef.current = false;
    resetOutput();
  };

  const canSave = selectedFile !== null && !isProcessing && !isReading;

  return (
    <div className="w-full max-w-2xl mx-auto px-4 sm:px-6">
      <div className="bg-white rounded-2xl shadow-lg border border-gray-100 overflow-hidden">
        <UploadZone
          accept=".pdf,application/pdf"
          title="Choose a PDF to edit metadata"
          helperText="or drag and drop it here"
          onFileSelect={(file) => void selectFile(file)}
          disabled={uploadDisabled}
          className="mx-4 sm:mx-6 mt-6"
        />

        <div className="px-4 sm:px-6 pb-6">
          {selectedFile && (
            <div className="mt-4 min-w-0 rounded-lg bg-gray-50 border border-gray-200 px-4 py-3">
              <p className="text-sm font-medium text-gray-800 truncate">
                {selectedFile.name}
              </p>
              <p className="mt-1 text-sm text-gray-500">
                {isReading
                  ? "Reading metadata..."
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
              Reading metadata from your PDF...
            </p>
          )}

          {error && (
            <div
              role="alert"
              className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3"
            >
              <p className="text-sm font-medium text-red-700">{error}</p>
            </div>
          )}

          {selectedFile && !isReading && pageCount !== null && (
            <div className="mt-6 space-y-6">
              {FIELD_GROUPS.map((group) => (
                <div key={group.heading}>
                  <h3 className="text-sm font-semibold text-gray-900">
                    {group.heading}
                  </h3>
                  <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-4">
                    {group.fields.map(({ key, label, placeholder, helperText }) => (
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
                          aria-describedby={`metadata-${key}-help`}
                          className="mt-2 w-full rounded-lg border border-gray-300 px-4 py-2.5 text-sm text-gray-900 placeholder:text-gray-400 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20 disabled:bg-gray-50 disabled:text-gray-400"
                        />
                        <p
                          id={`metadata-${key}-help`}
                          className="mt-1 text-xs text-gray-500"
                        >
                          {helperText}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}

          {selectedFile && !isReading && pageCount !== null && (
            <button
              type="button"
              onClick={handleSave}
              disabled={!canSave}
              aria-busy={isProcessing}
              className={`mt-6 flex w-full items-center justify-center rounded-lg px-4 py-3 text-sm font-semibold transition-colors ${
                canSave
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
              {isProcessing ? "Saving..." : "Save metadata"}
            </button>
          )}

          {isProcessing && (
            <p
              className="mt-2 text-center text-xs text-gray-500"
              role="status"
              aria-live="polite"
            >
              Saving your metadata changes...
            </p>
          )}
        </div>

        {result && selectedFile && (
          <ResultPanel
            icon="✓"
            title="Metadata updated"
            message="Your PDF metadata has been updated successfully."
            stats={[
              { label: "Filename", value: getMetadataFilename(selectedFile.name) },
              { label: "Pages", value: pageCount ?? "—" },
              { label: "File size", value: formatFileSize(result.bytes.length) },
              {
                label: "Processing time",
                value: `${(result.processingTime / 1000).toFixed(2)}s`,
              },
            ]}
            onDownload={() =>
              downloadPdfBytes(
                result.bytes,
                getMetadataFilename(selectedFile.name),
              )
            }
            downloadLabel="Download PDF"
            onReset={handleEditAnother}
            resetLabel="Edit another PDF"
          />
        )}
      </div>
    </div>
  );
}
