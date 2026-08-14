"use client";

import React, { useRef, useState } from "react";
import { PdfRepairResult } from "../services/pdf/repairValidate";
import { validateAndRepairPdf } from "../services/pdf/repairValidate";

function isPdfFile(file: File): boolean {
  return file.type === "application/pdf" || file.name.endsWith(".pdf");
}

function formatFileSize(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
}

export default function RepairValidatePdfCard() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const isProcessingRef = useRef(false);

  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [result, setResult] = useState<PdfRepairResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const handleFileSelection = (file: File | undefined) => {
    if (!file) return;

    if (!isPdfFile(file)) {
      setError("Please select a valid PDF file.");
      setSelectedFile(null);
      return;
    }

    setSelectedFile(file);
    setError(null);
    setSuccessMessage(null);
    setResult(null);
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    handleFileSelection(e.target.files?.[0]);
    e.target.value = "";
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    handleFileSelection(e.dataTransfer.files?.[0]);
  };

  const handleValidateAndRepair = async () => {
    if (isProcessingRef.current || !selectedFile) return;

    isProcessingRef.current = true;
    setIsProcessing(true);
    setError(null);
    setSuccessMessage(null);

    try {
      const repairResult = await validateAndRepairPdf(selectedFile);
      setResult(repairResult);

      if (repairResult.success) {
        setSuccessMessage(
          `Repair successful! Method: ${repairResult.repairMethod}. Pages: ${repairResult.repairedPageCount}/${repairResult.originalPageCount}`,
        );
      } else {
        setError(
          repairResult.error ||
            "Repair was not successful. No safe strategies could be applied.",
        );
      }
    } catch (err) {
      setError(
        err instanceof Error
          ? `Error during repair: ${err.message}`
          : "An unexpected error occurred during repair.",
      );
    } finally {
      isProcessingRef.current = false;
      setIsProcessing(false);
    }
  };

  const handleDownload = () => {
    if (!result?.repairedBytes || !selectedFile) return;

    const blob = new Blob([result.repairedBytes], {
      type: "application/pdf",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `repaired-${selectedFile.name}`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const handleReset = () => {
    setSelectedFile(null);
    setResult(null);
    setError(null);
    setSuccessMessage(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  const fileSize = selectedFile ? formatFileSize(selectedFile.size) : null;
  const canProcess =
    selectedFile !== null && !isProcessing && result === null;
  const canDownload = result?.success && result?.repairedBytes;

  return (
    <div className="w-full max-w-2xl mx-auto px-4 py-8">
      <div className="bg-white rounded-lg shadow-md p-8">
        <h2 className="text-2xl font-bold mb-2">Repair & Validate PDF</h2>
        <p className="text-gray-600 mb-6">
          Test and repair corrupted or damaged PDF files using multiple recovery strategies.
        </p>

        {/* File Upload Area */}
        <div
          onDrop={handleDrop}
          onDragOver={(e) => e.preventDefault()}
          onClick={() => fileInputRef.current?.click()}
          className="border-2 border-dashed border-gray-300 rounded-lg p-8 text-center cursor-pointer hover:border-blue-500 hover:bg-blue-50 transition"
        >
          <input
            ref={fileInputRef}
            type="file"
            accept=".pdf"
            onChange={handleInputChange}
            className="hidden"
          />
          <p className="text-gray-600">
            Click to upload or drag and drop your PDF here
          </p>
          <p className="text-sm text-gray-500 mt-2">PDF files only</p>
        </div>

        {/* Selected File Info */}
        {selectedFile && !result && (
          <div className="mt-6 p-4 bg-gray-50 rounded-lg">
            <p className="font-semibold text-gray-800">{selectedFile.name}</p>
            <p className="text-sm text-gray-600">Size: {fileSize}</p>
          </div>
        )}

        {/* Error Message */}
        {error && (
          <div className="mt-6 p-4 bg-red-50 border border-red-200 rounded-lg">
            <p className="text-red-800 font-semibold">Error</p>
            <p className="text-red-700 text-sm mt-1">{error}</p>
          </div>
        )}

        {/* Success Message */}
        {successMessage && (
          <div className="mt-6 p-4 bg-green-50 border border-green-200 rounded-lg">
            <p className="text-green-800 font-semibold">Success!</p>
            <p className="text-green-700 text-sm mt-1">{successMessage}</p>
          </div>
        )}

        {/* Validation Result Details */}
        {result && (
          <div className="mt-6 space-y-4">
            <div className="bg-gray-50 p-4 rounded-lg">
              <h3 className="font-semibold text-gray-800 mb-3">
                Validation Result
              </h3>
              <div className="space-y-2 text-sm">
                <p>
                  <span className="font-medium">PDF-lib can read:</span>
                  <span className="ml-2">
                    {result.validationResult.pdfLibCanLoad ? "✓" : "✕"}
                  </span>
                </p>
                <p>
                  <span className="font-medium">PDF.js can render:</span>
                  <span className="ml-2">
                    {result.validationResult.pdfJsCanRender ? "✓" : "✕"}
                  </span>
                </p>
                <p>
                  <span className="font-medium">Password protected:</span>
                  <span className="ml-2">
                    {result.validationResult.isPasswordProtected ? "Yes" : "No"}
                  </span>
                </p>
                {result.validationResult.pdfLibError && (
                  <p className="text-red-600">
                    <span className="font-medium">PDF-lib error:</span>
                    <span className="ml-2 text-xs">
                      {result.validationResult.pdfLibError}
                    </span>
                  </p>
                )}
                {result.validationResult.pdfJsError && (
                  <p className="text-red-600">
                    <span className="font-medium">PDF.js error:</span>
                    <span className="ml-2 text-xs">
                      {result.validationResult.pdfJsError}
                    </span>
                  </p>
                )}
              </div>
            </div>

            {/* Repair Result */}
            {result.success ? (
              <div className="bg-green-50 p-4 rounded-lg border border-green-200">
                <h3 className="font-semibold text-green-800 mb-2">
                  ✓ Repair Successful
                </h3>
                <p className="text-sm text-green-700 mb-2">
                  <span className="font-medium">Method:</span>{" "}
                  {result.repairMethod === "structural-rebuild"
                    ? "Structural Rebuild (lossless)"
                    : result.repairMethod === "raster-salvage"
                      ? "Raster Salvage (lossy)"
                      : result.repairMethod}
                </p>
                <p className="text-sm text-green-700">
                  <span className="font-medium">Pages:</span>{" "}
                  {result.repairedPageCount}/{result.originalPageCount} verified
                </p>
                {result.warnings.length > 0 && (
                  <div className="mt-3 pt-3 border-t border-green-200">
                    <p className="text-sm font-medium text-yellow-700 mb-1">
                      Warnings:
                    </p>
                    <ul className="text-xs text-yellow-700 space-y-1">
                      {result.warnings.map((warning, idx) => (
                        <li key={idx}>• {warning}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            ) : (
              <div className="bg-red-50 p-4 rounded-lg border border-red-200">
                <h3 className="font-semibold text-red-800 mb-2">
                  ✕ Repair Unsuccessful
                </h3>
                <p className="text-sm text-red-700 mb-2">
                  {result.error || "No safe repair strategies could be applied."}
                </p>
                {result.warnings.length > 0 && (
                  <div className="mt-3 pt-3 border-t border-red-200">
                    <p className="text-sm font-medium text-red-700 mb-1">
                      Details:
                    </p>
                    <ul className="text-xs text-red-600 space-y-1">
                      {result.warnings.map((warning, idx) => (
                        <li key={idx}>• {warning}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}

            {/* Post-Repair Validation */}
            {result.postRepairValidation && (
              <div className="bg-blue-50 p-4 rounded-lg border border-blue-200">
                <h3 className="font-semibold text-blue-800 mb-2">
                  Post-Repair Validation
                </h3>
                <div className="space-y-2 text-sm text-blue-700">
                  <p>
                    <span className="font-medium">PDF-lib can read:</span>
                    <span className="ml-2">
                      {result.postRepairValidation.pdfLibCanLoad ? "✓" : "✕"}
                    </span>
                  </p>
                  <p>
                    <span className="font-medium">PDF.js can render:</span>
                    <span className="ml-2">
                      {result.postRepairValidation.pdfJsCanRender ? "✓" : "✕"}
                    </span>
                  </p>
                </div>
              </div>
            )}

            {/* Processing Time */}
            <p className="text-xs text-gray-500 text-center">
              Processing time: {(result.processingTime / 1000).toFixed(2)}s
            </p>
          </div>
        )}

        {/* Action Buttons */}
        <div className="mt-6 flex gap-3">
          {canProcess && (
            <button
              onClick={handleValidateAndRepair}
              disabled={isProcessing}
              className="flex-1 bg-blue-600 text-white py-2 px-4 rounded-lg font-semibold hover:bg-blue-700 disabled:bg-gray-400 transition"
            >
              {isProcessing ? "Processing..." : "Validate & Repair PDF"}
            </button>
          )}

          {canDownload && (
            <button
              onClick={handleDownload}
              className="flex-1 bg-green-600 text-white py-2 px-4 rounded-lg font-semibold hover:bg-green-700 transition"
            >
              Download Repaired PDF
            </button>
          )}

          {result && (
            <button
              onClick={handleReset}
              className="flex-1 bg-gray-600 text-white py-2 px-4 rounded-lg font-semibold hover:bg-gray-700 transition"
            >
              Try Another PDF
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
