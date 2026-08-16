// components/PageThumbnailGrid.tsx
"use client";

export interface PageThumbnailItem {
  pageNumber: number;
  /** Rendered preview image (data URL or object URL), or null when unavailable. */
  dataUrl: string | null;
}

export interface PageThumbnailGridProps {
  /** The pages to render as thumbnails, in display order. */
  pages: PageThumbnailItem[];
  /** Returns whether a given page should render as selected. Omit for no selection styling. */
  isSelected?: (page: PageThumbnailItem) => boolean;
  /** Called when a page's thumbnail is clicked. */
  onPageClick?: (page: PageThumbnailItem) => void;
  /** Disables all thumbnail buttons (e.g. while processing). */
  disabled?: boolean;
  /** Optional className applied to the outer grid element. */
  className?: string;
}

/**
 * Generic, presentation-only grid of clickable page thumbnails.
 *
 * PageThumbnailGrid has no knowledge of PDFs, files, or any specific
 * operation — it only renders the page data it's given and calls the
 * click callback it's handed. The parent component owns selection state
 * and any business logic behind what a click means.
 */
export default function PageThumbnailGrid({
  pages,
  isSelected,
  onPageClick,
  disabled = false,
  className,
}: PageThumbnailGridProps) {
  return (
    <div className={`grid grid-cols-2 sm:grid-cols-4 gap-3 ${className ?? ""}`}>
      {pages.map((page) => {
        const selected = isSelected?.(page) ?? false;

        return (
          <button
            key={page.pageNumber}
            type="button"
            aria-pressed={selected}
            aria-label={`Page ${page.pageNumber}`}
            onClick={() => onPageClick?.(page)}
            disabled={disabled}
            className={`flex flex-col rounded-lg border-2 p-2 transition-colors ${
              selected
                ? "border-blue-500 bg-blue-50"
                : "border-gray-200 bg-white"
            }`}
          >
            <span className="flex h-28 w-full items-center justify-center overflow-hidden rounded bg-gray-100">
              {page.dataUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={page.dataUrl}
                  alt={`Page ${page.pageNumber} preview`}
                  className="max-h-full max-w-full object-contain"
                />
              ) : (
                <span className="text-xs text-gray-500">Preview off</span>
              )}
            </span>
            <span className="mt-2 text-center text-xs font-semibold text-gray-700">
              Page {page.pageNumber}
            </span>
          </button>
        );
      })}
    </div>
  );
}
