// components/UploadZone.tsx
"use client";

import { useRef, useState } from "react";

export type UploadZoneProps = {
  /** Called with the first file coming from click-to-browse or drop. */
  onFileSelect: (file: File | undefined) => void;
  accept?: string;
  title?: string;
  helperText?: string;
  disabled?: boolean;
  /** Layout-only classes for the outer zone (margins/spacing owned by the parent card). */
  className?: string;
};

/**
 * Generic upload interaction primitive: hidden file input, click-to-browse,
 * keyboard activation, and drag-and-drop with a drag-over visual state.
 *
 * It intentionally knows nothing about PDFs, validation, or DocFlow business
 * logic — it only hands the selected File to `onFileSelect`.
 */
export default function UploadZone({
  onFileSelect,
  accept,
  title,
  helperText,
  disabled = false,
  className = "",
}: UploadZoneProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);

  const openFilePicker = () => {
    if (disabled) return;
    fileInputRef.current?.click();
  };

  return (
    <>
      <input
        ref={fileInputRef}
        type="file"
        accept={accept}
        className="hidden"
        disabled={disabled}
        onChange={(event) => {
          onFileSelect(event.target.files?.[0]);
          event.target.value = "";
        }}
      />

      <div
        role="button"
        tabIndex={0}
        aria-disabled={disabled || undefined}
        onClick={() => {
          if (disabled) return;
          openFilePicker();
        }}
        onKeyDown={(event) => {
          if (disabled) return;
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            openFilePicker();
          }
        }}
        onDragEnter={() => {
          if (disabled) return;
          setIsDragging(true);
        }}
        onDragLeave={() => setIsDragging(false)}
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          setIsDragging(false);
          if (disabled) return;
          onFileSelect(event.dataTransfer.files?.[0]);
        }}
        className={`${className} flex flex-col items-center justify-center rounded-xl border-2 border-dashed px-6 py-10 transition-colors outline-none ${
          disabled
            ? "cursor-not-allowed border-gray-200 bg-gray-50"
            : `cursor-pointer focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 ${
                isDragging
                  ? "border-blue-500 bg-blue-50"
                  : "border-gray-300 bg-gray-50 hover:border-blue-400 hover:bg-blue-50/50"
              }`
        }`}
      >
        {title && (
          <p
            className={`text-base font-medium text-center ${
              disabled ? "text-gray-400" : "text-gray-800"
            }`}
          >
            {title}
          </p>
        )}
        {helperText && (
          <p
            className={`mt-1 text-sm ${
              disabled ? "text-gray-400" : "text-gray-500"
            }`}
          >
            {helperText}
          </p>
        )}
      </div>
    </>
  );
}
