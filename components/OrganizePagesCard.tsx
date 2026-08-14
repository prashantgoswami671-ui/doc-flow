"use client";

import { useEffect, useRef, useState } from "react";
import {
  buildPageOperations,
  clampCropToPageBox,
  createManagedPages,
  cropFromRelative,
  displayNormalizedToNative,
  isReordered,
  movePage,
  normalizeRotation,
  organizePages,
  pdfCropToPixelCrop,
  pixelCropToPdfCrop,
  relativeCropFromPageBox,
  type ManagedPage,
  type OrganizeResult,
  type PageRotation,
  type PixelRect,
} from "../services/pdf/organize";
import {
  getPageBoxes,
  renderCropEditorPreview,
  renderPageThumbnails,
  type CropEditorPreview,
} from "../services/pdf/thumbnails";

const rotationOptions: { rotation: PageRotation; label: string }[] = [
  { rotation: 90, label: "Rotate 90°" },
  { rotation: 180, label: "Rotate 180°" },
  { rotation: 270, label: "Rotate 270°" },
];

const rotationClasses: Record<PageRotation, string> = {
  0: "",
  90: "rotate-90",
  180: "rotate-180",
  270: "-rotate-90",
};

const EDITOR_MAX_DIMENSION = 560;
const MIN_CROP_SIZE_PX = 12;

type CropHandle = "nw" | "ne" | "sw" | "se";

interface DragState {
  mode: "create" | "move" | "resize";
  handle?: CropHandle;
  startPointerNative: { x: number; y: number };
  startRect: PixelRect;
}

function isPdfFile(file: File): boolean {
  return (
    file.type === "application/pdf" ||
    file.name.toLowerCase().endsWith(".pdf")
  );
}

