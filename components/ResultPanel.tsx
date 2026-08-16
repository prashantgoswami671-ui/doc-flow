// components/ResultPanel.tsx
"use client";

import type { ReactNode } from "react";

export interface ResultStat {
  label: string;
  value: ReactNode;
}

export interface ResultPanelProps {
  /** Optional icon/emoji shown in the leading circle badge. */
  icon?: ReactNode;
  /** Primary heading, e.g. "Protection complete". */
  title: string;
  /** Optional subtitle/summary line under the title. */
  message?: string;
  /** Optional grid of label/value stats (page count, size, etc.). */
  stats?: ResultStat[];
  /** Called when the primary download action is triggered. */
  onDownload?: () => void;
  /** Label for the primary download button. */
  downloadLabel?: string;
  /** Called when the secondary reset/"do another" action is triggered. */
  onReset?: () => void;
  /** Label for the secondary reset button. */
  resetLabel?: string;
  /** Extra content rendered between the stats and the action buttons. */
  children?: ReactNode;
  /** Optional className applied to the outer wrapping element. */
  className?: string;
}

/**
 * Generic, presentation-only panel for displaying a completed PDF
 * operation's result: a header (icon + title + message), optional stats,
 * and a primary download action with an optional secondary reset action.
 *
 * ResultPanel has no knowledge of PDFs, files, or any specific operation —
 * it only renders what it's given and calls the callbacks it's handed.
 * The parent component owns all processing, download, and reset behavior.
 */
export default function ResultPanel({
  icon,
  title,
  message,
  stats,
  onDownload,
  downloadLabel,
  onReset,
  resetLabel,
  children,
  className,
}: ResultPanelProps) {
  return (
    <div
      className={`border-t border-gray-100 bg-gray-50 px-4 sm:px-6 py-6 ${className ?? ""}`}
    >
      <div className="mb-4 flex items-center gap-3">
        {icon !== undefined && (
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-green-100 text-xl">
            {icon}
          </div>
        )}
        <div>
          <p className="text-base font-semibold text-gray-900">{title}</p>
          {message && <p className="text-sm text-gray-500">{message}</p>}
        </div>
      </div>

      {stats && stats.length > 0 && (
        <div className="mb-4 grid grid-cols-2 gap-3">
          {stats.map((stat, index) => (
            <div
              key={index}
              className="rounded-lg border border-gray-200 bg-white px-3 py-2"
            >
              <p className="text-xs text-gray-500">{stat.label}</p>
              <p className="mt-0.5 text-sm font-semibold text-gray-800">
                {stat.value}
              </p>
            </div>
          ))}
        </div>
      )}

      {children}

      {onDownload && (
        <button
          type="button"
          onClick={onDownload}
          className="w-full rounded-xl bg-blue-600 py-3 text-base font-semibold text-white transition hover:bg-blue-700"
        >
          {downloadLabel ?? "Download"}
        </button>
      )}

      {onReset && (
        <button
          type="button"
          onClick={onReset}
          className="mt-3 w-full rounded-xl border border-gray-300 bg-white py-3 text-base font-semibold text-gray-700 transition hover:bg-gray-50"
        >
          {resetLabel ?? "Start over"}
        </button>
      )}
    </div>
  );
}
