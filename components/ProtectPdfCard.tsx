"use client";

import { useRef, useState } from "react";
import { protectPDF, type ProtectPdfResult } from "../services/pdf/protect";

function isPdfFile(file: File): boolean {
  return (
    file.type === "application/pdf" ||
    file.name.toLowerCase().endsWith(".pdf")
  );
}

function getProtectedFilename(originalName: string): string {
  if (originalName.toLowerCase().endsWith(".pdf")) {
    return `${originalName.slice(0, -4)}-protected.pdf`;
  }

  return `${originalName}-protected.pdf`;
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

function EyeIcon({ visible }: { visible: boolean }) {
  if (visible) {
    return (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        fill="none"
        viewBox="0 0 24 24"
        strokeWidth={1.5}
        stroke="currentColor"
        className="h-5 w-5"
        aria-hidden="true"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M3.98 8.223A10.477 10.477 0 0 0 1.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.45 10.45 0 0 1 12 4.5c4.756 0 8.773 3.162 10.065 7.498a10.523 10.523 0 0 1-4.293 5.774M6.228 6.228 3 3m3.228 3.228 3.65 3.65m7.894 7.894L21 21m-3.228-3.228-3.65-3.65m0 0a3 3 0 1 0-4.243-4.243m4.242 4.242L9.88 9.88"
        />
      </svg>
    );
  }

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      strokeWidth={1.5}
      stroke="currentColor"
      className="h-5 w-5"
      aria-hidden="true"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M2.036 12.322a1.012 1.012 0 0 1 0-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178Z"
      />
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z"
      />
    </svg>
  );
}

