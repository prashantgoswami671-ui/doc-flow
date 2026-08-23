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
            aria-label={`Page ${page.pageNumber}${selected ? ", selected" : ""}`}
            onClick={() => onPageClick?.(page)}
            disabled={disabled}
            className={`group relative flex flex-col rounded-lg border-2 p-2 text-left transition-all ${
              disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer"
            } ${
              selected
                ? "border-blue-600 bg-blue-50/70 ring-2 ring-blue-500/20 shadow-xs"
                : "border-gray-200 bg-white hover:border-blue-300 hover:bg-gray-50/50 hover:shadow-xs"
            } focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2`}
          >
            <span className="relative flex h-28 w-full items-center justify-center overflow-hidden rounded bg-gray-100">
              <span
                aria-hidden="true"
                className={`absolute left-1.5 top-1.5 z-10 flex h-5 w-5 items-center justify-center rounded-md border text-xs font-bold transition-colors ${
                  selected
                    ? "border-blue-600 bg-blue-600 text-white shadow-xs"
                    : "border-gray-300 bg-white/90 text-transparent group-hover:border-blue-400 group-hover:bg-white"
                }`}
              >
                {selected ? "✓" : ""}
              </span>
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
            <span
              className={`mt-2 text-center text-xs ${
                selected ? "font-bold text-blue-900" : "font-semibold text-gray-700"
              }`}
            >
              Page {page.pageNumber}
            </span>
          </button>
        );
      })}
    </div>
  );
}
