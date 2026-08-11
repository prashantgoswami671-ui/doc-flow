"use client";

import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import {
  anchorFor,
  rotatedBoundingBox,
  formatPageNumber,
  WATERMARK_MARGIN,
  PAGE_NUMBER_MARGIN,
  type WatermarkPosition,
  type PageNumberPosition,
  type PageNumberFormat,
} from "../services/pdf/watermark";

interface Props {
  file: File;
  pageCount: number;
  // Watermark
  watermarkEnabled: boolean;
  watermarkText: string;
  watermarkPosition: WatermarkPosition;
  watermarkRotation: number;
  watermarkOpacity: number; // 0-1
  watermarkFontSize: number; // points
  // Page numbers
  pageNumbersEnabled: boolean;
  pageNumberFormat: PageNumberFormat;
  pageNumberPosition: PageNumberPosition;
  startingNumber: number;
  pageNumberFontSize: number;
  pageRangeMode: "all" | "selected";
  selectedPagesPreview: number[] | null;
  maxDimension?: number;
}

export default function PdfWatermarkPreview({
  file,
  pageCount,
  watermarkEnabled,
  watermarkText,
  watermarkPosition,
  watermarkRotation,
  watermarkOpacity,
  watermarkFontSize,
  pageNumbersEnabled,
  pageNumberFormat,
  pageNumberPosition,
  startingNumber,
  pageNumberFontSize,
  pageRangeMode,
  selectedPagesPreview,
  maxDimension = 700,
}: Props) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [imageDataUrl, setImageDataUrl] = useState<string | null>(null);
  const [pageWidthPts, setPageWidthPts] = useState<number | null>(null);
  const [pageHeightPts, setPageHeightPts] = useState<number | null>(null);

  const pdfRef = useRef<object | null>(null);
  const loadingTaskRef = useRef<object | null>(null);
  const currentRenderController = useRef<{ cancelled: boolean } | null>(null);

  async function renderPage(pageNumber: number) {
    if (!pdfRef.current || !loadingTaskRef.current) return;
    if (pageNumber < 1 || pageNumber > pageCount) return;

    const controller = { cancelled: false };
    currentRenderController.current = controller;
    setLoading(true);
    setError(null);

    try {
      const pdf = pdfRef.current as { getPage: (n: number) => Promise<unknown> };
      const pageObj = await pdf.getPage(pageNumber);
      const page = pageObj as {
        cleanup?: () => void;
        getViewport: (opts: { scale: number }) => {
          width: number;
          height: number;
        };
        render: (opts: {
          canvas: HTMLCanvasElement;
          canvasContext: CanvasRenderingContext2D;
          viewport: { width: number; height: number };
        }) => { promise: Promise<void> };
      };

      if (controller.cancelled) {
        try {
          page.cleanup?.();
        } catch {}
        return;
      }

      const baseViewport = page.getViewport({ scale: 1 });
      const scale = Math.min(
        1,
        maxDimension / Math.max(baseViewport.width, baseViewport.height),
      );
      const viewport = page.getViewport({ scale });

      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.ceil(viewport.width));
      canvas.height = Math.max(1, Math.ceil(viewport.height));
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Unable to create canvas rendering context.");

      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);

      const renderTask = page.render({ canvas, canvasContext: context, viewport });
      await renderTask.promise;

      if (controller.cancelled) {
        try {
          page.cleanup?.();
          canvas.width = 0;
          canvas.height = 0;
        } catch {}
        return;
      }

      const dataUrl = canvas.toDataURL("image/png");
      setImageDataUrl(dataUrl);
      setPageWidthPts(baseViewport.width);
      setPageHeightPts(baseViewport.height);

      try {
        page.cleanup?.();
      } catch {}

      canvas.width = 0;
      canvas.height = 0;
    } catch (err) {
      if (controller.cancelled) return;
      console.error("PdfWatermarkPreview render error:", err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (!controller.cancelled) setLoading(false);
      currentRenderController.current = null;
    }
  }

  // Load PDF once per file
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      setError(null);
      setImageDataUrl(null);
      setPageWidthPts(null);
      setPageHeightPts(null);

      try {
        // Dynamic import to get pdfjs-dist module
        const pdfjsLibModule = await import("pdfjs-dist/legacy/build/pdf.mjs");
        const pdfjsLib = pdfjsLibModule as {
          GlobalWorkerOptions: { workerSrc?: string };
          getDocument: (opts: { data: Uint8Array }) => {
            promise: Promise<{
              cleanup: () => void;
              getPageCount?: () => number;
            }>;
            destroy: () => Promise<void>;
          };
        };

        // configure worker
        if (typeof window !== "undefined") {
          pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
            "pdfjs-dist/legacy/build/pdf.worker.min.mjs",
            import.meta.url,
          ).toString();
        }

        const inputBytes = new Uint8Array(await file.arrayBuffer());
        const loadingTask = pdfjsLib.getDocument({ data: inputBytes });
        loadingTaskRef.current = loadingTask;
        const pdf = await loadingTask.promise;
        if (cancelled) {
          try {
            pdf.cleanup();
            await loadingTask.destroy();
          } catch {}
          return;
        }

        pdfRef.current = pdf;
        // after loading render current page
        await renderPage(currentPage);
      } catch (err) {
        if (cancelled) return;
        console.error("PdfWatermarkPreview load error:", err);
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void load();

    return () => {
      cancelled = true;
      // cancel render
      if (currentRenderController.current) {
        currentRenderController.current.cancelled = true;
      }
      // cleanup pdf
      if (pdfRef.current && loadingTaskRef.current) {
        try {
          const pdf = pdfRef.current as { cleanup: () => void };
          const loadingTask = loadingTaskRef.current as { destroy: () => Promise<void> };
          pdf.cleanup();
          void loadingTask.destroy();
        } catch {}
        pdfRef.current = null;
        loadingTaskRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file]);

  // Re-render when page changes
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void renderPage(currentPage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentPage]);

  function gotoPrev() {
    setCurrentPage((p) => Math.max(1, p - 1));
  }
  function gotoNext() {
    setCurrentPage((p) => Math.min(pageCount, p + 1));
  }

  // We compute overlay styles using the rendered image's natural pixel size,
  // measured via an offscreen Image once the PNG data URL is ready. This is
  // real React state (not a ref) — a ref mutation alone never schedules a
  // re-render, so the overlay style would silently stay undefined until some
  // unrelated render happened to pick up the new value.
  const [measuredSize, setMeasuredSize] = useState<{ width: number; height: number } | null>(null);

  // Reset the stale measurement during render (not in an effect) whenever
  // imageDataUrl changes. This is React's documented pattern for "adjusting
  // state when a prop changes": calling setState synchronously in the render
  // body is safe (React discards the in-progress render and re-runs
  // immediately) and, unlike calling setState at the top of an effect, it
  // doesn't trigger react-hooks/set-state-in-effect or cause an extra
  // committed render.
  const [measuredForUrl, setMeasuredForUrl] = useState<string | null>(imageDataUrl);
  if (imageDataUrl !== measuredForUrl) {
    setMeasuredForUrl(imageDataUrl);
    setMeasuredSize(null);
  }

  useEffect(() => {
    if (!imageDataUrl) return;
    const img = new Image();
    let cancelled = false;
    img.onload = () => {
      if (cancelled) return;
      setMeasuredSize({ width: img.width, height: img.height });
    };
    img.onerror = () => {
      if (cancelled) return;
      setMeasuredSize(null);
    };
    img.src = imageDataUrl;

    return () => {
      cancelled = true;
    };
  }, [imageDataUrl]);

  function toOverlayStyleForText(
    text: string,
    fontSizePts: number,
    position: WatermarkPosition | PageNumberPosition,
    rotationDeg = 0,
    margin = WATERMARK_MARGIN,
    opacity = 1,
  ): CSSProperties | undefined {
    if (!imageDataUrl || !pageWidthPts || !pageHeightPts) return undefined;
    const measured = measuredSize;
    if (!measured) return undefined;

    const pxPerPoint = measured.width / pageWidthPts;
    const fontPx = Math.max(1, fontSizePts * pxPerPoint);

    // measure text width using canvas
    const mCanvas = document.createElement("canvas");
    const mCtx = mCanvas.getContext("2d");
    if (!mCtx) return undefined;
    mCtx.font = `${fontPx}px Helvetica, Arial, sans-serif`;
    const metrics = mCtx.measureText(text);
    const textWidthPx = metrics.width;
    const textHeightPx = fontPx; // approximate

    const textWidthPts = textWidthPx / pxPerPoint;
    const textHeightPts = textHeightPx / pxPerPoint; // should equal fontSizePts

    const bbox = rotatedBoundingBox(textWidthPts, textHeightPts, rotationDeg);

    const anchor = anchorFor(
      position,
      pageWidthPts,
      pageHeightPts,
      bbox.width,
      bbox.height,
      margin,
    );

    const xOriginPts = anchor.x - bbox.minX;
    const yOriginPts = anchor.y - bbox.minY;

    const leftPct = (xOriginPts / pageWidthPts) * 100;
    const bottomPct = (yOriginPts / pageHeightPts) * 100;

    const style: CSSProperties = {
      position: "absolute",
      left: `${leftPct}%`,
      bottom: `${bottomPct}%`,
      transform: `rotate(${rotationDeg}deg)`,
      transformOrigin: "left bottom",
      fontSize: `${fontPx}px`,
      fontFamily: "Helvetica, Arial, sans-serif",
      // Explicit color, not inherited. Without this the span inherits
      // `body`'s color var, which app/globals.css flips to near-white
      // (#ededed) under `prefers-color-scheme: dark`. The rendered PDF
      // page canvas is always drawn on a hardcoded white background
      // (see renderPage()'s `context.fillStyle = "#ffffff"`), so in dark
      // mode the watermark/page-number text became near-white-on-white —
      // rendered, correctly positioned, but visually invisible, with no
      // console error. Black also matches the actual applied watermark:
      // watermark.ts's toColor(undefined) defaults to rgb(0,0,0) and
      // WatermarkPdfCard never overrides it, so this stays a truthful
      // WYSIWYG preview of the real output.
      color: "#000000",
      opacity,
      pointerEvents: "none",
      whiteSpace: "nowrap",
    };

    return style;
  }

  // Compute page-number label and whether this page will be numbered
  const pageNumberLabel = (() => {
    if (!pageNumbersEnabled) return null;

    const selectedSorted =
      pageRangeMode === "all"
        ? Array.from({ length: pageCount }, (_, i) => i + 1)
        : (selectedPagesPreview ?? []).slice().sort((a, b) => a - b);

    if (pageRangeMode === "selected" && (!selectedSorted || selectedSorted.length === 0)) {
      return null;
    }

    const pageIndexInSelected = selectedSorted.indexOf(currentPage);
    if (pageIndexInSelected === -1) return null;

    const ordinal = pageIndexInSelected + 1;
    const currentNumber = startingNumber + ordinal - 1;
    const lastNumber = startingNumber + selectedSorted.length - 1;

    return formatPageNumber(pageNumberFormat, currentNumber, lastNumber);
  })();

  const pageNumberApplied = (() => {
    if (!pageNumbersEnabled) return false;
    if (pageRangeMode === "all") return true;
    return (selectedPagesPreview ?? []).includes(currentPage);
  })();

  return (
    <div>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={gotoPrev}
            disabled={currentPage <= 1 || loading}
            className="rounded-md border px-2 py-1 text-sm"
          >
            Previous
          </button>
          <button
            type="button"
            onClick={gotoNext}
            disabled={currentPage >= pageCount || loading}
            className="rounded-md border px-2 py-1 text-sm"
          >
            Next
          </button>
        </div>
        <div className="text-sm text-gray-600">
          Page {currentPage} of {pageCount}
        </div>
      </div>

      <div className="mt-3 rounded-lg border border-gray-200 bg-white p-4">
        {loading && (
          <div className="flex h-64 items-center justify-center">
            <p className="text-sm text-gray-500">Rendering preview...</p>
          </div>
        )}

        {!loading && error && (
          <div className="flex h-64 items-center justify-center px-6 text-center">
            <p className="text-sm font-medium text-amber-600">{error}</p>
          </div>
        )}

        {!loading && !error && imageDataUrl && pageWidthPts && pageHeightPts && (
          <div
            className="relative mx-auto w-full max-w-sm overflow-hidden rounded-lg border border-gray-300 bg-white shadow-sm"
            style={{ aspectRatio: `${pageWidthPts} / ${pageHeightPts}` }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={imageDataUrl}
              alt={`Page ${currentPage} preview`}
              className="absolute inset-0 h-full w-full object-contain"
            />

            {watermarkEnabled && watermarkText.trim() !== "" && (() => {
              const style = toOverlayStyle(watermarkText);
              if (!style) return null;
              return (
                <>
                  {/* Locator outline: always full opacity, purely an editor
                      affordance so the watermark's position/size/rotation
                      stay easy to find at any configured opacity. It reuses
                      the exact same computed style object (same left/
                      bottom/transform/fontSize) as the real text below —
                      only color/opacity are overridden — so it can never
                      drift out of sync with what's actually being placed.
                      It does not affect the real watermark's rendered
                      opacity, which stays exactly as configured. */}
                  <span
                    aria-hidden="true"
                    style={{
                      ...style,
                      color: "transparent",
                      WebkitTextStroke: "1px rgba(37, 99, 235, 0.45)",
                      opacity: 1,
                    }}
                  >
                    {watermarkText}
                  </span>
                  {/* Real watermark text, at the actual configured opacity —
                      this is the truthful WYSIWYG preview of what gets
                      drawn into the PDF. */}
                  <span style={style}>{watermarkText}</span>
                </>
              );
            })()}

            {pageNumbersEnabled && pageNumberLabel && (
              <span style={toOverlayStyle(pageNumberLabel, true)}>
                {pageNumberLabel}
              </span>
            )}

            {(!watermarkEnabled && !pageNumbersEnabled) && (
              <p className="mt-3 text-center text-xs text-gray-500 absolute left-0 right-0 bottom-2">Enable watermark or page numbers to preview changes.</p>
            )}

            {/* Indicate when page numbers are not applied to this page */}
            {pageNumbersEnabled && !pageNumberApplied && (
              <div className="absolute left-2 top-2 rounded bg-amber-100 px-2 py-1 text-xs font-medium text-amber-800">
                Page numbers will NOT be applied to this page
              </div>
            )}

          </div>
        )}
      </div>
    </div>
  );

  // helper wrapper to avoid repeating toOverlayStyleForText calls with different args
  function toOverlayStyle(text: string, isPageNumber = false): CSSProperties | undefined {
    if (isPageNumber) {
      return toOverlayStyleForText(
        text,
        pageNumberFontSize,
        pageNumberPosition,
        0,
        PAGE_NUMBER_MARGIN,
        1,
      );
    }
    return toOverlayStyleForText(
      text,
      watermarkFontSize,
      watermarkPosition,
      watermarkRotation as number,
      WATERMARK_MARGIN,
      watermarkOpacity,
    );
  }
}