export default function ProtectPdfCard() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const isProcessingRef = useRef(false);

  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [result, setResult] = useState<ProtectPdfResult | null>(null);

  const resetPasswords = () => {
    setPassword("");
    setConfirmPassword("");
    setShowPassword(false);
    setShowConfirmPassword(false);
  };

  const selectFile = (file: File | undefined) => {
    if (!file) return;

    if (!isPdfFile(file)) {
      setSelectedFile(null);
      setError("Please select a valid PDF file.");
      setResult(null);
      setSuccessMessage(null);
      return;
    }

    setSelectedFile(file);
    setError(null);
    setSuccessMessage(null);
    setResult(null);
    resetPasswords();
  };

  const handleProtectAnother = () => {
    setSelectedFile(null);
    setError(null);
    setSuccessMessage(null);
    setResult(null);
    resetPasswords();

    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  const validationError: string | null = (() => {
    if (password === "" && confirmPassword === "") return null;
    if (password === "") return "Password is required.";
    if (confirmPassword === "") return "Please confirm your password.";
    if (password !== confirmPassword) return "Passwords don't match.";
    return null;
  })();

  const canProtect =
    selectedFile !== null &&
    !isProcessing &&
    password !== "" &&
    confirmPassword !== "" &&
    password === confirmPassword;

  const handleProtect = async () => {
    if (isProcessingRef.current || !selectedFile) return;

    if (password === "") {
      setError("Password is required.");
      return;
    }

    if (password !== confirmPassword) {
      setError("Passwords don't match.");
      return;
    }

    isProcessingRef.current = true;
    setIsProcessing(true);
    setError(null);
    setSuccessMessage(null);

    try {
      const protectResult = await protectPDF(selectedFile, password);

      setResult(protectResult);
      downloadPdfBytes(
        protectResult.bytes,
        getProtectedFilename(selectedFile.name),
      );
      setSuccessMessage("PDF protected and downloaded successfully.");
      resetPasswords();
    } catch (protectError) {
      console.error("PDF protect error:", protectError);
      setError(
        protectError instanceof Error
          ? `Unable to protect PDF: ${protectError.message}`
          : "Unable to protect PDF.",
      );
    } finally {
      isProcessingRef.current = false;
      setIsProcessing(false);
    }
  };

  return (
    <div className="w-full max-w-2xl mx-auto px-4 sm:px-6">
      <div className="bg-white rounded-2xl shadow-lg border border-gray-100 overflow-hidden">
        <div className="px-4 sm:px-6 pt-6 sm:pt-8">
          <h2 className="text-xl font-bold text-gray-900">Protect PDF</h2>
          <p className="mt-1 text-sm text-gray-500">
            Add a password so your PDF can only be opened by people who know
            it.
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
            Choose a PDF to protect
          </p>
          <p className="mt-1 text-sm text-gray-500">or drag and drop it here</p>
        </div>

        <div className="px-4 sm:px-6 pb-6">
          {selectedFile && (
            <div className="rounded-lg bg-gray-50 border border-gray-200 px-4 py-3 mb-4">
              <p className="text-sm font-medium text-gray-800 truncate">
                {selectedFile.name}
              </p>
            </div>
          )}

          {selectedFile && (
            <div className="grid grid-cols-1 gap-4">
              <div>
                <label
                  htmlFor="protect-password"
                  className="block text-sm font-medium text-gray-700"
                >
                  Password
                </label>
                <div className="mt-2 relative">
                  <input
                    id="protect-password"
                    type={showPassword ? "text" : "password"}
                    autoComplete="new-password"
                    value={password}
                    onChange={(event) => {
                      setPassword(event.target.value);
                      setError(null);
                      setSuccessMessage(null);
                      setResult(null);
                    }}
                    disabled={isProcessing}
                    placeholder="Enter a password"
                    className="w-full rounded-lg border border-gray-300 px-4 py-2.5 pr-11 text-sm text-gray-900 placeholder:text-gray-400 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((current) => !current)}
                    className="absolute inset-y-0 right-0 flex items-center px-3 text-gray-400 hover:text-gray-600"
                    aria-label={showPassword ? "Hide password" : "Show password"}
                  >
                    <EyeIcon visible={showPassword} />
                  </button>
                </div>
              </div>

              <div>
                <label
                  htmlFor="protect-confirm-password"
                  className="block text-sm font-medium text-gray-700"
                >
                  Confirm password
                </label>
                <div className="mt-2 relative">
                  <input
                    id="protect-confirm-password"
                    type={showConfirmPassword ? "text" : "password"}
                    autoComplete="new-password"
                    value={confirmPassword}
                    onChange={(event) => {
                      setConfirmPassword(event.target.value);
                      setError(null);
                      setSuccessMessage(null);
                      setResult(null);
                    }}
                    disabled={isProcessing}
                    placeholder="Re-enter the password"
                    className="w-full rounded-lg border border-gray-300 px-4 py-2.5 pr-11 text-sm text-gray-900 placeholder:text-gray-400 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                  />
                  <button
                    type="button"
                    onClick={() =>
                      setShowConfirmPassword((current) => !current)
                    }
                    className="absolute inset-y-0 right-0 flex items-center px-3 text-gray-400 hover:text-gray-600"
                    aria-label={
                      showConfirmPassword ? "Hide password" : "Show password"
                    }
                  >
                    <EyeIcon visible={showConfirmPassword} />
                  </button>
                </div>
              </div>

              {validationError && (
                <p className="text-sm font-medium text-red-600">
                  {validationError}
                </p>
              )}
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

          <button
            type="button"
            onClick={handleProtect}
            disabled={!canProtect}
            className={`mt-6 w-full rounded-lg px-4 py-3 text-sm font-semibold transition-colors ${
              canProtect
                ? "bg-blue-600 text-white hover:bg-blue-700"
                : "bg-gray-200 text-gray-400 cursor-not-allowed"
            }`}
          >
            {isProcessing ? "Protecting PDF..." : "Protect PDF"}
          </button>
        </div>

        {result && selectedFile && (
          <div className="border-t border-gray-100 bg-gray-50 px-4 sm:px-6 py-6">
            <div className="mb-4 flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-green-100 text-xl">
                🔒
              </div>
              <div>
                <p className="text-base font-semibold text-gray-900">
                  Protection complete
                </p>
                <p className="text-sm text-gray-500">
                  {result.pageCount} page{result.pageCount === 1 ? "" : "s"} ·{" "}
                  {(result.processingTime / 1000).toFixed(2)}s
                </p>
              </div>
            </div>

            <button
              type="button"
              onClick={() =>
                downloadPdfBytes(
                  result.bytes,
                  getProtectedFilename(selectedFile.name),
                )
              }
              className="w-full rounded-xl bg-blue-600 py-3 text-base font-semibold text-white transition hover:bg-blue-700"
            >
              Download Protected PDF
            </button>

            <button
              type="button"
              onClick={handleProtectAnother}
              className="mt-3 w-full rounded-xl border border-gray-300 bg-white py-3 text-base font-semibold text-gray-700 transition hover:bg-gray-50"
            >
              Protect another PDF
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