function getOrganizedFilename(originalName: string): string {
  if (originalName.toLowerCase().endsWith(".pdf")) {
    return `${originalName.slice(0, -4)}-organized.pdf`;
  }

  return `${originalName}-organized.pdf`;
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

/** Sorts two pointer-drag endpoints into a normalized (non-negative) rectangle. */
function normalizePixelRect(x0: number, y0: number, x1: number, y1: number): PixelRect {
  return {
    x: Math.min(x0, x1),
    y: Math.min(y0, y1),
    width: Math.abs(x1 - x0),
    height: Math.abs(y1 - y0),
  };
}

/** Keeps a crop rectangle, in render-pixel space, fully inside the rendered page. */
function clampPixelRect(rect: PixelRect, maxWidth: number, maxHeight: number): PixelRect {
  const width = Math.min(Math.max(rect.width, 0), maxWidth);
  const height = Math.min(Math.max(rect.height, 0), maxHeight);
  const x = Math.min(Math.max(rect.x, 0), maxWidth - width);
  const y = Math.min(Math.max(rect.y, 0), maxHeight - height);

  return { x, y, width, height };
}

function resizePixelRect(
  start: PixelRect,
  handle: CropHandle,
  dx: number,
  dy: number,
): PixelRect {
  let { x, y, width, height } = start;

  if (handle === "nw") {
    x = start.x + dx;
    y = start.y + dy;
    width = start.width - dx;
    height = start.height - dy;
  } else if (handle === "ne") {
    y = start.y + dy;
    width = start.width + dx;
    height = start.height - dy;
  } else if (handle === "sw") {
    x = start.x + dx;
    width = start.width - dx;
    height = start.height + dy;
  } else {
    width = start.width + dx;
    height = start.height + dy;
  }

  if (width < 0) {
    x += width;
    width = Math.abs(width);
  }

  if (height < 0) {
    y += height;
    height = Math.abs(height);
  }

  return {
    x,
    y,
    width: Math.max(width, MIN_CROP_SIZE_PX),
    height: Math.max(height, MIN_CROP_SIZE_PX),
  };
}

/**
 * Converts a pointer's screen position into unrotated render-pixel
 * coordinates. `rect` is the DISPLAYED (post CSS-rotation) bounding box of
 * the page element, so for a 90/270 rotation its width/height are already
 * swapped relative to the page's native render size — that swap, plus the
 * explicit rotation-aware inverse mapping below, is what keeps the crop box
 * aligned with the page regardless of how it's currently rotated on screen.
 */
function clientPointToNativePixels(
  clientX: number,
  clientY: number,
  rect: DOMRect,
  rotation: PageRotation,
  renderWidth: number,
  renderHeight: number,
): { x: number; y: number } {
  const nx = rect.width === 0 ? 0 : (clientX - rect.left) / rect.width;
  const ny = rect.height === 0 ? 0 : (clientY - rect.top) / rect.height;
  const { ux, uy } = displayNormalizedToNative(
    Math.min(Math.max(nx, 0), 1),
    Math.min(Math.max(ny, 0), 1),
    rotation,
  );

  return { x: ux * renderWidth, y: uy * renderHeight };
}

export default function OrganizePagesCard() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const isProcessingRef = useRef(false);
  const previewRequestIdRef = useRef(0);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [pages, setPages] = useState<ManagedPage[]>([]);
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
  const [dropTargetIndex, setDropTargetIndex] = useState<number | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isLoadingPreviews, setIsLoadingPreviews] = useState(false);
  const [previewProgress, setPreviewProgress] = useState("");
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [result, setResult] = useState<OrganizeResult | null>(null);

  // Page editor (crop + rotate) state.
  const pagesRef = useRef<ManagedPage[]>(pages);
  // Refs must not be mutated during render; keep this ref in sync as an effect.
  useEffect(() => {
    pagesRef.current = pages;
  }, [pages]);
  const editorRequestIdRef = useRef(0);
  const pageContentRef = useRef<HTMLDivElement>(null);
  const dragStateRef = useRef<DragState | null>(null);
  const [editorPageNumber, setEditorPageNumber] = useState<number | null>(null);
  const [editorPreview, setEditorPreview] = useState<CropEditorPreview | null>(null);
  const [isLoadingEditor, setIsLoadingEditor] = useState(false);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [editorNotice, setEditorNotice] = useState<string | null>(null);
  const [draftCropPx, setDraftCropPx] = useState<PixelRect | null>(null);
  const [isApplyingCropToSelected, setIsApplyingCropToSelected] = useState(false);

  const resetEditorState = () => {
    editorRequestIdRef.current += 1;
    dragStateRef.current = null;
    setEditorPageNumber(null);
    setEditorPreview(null);
    setIsLoadingEditor(false);
    setEditorError(null);
    setEditorNotice(null);
    setDraftCropPx(null);
    setIsApplyingCropToSelected(false);
  };

  const resetState = () => {
    previewRequestIdRef.current += 1;
    setSelectedFile(null);
    setPages([]);
    setDraggedIndex(null);
    setDropTargetIndex(null);
    setResult(null);
    setError(null);
    setSuccessMessage(null);
    setIsLoadingPreviews(false);
    setPreviewProgress("");
    resetEditorState();

    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  const loadPreviews = async (file: File) => {
    const requestId = ++previewRequestIdRef.current;

    setIsLoadingPreviews(true);
    setPreviewProgress("Loading page previews...");
    setPages([]);

    try {
      const thumbnails = await renderPageThumbnails(file, {
        onProgress: (progress) => {
          if (requestId === previewRequestIdRef.current) {
            setPreviewProgress(
              `Rendering page ${progress.currentPage} of ${progress.pageCount}...`,
            );
          }
        },
      });

      if (requestId !== previewRequestIdRef.current) return;

      const managedPages = createManagedPages(thumbnails);
      setPages(managedPages);
    } catch (previewError) {
      console.error("PDF page preview error:", previewError);

      if (requestId !== previewRequestIdRef.current) return;

      setError(
        previewError instanceof Error
          ? `Unable to load page previews: ${previewError.message}`
          : "Unable to load page previews for this PDF.",
      );
    } finally {
      if (requestId === previewRequestIdRef.current) {
        setIsLoadingPreviews(false);
        setPreviewProgress("");
      }
    }
  };

  const selectFile = (file: File | undefined) => {
    if (!file) return;

    if (!isPdfFile(file)) {
      resetState();
      setError("Please select a valid PDF file.");
      return;
    }

    previewRequestIdRef.current += 1;
    setSelectedFile(file);
    setPages([]);
    setResult(null);
    setError(null);
    setSuccessMessage(null);
    resetEditorState();
    void loadPreviews(file);
  };

  const toggleSelection = (sourcePageNumber: number) => {
    setPages((current) =>
      current.map((page) =>
        page.sourcePageNumber === sourcePageNumber
          ? { ...page, selected: !page.selected }
          : page,
      ),
    );
  };

  const rotateSelection = (rotation: PageRotation) => {
    setPages((current) =>
      current.map((page) =>
        page.selected && !page.deleted
          ? {
              ...page,
              rotation: normalizeRotation(page.rotation + rotation),
            }
          : page,
      ),
    );
  };

  const markSelectedDeleted = (deleted: boolean) => {
    setPages((current) =>
      current.map((page) =>
        page.selected ? { ...page, deleted } : page,
      ),
    );

    // If the page currently open in the editor is among the ones just marked
    // for deletion, close the editor safely rather than continuing to show a
    // page that's about to be removed.
    if (deleted && editorPageNumber !== null) {
      const editedPageWasSelected = pagesRef.current.some(
        (page) => page.sourcePageNumber === editorPageNumber && page.selected,
      );

      if (editedPageWasSelected) {
        resetEditorState();
      }
    }
  };

  const reorder = (fromIndex: number, toIndex: number) => {
    setPages((current) => movePage(current, fromIndex, toIndex));
  };

  // --- Single-page editor: load the unrotated preview whenever the edited
  // page (or the file) changes. ---
  useEffect(() => {
    // selectedFile/editorPageNumber only ever become null via resetEditorState
    // (called synchronously from event handlers), which already clears
    // editorPreview/draftCropPx itself — so there's nothing left to sync here.
    if (!selectedFile || editorPageNumber === null) {
      return;
    }

    const requestId = ++editorRequestIdRef.current;

    async function loadEditorPreview() {
      setIsLoadingEditor(true);
      setEditorError(null);
      setEditorNotice(null);

      try {
        const preview = await renderCropEditorPreview(
          selectedFile as File,
          editorPageNumber as number,
          EDITOR_MAX_DIMENSION,
        );

        if (requestId !== editorRequestIdRef.current) return;

        setEditorPreview(preview);

        const currentPage = pagesRef.current.find(
          (page) => page.sourcePageNumber === editorPageNumber,
        );

        setDraftCropPx(
          currentPage?.crop
            ? pdfCropToPixelCrop(currentPage.crop, preview.renderScale, preview.pageBox)
            : null,
        );
      } catch (previewError) {
        console.error("Crop editor preview error:", previewError);

        if (requestId !== editorRequestIdRef.current) return;

        setEditorPreview(null);
        setDraftCropPx(null);
        setEditorError(
          previewError instanceof Error
            ? `Unable to load the page editor: ${previewError.message}`
            : "Unable to load the page editor for this page.",
        );
      } finally {
        if (requestId === editorRequestIdRef.current) {
          setIsLoadingEditor(false);
        }
      }
    }

    void loadEditorPreview();
  }, [selectedFile, editorPageNumber]);

  const editorPage =
    editorPageNumber !== null
      ? pages.find((page) => page.sourcePageNumber === editorPageNumber) ?? null
      : null;
  const totalDisplayRotation: PageRotation = editorPreview
    ? normalizeRotation(editorPreview.pageRotation + (editorPage?.rotation ?? 0))
    : 0;
  const editorInteractionsEnabled =
    !!editorPreview && !isProcessing && !isLoadingEditor;

  const rotateEditorPage = (delta: PageRotation) => {
    if (editorPageNumber === null) return;

    setPages((current) =>
      current.map((page) =>
        page.sourcePageNumber === editorPageNumber && !page.deleted
          ? { ...page, rotation: normalizeRotation(page.rotation + delta) }
          : page,
      ),
    );
  };

  const resetEditorRotation = () => {
    if (editorPageNumber === null) return;

    setPages((current) =>
      current.map((page) =>
        page.sourcePageNumber === editorPageNumber ? { ...page, rotation: 0 } : page,
      ),
    );
  };

  const beginCreateDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!editorInteractionsEnabled || !editorPreview) return;

    const rect = pageContentRef.current?.getBoundingClientRect();
    if (!rect) return;

    const point = clientPointToNativePixels(
      event.clientX,
      event.clientY,
      rect,
      totalDisplayRotation,
      editorPreview.renderWidth,
      editorPreview.renderHeight,
    );

    pageContentRef.current?.setPointerCapture(event.pointerId);
    dragStateRef.current = {
      mode: "create",
      startPointerNative: point,
      startRect: { x: point.x, y: point.y, width: 0, height: 0 },
    };
    setDraftCropPx({ x: point.x, y: point.y, width: 0, height: 0 });
    setEditorNotice(null);
  };

  const beginMoveDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!editorInteractionsEnabled || !editorPreview || !draftCropPx) return;
    event.stopPropagation();

    const rect = pageContentRef.current?.getBoundingClientRect();
    if (!rect) return;

    const point = clientPointToNativePixels(
      event.clientX,
      event.clientY,
      rect,
      totalDisplayRotation,
      editorPreview.renderWidth,
      editorPreview.renderHeight,
    );

    pageContentRef.current?.setPointerCapture(event.pointerId);
    dragStateRef.current = { mode: "move", startPointerNative: point, startRect: draftCropPx };
  };

  const beginResizeDrag = (
    event: React.PointerEvent<HTMLDivElement>,
    handle: CropHandle,
  ) => {
    if (!editorInteractionsEnabled || !editorPreview || !draftCropPx) return;
    event.stopPropagation();

    const rect = pageContentRef.current?.getBoundingClientRect();
    if (!rect) return;

    const point = clientPointToNativePixels(
      event.clientX,
      event.clientY,
      rect,
      totalDisplayRotation,
      editorPreview.renderWidth,
      editorPreview.renderHeight,
    );

    pageContentRef.current?.setPointerCapture(event.pointerId);
    dragStateRef.current = {
      mode: "resize",
      handle,
      startPointerNative: point,
      startRect: draftCropPx,
    };
  };

  const handleEditorPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const dragState = dragStateRef.current;
    if (!dragState || !editorPreview) return;

    const rect = pageContentRef.current?.getBoundingClientRect();
    if (!rect) return;

    const point = clientPointToNativePixels(
      event.clientX,
      event.clientY,
      rect,
      totalDisplayRotation,
      editorPreview.renderWidth,
      editorPreview.renderHeight,
    );

    if (dragState.mode === "create") {
      const rectPx = normalizePixelRect(
        dragState.startPointerNative.x,
        dragState.startPointerNative.y,
        point.x,
        point.y,
      );
      setDraftCropPx(
        clampPixelRect(rectPx, editorPreview.renderWidth, editorPreview.renderHeight),
      );
    } else if (dragState.mode === "move") {
      const dx = point.x - dragState.startPointerNative.x;
      const dy = point.y - dragState.startPointerNative.y;
      const moved: PixelRect = {
        x: dragState.startRect.x + dx,
        y: dragState.startRect.y + dy,
        width: dragState.startRect.width,
        height: dragState.startRect.height,
      };
      setDraftCropPx(
        clampPixelRect(moved, editorPreview.renderWidth, editorPreview.renderHeight),
      );
    } else if (dragState.mode === "resize" && dragState.handle) {
      const dx = point.x - dragState.startPointerNative.x;
      const dy = point.y - dragState.startPointerNative.y;
      const resized = resizePixelRect(dragState.startRect, dragState.handle, dx, dy);
      setDraftCropPx(
        clampPixelRect(resized, editorPreview.renderWidth, editorPreview.renderHeight),
      );
    }
  };

  const endEditorDrag = () => {
    dragStateRef.current = null;
  };

  const handleResetCrop = () => {
    setDraftCropPx(null);
    setEditorNotice(null);

    if (editorPageNumber === null) return;

    setPages((current) =>
      current.map((page) =>
        page.sourcePageNumber === editorPageNumber ? { ...page, crop: undefined } : page,
      ),
    );
  };

  const handleApplyCropCurrent = () => {
    if (editorPageNumber === null || !editorPreview) return;

    if (!draftCropPx || draftCropPx.width < 1 || draftCropPx.height < 1) {
      setEditorNotice("Drag a crop rectangle over the page before applying it.");
      return;
    }

    const crop = clampCropToPageBox(
      pixelCropToPdfCrop(draftCropPx, editorPreview.renderScale, editorPreview.pageBox),
      editorPreview.pageBox,
    );

    setPages((current) =>
      current.map((page) =>
        page.sourcePageNumber === editorPageNumber ? { ...page, crop } : page,
      ),
    );
    setEditorNotice(`Crop applied to page ${editorPageNumber}.`);
  };

  const handleApplyCropToSelected = async () => {
    if (editorPageNumber === null || !editorPreview || !selectedFile) return;

    if (!draftCropPx || draftCropPx.width < 1 || draftCropPx.height < 1) {
      setEditorNotice("Drag a crop rectangle over the page before applying it.");
      return;
    }

    const targetPageNumbers = pagesRef.current
      .filter((page) => page.selected && !page.deleted)
      .map((page) => page.sourcePageNumber);

    if (targetPageNumbers.length === 0) {
      setEditorNotice(
        "Select at least one page (its thumbnail checkbox) to apply the crop to.",
      );
      return;
    }

    const crop = clampCropToPageBox(
      pixelCropToPdfCrop(draftCropPx, editorPreview.renderScale, editorPreview.pageBox),
      editorPreview.pageBox,
    );
    const relative = relativeCropFromPageBox(crop, editorPreview.pageBox);

    setIsApplyingCropToSelected(true);

    try {
      const otherPageNumbers = targetPageNumbers.filter((n) => n !== editorPageNumber);
      const boxes = await getPageBoxes(selectedFile, otherPageNumbers);
      boxes.set(editorPageNumber, editorPreview.pageBox);

      setPages((current) =>
        current.map((page) => {
          if (!targetPageNumbers.includes(page.sourcePageNumber)) return page;

          const pageBox = boxes.get(page.sourcePageNumber);
          if (!pageBox) return page;

          return { ...page, crop: cropFromRelative(relative, pageBox) };
        }),
      );
      setEditorNotice(
        `Crop applied to ${targetPageNumbers.length} selected page${
          targetPageNumbers.length === 1 ? "" : "s"
        }.`,
      );
    } catch (applyError) {
      console.error("Apply crop to selected pages error:", applyError);
      setEditorNotice(
        applyError instanceof Error
          ? `Could not apply the crop to every selected page: ${applyError.message}`
          : "Could not apply the crop to every selected page.",
      );
    } finally {
      setIsApplyingCropToSelected(false);
    }
  };

  /**
   * Saves the current page's pending crop/rotation into `pages` state (the
   * same pending-operations model `buildPageOperations` reads from) and
   * closes the editor, returning to the thumbnail view. Rotation is already
   * committed to `pages` as soon as a rotate button is clicked; this only
   * needs to additionally commit an in-progress crop drag that the user
   * hasn't explicitly applied yet. It never generates or downloads a PDF —
   * that only happens when the user clicks "Apply All Changes & Download
   * PDF" below.
   */
  const handleSavePageChanges = () => {
    if (
      editorPageNumber !== null &&
      editorPreview &&
      draftCropPx &&
      draftCropPx.width >= 1 &&
      draftCropPx.height >= 1
    ) {
      const crop = clampCropToPageBox(
        pixelCropToPdfCrop(draftCropPx, editorPreview.renderScale, editorPreview.pageBox),
        editorPreview.pageBox,
      );

      setPages((current) =>
        current.map((page) =>
          page.sourcePageNumber === editorPageNumber ? { ...page, crop } : page,
        ),
      );
    }

    resetEditorState();
  };

  const handleApplyChanges = async () => {
    if (isProcessingRef.current || !selectedFile) return;

    isProcessingRef.current = true;
    setIsProcessing(true);
    setError(null);
    setSuccessMessage(null);

    try {
      const organizeResult = await organizePages(
        selectedFile,
        buildPageOperations(pages),
      );

      setResult(organizeResult);
      downloadPdfBytes(
        organizeResult.bytes,
        getOrganizedFilename(selectedFile.name),
      );
      setSuccessMessage("Changes applied successfully.");
    } catch (organizeError) {
      console.error("PDF organize error:", organizeError);
      setError(
        organizeError instanceof Error
          ? `Could not apply changes: ${organizeError.message}`
          : "Failed to apply the requested page changes.",
      );
    } finally {
      isProcessingRef.current = false;
      setIsProcessing(false);
    }
  };

  const selectedCount = pages.filter((page) => page.selected).length;
  const deletedCount = pages.filter((page) => page.deleted).length;
  const rotatedCount = pages.filter(
    (page) => !page.deleted && page.rotation !== 0,
  ).length;
  const croppedCount = pages.filter((page) => !page.deleted && page.crop).length;
  const remainingCount = pages.length - deletedCount;
  const pagesReordered = isReordered(pages);
  const deletesEveryPage = pages.length > 0 && remainingCount === 0;
  const hasChanges =
    deletedCount > 0 || rotatedCount > 0 || croppedCount > 0 || pagesReordered;
  const canApply =
    selectedFile !== null &&
    pages.length > 0 &&
    hasChanges &&
    !deletesEveryPage &&
    !isLoadingPreviews &&
    !isProcessing;

  const editorDisplaySwapped =
    totalDisplayRotation === 90 || totalDisplayRotation === 270;

  return (
    <div className="w-full max-w-2xl mx-auto px-4 sm:px-6">
      <div className="bg-white rounded-2xl shadow-lg border border-gray-100 overflow-hidden">
        <div className="px-4 sm:px-6 pt-6 sm:pt-8">
          <h2 className="text-xl font-bold text-gray-900">Organize Pages</h2>
          <p className="mt-1 text-sm text-gray-500">
            Select pages to delete or rotate them, drag thumbnails to reorder,
            crop and rotate an individual page in the editor below, then apply
            everything in one step.
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
            Choose a PDF to organize
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
                {(selectedFile.size / 1024).toFixed(2)} KB
              </p>
            </div>
          )}

          {isLoadingPreviews && (
            <p className="mt-4 text-sm font-medium text-gray-500">
              {previewProgress}
            </p>
          )}
          {error && (
            <p className="mt-4 text-sm font-medium text-red-600">{error}</p>
          )}
          {successMessage && (
            <p className="mt-4 text-sm font-medium text-green-600">
              {successMessage}
            </p>
          )}

          {pages.length > 0 && (
            <>
              <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-medium text-gray-700">
                  {selectedCount} page{selectedCount === 1 ? "" : "s"} selected
                </p>
                {selectedCount > 0 && (
                  <button
                    type="button"
                    onClick={() =>
                      setPages((current) =>
                        current.map((page) => ({ ...page, selected: false })),
                      )
                    }
                    disabled={isProcessing}
                    className="text-sm font-medium text-blue-600 hover:text-blue-700 disabled:text-gray-400"
                  >
                    Clear selection
                  </button>
                )}
              </div>

              <div className="mt-3 flex flex-wrap gap-2">
                {rotationOptions.map((option) => (
                  <button
                    key={option.rotation}
                    type="button"
                    onClick={() => rotateSelection(option.rotation)}
                    disabled={selectedCount === 0 || isProcessing}
                    className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-medium text-gray-700 transition-colors hover:border-blue-300 hover:bg-blue-50 disabled:cursor-not-allowed disabled:border-gray-200 disabled:bg-gray-100 disabled:text-gray-400"
                  >
                    {option.label}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => markSelectedDeleted(true)}
                  disabled={selectedCount === 0 || isProcessing}
                  className="rounded-lg border border-red-200 bg-white px-3 py-2 text-sm font-medium text-red-600 transition-colors hover:border-red-300 hover:bg-red-50 disabled:cursor-not-allowed disabled:border-gray-200 disabled:bg-gray-100 disabled:text-gray-400"
                >
                  Mark for deletion
                </button>
                <button
                  type="button"
                  onClick={() => markSelectedDeleted(false)}
                  disabled={selectedCount === 0 || isProcessing}
                  className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-medium text-gray-700 transition-colors hover:border-blue-300 hover:bg-blue-50 disabled:cursor-not-allowed disabled:border-gray-200 disabled:bg-gray-100 disabled:text-gray-400"
                >
                  Keep pages
                </button>
              </div>

              <div className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-3">
                {pages.map((page, index) => {
                  const isDropTarget =
                    dropTargetIndex === index && draggedIndex !== index;
                  const isEditorPage = editorPageNumber === page.sourcePageNumber;

                  return (
                    <div
                      key={page.sourcePageNumber}
                      draggable={!isProcessing}
                      onDragStart={() => setDraggedIndex(index)}
                      onDragEnter={() => setDropTargetIndex(index)}
                      onDragOver={(event) => event.preventDefault()}
                      onDragEnd={() => {
                        setDraggedIndex(null);
                        setDropTargetIndex(null);
                      }}
                      onDrop={(event) => {
                        event.preventDefault();

                        if (draggedIndex !== null) {
                          reorder(draggedIndex, index);
                        }

                        setDraggedIndex(null);
                        setDropTargetIndex(null);
                      }}
                      className={`flex flex-col rounded-lg border-2 p-2 transition-colors ${
                        draggedIndex === index ? "opacity-50" : ""
                      } ${
                        isDropTarget
                          ? "border-blue-500 bg-blue-50"
                          : page.deleted
                            ? "border-red-400 bg-red-50"
                            : page.selected
                              ? "border-blue-500 bg-blue-50"
                              : isEditorPage
                                ? "border-purple-400 bg-purple-50/40"
                                : "border-gray-200 bg-white"
                      }`}
                    >
                      <button
                        type="button"
                        aria-pressed={page.selected}
                        aria-label={`Page ${page.sourcePageNumber}`}
                        onClick={() => toggleSelection(page.sourcePageNumber)}
                        disabled={isProcessing}
                        className="flex h-28 w-full cursor-pointer items-center justify-center overflow-hidden rounded bg-gray-100"
                      >
                        {page.thumbnailDataUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={page.thumbnailDataUrl}
                            alt={`Page ${page.sourcePageNumber} preview`}
                            className={`max-h-full object-contain transition-transform ${
                              page.rotation === 90 || page.rotation === 270
                                ? // Quarter turns swap the preview's axes, so cap
                                  // the pre-rotation width to the tile height.
                                  "max-w-[7rem]"
                                : "max-w-full"
                            } ${rotationClasses[page.rotation]} ${
                              page.deleted ? "opacity-40" : ""
                            }`}
                          />
                        ) : (
                          <span className="text-xs text-gray-500">
                            Preview off
                          </span>
                        )}
                      </button>

                      <div className="mt-2 flex items-center justify-between">
                        <button
                          type="button"
                          aria-label={`Move page ${page.sourcePageNumber} earlier`}
                          onClick={() => reorder(index, index - 1)}
                          disabled={index === 0 || isProcessing}
                          className="rounded px-1 text-xs text-gray-500 hover:bg-gray-100 disabled:text-gray-300"
                        >
                          ◀
                        </button>
                        <span
                          className={`text-xs font-semibold ${
                            page.deleted
                              ? "text-red-700 line-through"
                              : "text-gray-700"
                          }`}
                        >
                          Page {page.sourcePageNumber}
                        </span>
                        <button
                          type="button"
                          aria-label={`Move page ${page.sourcePageNumber} later`}
                          onClick={() => reorder(index, index + 1)}
                          disabled={index === pages.length - 1 || isProcessing}
                          className="rounded px-1 text-xs text-gray-500 hover:bg-gray-100 disabled:text-gray-300"
                        >
                          ▶
                        </button>
                      </div>

                      {page.rotation !== 0 && !page.deleted && (
                        <p className="mt-0.5 text-center text-xs text-blue-700">
                          {page.rotation}°
                        </p>
                      )}
                      {page.crop && !page.deleted && (
                        <p className="mt-0.5 text-center text-xs text-purple-700">
                          Cropped
                        </p>
                      )}
                      {page.deleted && (
                        <p className="mt-0.5 text-center text-xs font-semibold text-red-700">
                          Deleted
                        </p>
                      )}

                      <button
                        type="button"
                        onClick={() => setEditorPageNumber(page.sourcePageNumber)}
                        disabled={isProcessing || page.deleted}
                        className={`mt-1 w-full rounded px-1 py-0.5 text-[11px] font-medium transition-colors disabled:cursor-not-allowed disabled:text-gray-300 ${
                          isEditorPage
                            ? "bg-purple-600 text-white"
                            : "border border-purple-200 bg-white text-purple-700 hover:bg-purple-50"
                        }`}
                      >
                        {isEditorPage ? "Editing" : "Edit"}
                      </button>
                    </div>
                  );
                })}
              </div>

              <p className="mt-3 text-sm text-gray-500">
                {deletedCount} to delete · {rotatedCount} to rotate ·{" "}
                {croppedCount} to crop ·{" "}
                {pagesReordered ? "reordered" : "original order"} ·{" "}
                {remainingCount} page{remainingCount === 1 ? "" : "s"} remaining
              </p>

              {deletesEveryPage && (
                <p className="mt-2 text-sm font-medium text-amber-600">
                  You cannot delete every page. Keep at least one page.
                </p>
              )}

              {editorPageNumber !== null && (
              <div className="mt-6 rounded-xl border border-gray-200 bg-gray-50 p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-sm font-semibold text-gray-800">
                    Page editor — page {editorPageNumber}
                  </h3>
                  <div className="flex items-center gap-2">
                    {editorPage?.crop && (
                      <span className="text-xs font-medium text-purple-700">
                        Crop applied
                      </span>
                    )}
                    {editorPage && editorPage.rotation !== 0 && (
                      <span className="text-xs font-medium text-blue-700">
                        {editorPage.rotation}° rotated
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={handleSavePageChanges}
                      disabled={isProcessing}
                      className="rounded-lg bg-purple-600 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-purple-700 disabled:cursor-not-allowed disabled:bg-gray-300"
                    >
                      Save Page Changes
                    </button>
                  </div>
                </div>

                {isLoadingEditor && (
                  <p className="mt-3 text-sm font-medium text-gray-500">
                    Loading page editor...
                  </p>
                )}
                {editorError && (
                  <p className="mt-3 text-sm font-medium text-red-600">
                    {editorError}
                  </p>
                )}

                {editorPreview && (
                  <>
                    <div className="mt-4 flex items-center justify-center overflow-x-auto py-2">
                      <div
                        className="relative flex items-center justify-center"
                        style={{
                          width: editorDisplaySwapped
                            ? editorPreview.renderHeight
                            : editorPreview.renderWidth,
                          height: editorDisplaySwapped
                            ? editorPreview.renderWidth
                            : editorPreview.renderHeight,
                        }}
                      >
                        <div
                          ref={pageContentRef}
                          className={`relative select-none shadow ${rotationClasses[totalDisplayRotation]}`}
                          style={{
                            width: editorPreview.renderWidth,
                            height: editorPreview.renderHeight,
                            touchAction: "none",
                          }}
                          onPointerDown={beginCreateDrag}
                          onPointerMove={handleEditorPointerMove}
                          onPointerUp={endEditorDrag}
                          onPointerCancel={endEditorDrag}
                        >
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={editorPreview.dataUrl}
                            alt={`Page ${editorPageNumber} full preview`}
                            className="pointer-events-none block max-w-none select-none"
                            style={{
                              width: editorPreview.renderWidth,
                              height: editorPreview.renderHeight,
                            }}
                            draggable={false}
                          />

                          {draftCropPx && (
                            <div
                              className="absolute border-2 border-blue-500 bg-blue-500/10"
                              style={{
                                left: draftCropPx.x,
                                top: draftCropPx.y,
                                width: draftCropPx.width,
                                height: draftCropPx.height,
                                touchAction: "none",
                              }}
                              onPointerDown={beginMoveDrag}
                            >
                              {(["nw", "ne", "sw", "se"] as const).map((handle) => (
                                <div
                                  key={handle}
                                  onPointerDown={(event) =>
                                    beginResizeDrag(event, handle)
                                  }
                                  style={{ touchAction: "none" }}
                                  className={`absolute h-4 w-4 rounded-full border-2 border-white bg-blue-600 shadow ${
                                    handle === "nw"
                                      ? "-left-2 -top-2 cursor-nwse-resize"
                                      : handle === "ne"
                                        ? "-right-2 -top-2 cursor-nesw-resize"
                                        : handle === "sw"
                                          ? "-left-2 -bottom-2 cursor-nesw-resize"
                                          : "-right-2 -bottom-2 cursor-nwse-resize"
                                  }`}
                                />
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                    </div>

                    <p className="mt-2 text-center text-xs text-gray-500">
                      Drag on the page to draw a crop rectangle. Drag inside it to
                      move, or use the corner handles to resize.
                    </p>

                    <div className="mt-4 flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => rotateEditorPage(270)}
                        disabled={isProcessing}
                        className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-medium text-gray-700 transition-colors hover:border-blue-300 hover:bg-blue-50 disabled:cursor-not-allowed disabled:border-gray-200 disabled:bg-gray-100 disabled:text-gray-400"
                      >
                        ↺ Rotate left
                      </button>
                      <button
                        type="button"
                        onClick={() => rotateEditorPage(90)}
                        disabled={isProcessing}
                        className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-medium text-gray-700 transition-colors hover:border-blue-300 hover:bg-blue-50 disabled:cursor-not-allowed disabled:border-gray-200 disabled:bg-gray-100 disabled:text-gray-400"
                      >
                        ↻ Rotate right
                      </button>
                      <button
                        type="button"
                        onClick={() => rotateEditorPage(180)}
                        disabled={isProcessing}
                        className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-medium text-gray-700 transition-colors hover:border-blue-300 hover:bg-blue-50 disabled:cursor-not-allowed disabled:border-gray-200 disabled:bg-gray-100 disabled:text-gray-400"
                      >
                        180°
                      </button>
                      <button
                        type="button"
                        onClick={resetEditorRotation}
                        disabled={isProcessing}
                        className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-medium text-gray-700 transition-colors hover:border-blue-300 hover:bg-blue-50 disabled:cursor-not-allowed disabled:border-gray-200 disabled:bg-gray-100 disabled:text-gray-400"
                      >
                        Reset rotation
                      </button>
                    </div>

                    <div className="mt-3 flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={handleApplyCropCurrent}
                        disabled={isProcessing || !draftCropPx}
                        className="rounded-lg border border-purple-200 bg-white px-3 py-2 text-sm font-medium text-purple-700 transition-colors hover:border-purple-300 hover:bg-purple-50 disabled:cursor-not-allowed disabled:border-gray-200 disabled:bg-gray-100 disabled:text-gray-400"
                      >
                        Crop current page
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleApplyCropToSelected()}
                        disabled={isProcessing || isApplyingCropToSelected || !draftCropPx}
                        className="rounded-lg border border-purple-200 bg-white px-3 py-2 text-sm font-medium text-purple-700 transition-colors hover:border-purple-300 hover:bg-purple-50 disabled:cursor-not-allowed disabled:border-gray-200 disabled:bg-gray-100 disabled:text-gray-400"
                      >
                        {isApplyingCropToSelected
                          ? "Applying to selected..."
                          : "Crop selected pages"}
                      </button>
                      <button
                        type="button"
                        onClick={handleResetCrop}
                        disabled={isProcessing}
                        className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-medium text-gray-700 transition-colors hover:border-red-300 hover:bg-red-50 disabled:cursor-not-allowed disabled:border-gray-200 disabled:bg-gray-100 disabled:text-gray-400"
                      >
                        Reset crop
                      </button>
                    </div>

                    {editorNotice && (
                      <p className="mt-2 text-sm font-medium text-gray-600">
                        {editorNotice}
                      </p>
                    )}
                  </>
                )}
              </div>
              )}
            </>
          )}

          <button
            type="button"
            onClick={handleApplyChanges}
            disabled={!canApply}
            className={`mt-6 w-full rounded-lg px-4 py-3 text-sm font-semibold transition-colors ${
              canApply
                ? "bg-blue-600 text-white hover:bg-blue-700"
                : "bg-gray-200 text-gray-400 cursor-not-allowed"
            }`}
          >
            {isProcessing
              ? "Applying all changes..."
              : "Apply All Changes & Download PDF"}
          </button>

          {result && (
            <>
              <div className="mt-4 grid grid-cols-2 sm:grid-cols-5 gap-3">
                <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2">
                  <p className="text-xs text-gray-500">Original pages</p>
                  <p className="mt-0.5 text-sm font-semibold text-gray-800">
                    {result.originalPageCount}
                  </p>
                </div>
                <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2">
                  <p className="text-xs text-gray-500">Deleted</p>
                  <p className="mt-0.5 text-sm font-semibold text-gray-800">
                    {result.deletedPageCount}
                  </p>
                </div>
                <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2">
                  <p className="text-xs text-gray-500">Rotated</p>
                  <p className="mt-0.5 text-sm font-semibold text-gray-800">
                    {result.rotatedPageCount}
                  </p>
                </div>
                <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2">
                  <p className="text-xs text-gray-500">Cropped</p>
                  <p className="mt-0.5 text-sm font-semibold text-gray-800">
                    {result.croppedPageCount}
                  </p>
                </div>
                <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2">
                  <p className="text-xs text-gray-500">Remaining</p>
                  <p className="mt-0.5 text-sm font-semibold text-gray-800">
                    {result.remainingPageCount}
                  </p>
                </div>
              </div>

              <p className="mt-2 text-sm text-gray-500">
                {result.reordered ? "Pages reordered · " : ""}Completed in{" "}
                {(result.processingTime / 1000).toFixed(2)}s.
              </p>

              <button
                type="button"
                onClick={() =>
                  downloadPdfBytes(
                    result.bytes,
                    getOrganizedFilename(selectedFile?.name ?? "Unknown.pdf"),
                  )
                }
                className="mt-3 w-full rounded-lg bg-blue-600 px-4 py-3 text-sm font-semibold text-white transition-colors hover:bg-blue-700"
              >
                Download PDF Again
              </button>

              <button
                type="button"
                onClick={resetState}
                className="mt-3 w-full rounded-lg border border-gray-300 bg-white px-4 py-3 text-sm font-semibold text-gray-700 transition-colors hover:bg-gray-50"
              >
                Organize another PDF
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
