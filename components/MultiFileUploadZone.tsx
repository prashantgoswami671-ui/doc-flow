// components/MultiFileUploadZone.tsx
"use client";

import { useRef, useState } from "react";

export type MultiFileUploadZoneProps = {
  /** Called with every file coming from click-to-browse or drop, in order. */
  onFilesSelect: (files: FileList) => void;
  accept?: string;
  title?: string;
  helperText?: string;
  disabled?: boolean;
  /** Layout-only classes for the outer zone (margins/spacing owned by the parent card). */
  className?: string;
};

/**
 * Multi-file sibling of UploadZone: the same interaction primitive (hidden
 * file input, click-to-browse, keyboard activation, and drag-and-drop with
 * a drag-over visual state), but accepts and hands back every
 * selected/dropped file via a FileList instead of a single File.
 *
 * Deliberately kept separate from UploadZone rather than added to it:
 * UploadZone's contract explicitly hands back one File, and its existing
 * consumers depend on that shape. This component exists only for tools
 * that need multi-file selection — queueing, reordering, removing, and
 * previewing individual files remains entirely the caller's responsibility,
 * exactly as it already was before this component existed.
 */
export default function MultiFileUploadZone({
  onFilesSelect,
  accept,
  title,
  helperText,
  disabled = false,
  className = "",
}: MultiFileUploadZoneProps) {
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
        multiple
        className="hidden"
        disabled={disabled}
        onChange={(event) => {
          if (event.target.files && event.target.files.length > 0) {
            onFilesSelect(event.target.files);
          }
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
          if (event.dataTransfer.files && event.dataTransfer.files.length > 0) {
            onFilesSelect(event.dataTransfer.files);
          }
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
            className={`mt-1 text-sm text-center ${
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
