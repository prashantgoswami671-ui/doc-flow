"use client";

import { useEffect, useRef, useState } from "react";
import {
  assertOrganizablePdf,
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
  renderSinglePagePreview,
  type CropEditorPreview,
  type SinglePagePreview,
} from "../services/pdf/thumbnails";
import ResultPanel from "./ResultPanel";
import UploadZone from "./UploadZone";

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
  const isProcessingRef = useRef(false);
  const previewRequestIdRef = useRef(0);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [pages, setPages] = useState<ManagedPage[]>([]);
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
  const [dropTargetIndex, setDropTargetIndex] = useState<number | null>(null);
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
  // Snapshot of `pages` immediately after previews finish loading, so
  // "Reset" can restore the original page state/order without re-uploading.
  const initialPagesRef = useRef<ManagedPage[]>([]);
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

  // Large readable page preview modal state (reuses renderSinglePagePreview from Fix Page Orientation).
  const singlePreviewRequestIdRef = useRef(0);
  const previewImageCacheRef = useRef<Map<number, SinglePagePreview>>(new Map());
  const [previewModalPageNumber, setPreviewModalPageNumber] = useState<number | null>(null);
  const [previewImage, setPreviewImage] = useState<SinglePagePreview | null>(null);
  const [isLoadingPreviewImage, setIsLoadingPreviewImage] = useState(false);
  const [previewImageError, setPreviewImageError] = useState<string | null>(null);

  const resetLargePreviewState = () => {
    singlePreviewRequestIdRef.current += 1;
    setPreviewModalPageNumber(null);
    setPreviewImage(null);
    setIsLoadingPreviewImage(false);
    setPreviewImageError(null);
  };

  const loadLargePreviewImage = async (file: File, pageNumber: number) => {
    const requestId = ++singlePreviewRequestIdRef.current;
    setIsLoadingPreviewImage(true);
    setPreviewImageError(null);

    const cached = previewImageCacheRef.current.get(pageNumber);
    if (cached) {
      setPreviewImage(cached);
      setIsLoadingPreviewImage(false);
      return;
    }

    try {
      const preview = await renderSinglePagePreview(file, pageNumber);

      if (requestId !== singlePreviewRequestIdRef.current) return;

      previewImageCacheRef.current.set(pageNumber, preview);
      setPreviewImage(preview);
    } catch (previewError) {
      console.error("PDF page large preview error:", previewError);

      if (requestId !== singlePreviewRequestIdRef.current) return;

      setPreviewImageError(
        previewError instanceof Error
          ? `Unable to load a large preview: ${previewError.message}`
          : "Unable to load a large preview of this page.",
      );
    } finally {
      if (requestId === singlePreviewRequestIdRef.current) {
        setIsLoadingPreviewImage(false);
      }
    }
  };

  const openPreviewModal = (sourcePageNumber: number) => {
    setPreviewModalPageNumber(sourcePageNumber);
    if (selectedFile) {
      void loadLargePreviewImage(selectedFile, sourcePageNumber);
    }
  };

  const closePreviewModal = () => {
    singlePreviewRequestIdRef.current += 1;
    setPreviewModalPageNumber(null);
    setPreviewImage(null);
    setIsLoadingPreviewImage(false);
    setPreviewImageError(null);
  };

  // Dismiss the enlarged preview with Escape while it's open.
  useEffect(() => {
    if (previewModalPageNumber === null) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closePreviewModal();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [previewModalPageNumber]);

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
    previewImageCacheRef.current.clear();
    resetLargePreviewState();
    resetEditorState();
  };

  const loadPreviews = async (file: File) => {
    const requestId = ++previewRequestIdRef.current;

    setIsLoadingPreviews(true);
    setPreviewProgress("Loading page previews...");
    setPages([]);

    try {
      // Probe with pdf-lib first so an encrypted PDF gets a clear message
      // here, instead of PDF.js's opaque password error partway through
      // rendering thumbnails below.
      await assertOrganizablePdf(file);

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
      initialPagesRef.current = managedPages;
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

  // Uploading/replacing the PDF must be locked out while previews are
  // still loading or while Apply is running, so a new selection can never
  // race with in-flight preview rendering or clobber a file mid-apply.
  const uploadDisabled = isLoadingPreviews || isProcessing;

  const selectFile = (file: File | undefined) => {
    if (uploadDisabled || !file) return;

    if (!isPdfFile(file)) {
      resetState();
      setError("Please select a valid PDF file.");
      return;
    }

    previewRequestIdRef.current += 1;
    previewImageCacheRef.current.clear();
    resetLargePreviewState();
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

  const selectAllPages = () => {
    setPages((current) => current.map((page) => ({ ...page, selected: true })));
  };

  const clearSelection = () => {
    setPages((current) => current.map((page) => ({ ...page, selected: false })));
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

  /**
   * Reverts all pending edits (selection, deletions, rotation, crop, and
   * order) back to how the PDF was originally loaded, without re-uploading
   * it. Does not touch the uploaded file itself.
   */
  const resetToOriginal = () => {
    setPages(initialPagesRef.current.map((page) => ({ ...page })));
    resetLargePreviewState();
    resetEditorState();
    setResult(null);
    setError(null);
    setSuccessMessage(null);
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
  const modalPageIndex =
    previewModalPageNumber !== null
      ? pages.findIndex((page) => page.sourcePageNumber === previewModalPageNumber)
      : -1;
  const modalPage = modalPageIndex !== -1 ? pages[modalPageIndex] : null;
  const canGoPrev = modalPageIndex > 0;
  const canGoNext = modalPageIndex !== -1 && modalPageIndex < pages.length - 1;

  const goToAdjacentPage = (direction: -1 | 1) => {
    if (modalPageIndex === -1) return;
    const nextIndex = modalPageIndex + direction;
    if (nextIndex < 0 || nextIndex >= pages.length) return;
    openPreviewModal(pages[nextIndex].sourcePageNumber);
  };
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

        <UploadZone
          accept=".pdf,application/pdf"
          title={
            uploadDisabled
              ? isProcessing
                ? "Upload locked while changes are being applied"
                : "Upload locked while previews are loading"
              : "Choose a PDF to organize"
          }
          helperText={
            uploadDisabled
              ? "Please wait for the current step to finish."
              : "or drag and drop it here"
          }
          onFileSelect={selectFile}
          disabled={uploadDisabled}
          className="mx-4 sm:mx-6 mt-6 mb-4"
        />

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
            <p
              role="status"
              aria-live="polite"
              aria-atomic="true"
              className="mt-4 text-sm font-medium text-gray-500"
            >
              {previewProgress}
            </p>
          )}
          {error && (
            <p role="alert" className="mt-4 text-sm font-medium text-red-600">
              {error}
            </p>
          )}
          {pages.length > 0 && (
            <>
              <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="text-sm font-medium text-gray-700">
                    {pages.length} page{pages.length === 1 ? "" : "s"} ·{" "}
                    <span
                      className={
                        selectedCount > 0 ? "font-semibold text-blue-700" : "text-gray-500"
                      }
                    >
                      {selectedCount === 0
                        ? "None selected"
                        : selectedCount === 1
                          ? `Page ${pages.find((p) => p.selected)?.sourcePageNumber} selected`
                          : `${selectedCount} selected`}
                    </span>
                  </p>
                  <p className="text-xs text-gray-500">
                    Click to select · Double-click any page to preview full size
                  </p>
                </div>

                <div className="flex items-center gap-3">
                  {pages.length > 0 && selectedCount < pages.length && (
                    <button
                      type="button"
                      onClick={selectAllPages}
                      disabled={isProcessing}
                      className="text-sm font-medium text-blue-600 hover:text-blue-700 disabled:text-gray-400"
                    >
                      Select all
                    </button>
                  )}
                  {selectedCount > 0 && (
                    <button
                      type="button"
                      onClick={clearSelection}
                      disabled={isProcessing}
                      className="text-sm font-medium text-blue-600 hover:text-blue-700 disabled:text-gray-400"
                    >
                      Clear selection
                    </button>
                  )}
                </div>
              </div>

              <div className="mt-3 flex flex-wrap items-center gap-2">
                <div className="flex flex-wrap gap-2">
                  {rotationOptions.map((option) => (
                    <button
                      key={option.rotation}
                      type="button"
                      onClick={() => rotateSelection(option.rotation)}
                      disabled={selectedCount === 0 || isProcessing}
                      aria-label={
                        selectedCount === 1
                          ? `Rotate page ${pages.find((p) => p.selected)?.sourcePageNumber} ${option.rotation}°`
                          : selectedCount > 1
                            ? `Rotate ${selectedCount} selected pages ${option.rotation}°`
                            : option.label
                      }
                      title={
                        selectedCount === 0
                          ? "Select at least one page to rotate"
                          : undefined
                      }
                      className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-medium text-gray-700 transition-colors hover:border-blue-300 hover:bg-blue-50 disabled:cursor-not-allowed disabled:border-gray-200 disabled:bg-gray-100 disabled:text-gray-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                    >
                      {option.label}
                    </button>
                  ))}
                </div>

                <div
                  aria-hidden="true"
                  className="hidden h-6 w-px bg-gray-200 sm:block"
                />

                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => markSelectedDeleted(true)}
                    disabled={selectedCount === 0 || isProcessing}
                    aria-label={
                      selectedCount === 1
                        ? `Mark page ${pages.find((p) => p.selected)?.sourcePageNumber} for deletion`
                        : selectedCount > 1
                          ? `Mark ${selectedCount} selected pages for deletion`
                          : "Mark for deletion"
                    }
                    title={
                      selectedCount === 0
                        ? "Select at least one page to mark for deletion"
                        : undefined
                    }
                    className="rounded-lg border border-red-200 bg-white px-3 py-2 text-sm font-medium text-red-600 transition-colors hover:border-red-300 hover:bg-red-50 disabled:cursor-not-allowed disabled:border-gray-200 disabled:bg-gray-100 disabled:text-gray-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500"
                  >
                    Mark for deletion
                  </button>
                  <button
                    type="button"
                    onClick={() => markSelectedDeleted(false)}
                    disabled={selectedCount === 0 || isProcessing}
                    aria-label={
                      selectedCount === 1
                        ? `Keep page ${pages.find((p) => p.selected)?.sourcePageNumber}`
                        : selectedCount > 1
                          ? `Keep ${selectedCount} selected pages`
                          : "Keep pages"
                    }
                    title={
                      selectedCount === 0
                        ? "Select at least one page to keep"
                        : undefined
                    }
                    className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-medium text-gray-700 transition-colors hover:border-blue-300 hover:bg-blue-50 disabled:cursor-not-allowed disabled:border-gray-200 disabled:bg-gray-100 disabled:text-gray-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                  >
                    Keep pages
                  </button>
                </div>
              </div>

              <div className="mt-3 grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
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
                      className={`group relative flex flex-col rounded-lg border-2 p-2 transition-all ${
                        draggedIndex === index ? "opacity-50" : ""
                      } ${
                        isDropTarget
                          ? "border-blue-500 bg-blue-50 shadow-md"
                          : page.deleted && page.selected
                            ? "border-red-500 bg-red-100/80 ring-2 ring-red-400/30"
                            : page.deleted
                              ? "border-red-300 bg-red-50/70"
                              : page.selected
                                ? "border-blue-600 bg-blue-50/80 ring-2 ring-blue-500/20 shadow-xs"
                                : isEditorPage
                                  ? "border-purple-400 bg-purple-50/40 ring-2 ring-purple-300/30"
                                  : "border-gray-200 bg-white hover:border-blue-300 hover:bg-gray-50/50 hover:shadow-xs"
                      }`}
                    >
                      <button
                        type="button"
                        aria-pressed={page.selected}
                        aria-label={`Page ${page.sourcePageNumber}${page.selected ? ", selected" : ""}. Double-click to preview full page.`}
                        title={`Page ${page.sourcePageNumber} — click to select, double-click to view full page`}
                        onClick={() => toggleSelection(page.sourcePageNumber)}
                        onDoubleClick={() => openPreviewModal(page.sourcePageNumber)}
                        disabled={isProcessing}
                        className={`relative flex h-28 w-full cursor-pointer items-center justify-center overflow-hidden rounded transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 ${
                          page.selected ? "bg-blue-100/50" : "bg-gray-100 hover:bg-gray-200/60"
                        }`}
                      >
                        <span
                          aria-hidden="true"
                          className={`absolute left-1.5 top-1.5 z-10 flex h-5 w-5 items-center justify-center rounded-md border text-xs font-bold transition-colors ${
                            page.selected
                              ? "border-blue-600 bg-blue-600 text-white shadow-xs"
                              : "border-gray-300 bg-white/90 text-transparent group-hover:border-blue-400 group-hover:bg-white"
                          }`}
                        >
                          {page.selected ? "✓" : ""}
                        </span>

                        {isEditorPage && (
                          <span
                            aria-hidden="true"
                            className="absolute right-1.5 top-1.5 z-10 rounded bg-purple-600 px-1.5 py-0.5 text-[10px] font-semibold text-white shadow-xs"
                          >
                            Active
                          </span>
                        )}

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
                          className="rounded px-1.5 py-0.5 text-xs text-gray-500 hover:bg-gray-100 hover:text-gray-800 disabled:cursor-not-allowed disabled:text-gray-300 focus:outline-none focus-visible:ring-1 focus-visible:ring-blue-500"
                        >
                          ◀
                        </button>
                        <span
                          className={`text-xs ${
                            page.deleted
                              ? "font-semibold text-red-700 line-through"
                              : page.selected
                                ? "font-bold text-blue-900"
                                : "font-semibold text-gray-700"
                          }`}
                        >
                          Page {page.sourcePageNumber}
                        </span>
                        <button
                          type="button"
                          aria-label={`Move page ${page.sourcePageNumber} later`}
                          onClick={() => reorder(index, index + 1)}
                          disabled={index === pages.length - 1 || isProcessing}
                          className="rounded px-1.5 py-0.5 text-xs text-gray-500 hover:bg-gray-100 hover:text-gray-800 disabled:cursor-not-allowed disabled:text-gray-300 focus:outline-none focus-visible:ring-1 focus-visible:ring-blue-500"
                        >
                          ▶
                        </button>
                      </div>

                      <div className="min-h-[18px] flex items-center justify-center gap-1 flex-wrap mt-0.5">
                        {page.rotation !== 0 && !page.deleted && (
                          <span className="inline-flex items-center text-[11px] font-medium text-blue-700">
                            ↻ {page.rotation}°
                          </span>
                        )}
                        {page.crop && !page.deleted && (
                          <span className="inline-flex items-center text-[11px] font-medium text-purple-700">
                            ✂ Cropped
                          </span>
                        )}
                        {page.deleted && (
                          <span className="inline-flex items-center text-[11px] font-bold text-red-700">
                            ✕ Deleted
                          </span>
                        )}
                      </div>

                      <button
                        type="button"
                        onClick={() => setEditorPageNumber(page.sourcePageNumber)}
                        disabled={isProcessing || page.deleted}
                        aria-label={
                          isEditorPage
                            ? `Currently editing page ${page.sourcePageNumber}`
                            : `Edit crop and rotation for page ${page.sourcePageNumber}`
                        }
                        className={`mt-1 w-full rounded px-1 py-1 text-[11px] font-medium transition-colors disabled:cursor-not-allowed disabled:border-gray-200 disabled:bg-gray-100 disabled:text-gray-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-500 ${
                          isEditorPage
                            ? "bg-purple-600 text-white font-semibold shadow-xs"
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
                  <p
                    role="status"
                    aria-live="polite"
                    aria-atomic="true"
                    className="mt-3 text-sm font-medium text-gray-500"
                  >
                    Loading page editor...
                  </p>
                )}
                {editorError && (
                  <p
                    role="alert"
                    className="mt-3 text-sm font-medium text-red-600"
                  >
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
                      <p
                        role="status"
                        aria-live="polite"
                        aria-atomic="true"
                        className="mt-2 text-sm font-medium text-gray-600"
                      >
                        {editorNotice}
                      </p>
                    )}
                  </>
                )}
              </div>
              )}
            </>
          )}

          {pages.length > 0 && (
            <button
              type="button"
              onClick={resetToOriginal}
              disabled={!hasChanges || isProcessing}
              className="mt-6 w-full rounded-lg border border-gray-300 bg-white px-4 py-3 text-sm font-semibold text-gray-700 transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:border-gray-200 disabled:text-gray-400"
            >
              Reset
            </button>
          )}

          <button
            type="button"
            onClick={handleApplyChanges}
            disabled={!canApply}
            aria-busy={isProcessing}
            className={`mt-3 flex w-full items-center justify-center rounded-lg px-4 py-3 text-sm font-semibold transition-colors ${
              canApply
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
            {isProcessing
              ? "Applying all changes..."
              : "Apply All Changes & Download PDF"}
          </button>

          {isProcessing && (
            <p
              role="status"
              aria-live="polite"
              aria-atomic="true"
              className="mt-2 text-center text-xs text-gray-500"
            >
              Applying all changes — this may take a moment.
            </p>
          )}
        </div>

        {result && (
          <ResultPanel
            icon="✓"
            title="Changes applied"
            message={`${successMessage ?? "Your PDF has been updated and downloaded."} · ${(result.processingTime / 1000).toFixed(2)}s${result.reordered ? " · Pages reordered" : ""}`}
            stats={[
              { label: "Original pages", value: result.originalPageCount },
              { label: "Deleted", value: result.deletedPageCount },
              { label: "Rotated", value: result.rotatedPageCount },
              { label: "Cropped", value: result.croppedPageCount },
              { label: "Remaining", value: result.remainingPageCount },
            ]}
            onDownload={() =>
              downloadPdfBytes(
                result.bytes,
                getOrganizedFilename(selectedFile?.name ?? "Unknown.pdf"),
              )
            }
            downloadLabel="Download PDF Again"
            onReset={resetState}
            resetLabel="Organize another PDF"
          />
        )}
      </div>

      {/* LARGE READABLE PAGE PREVIEW MODAL */}
      {previewModalPageNumber !== null && modalPage && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`Page ${modalPage.sourcePageNumber} preview`}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4 sm:p-6"
          onClick={closePreviewModal}
        >
          <div
            className="relative flex flex-col max-h-[90vh] w-full max-w-4xl rounded-2xl bg-white shadow-2xl overflow-hidden"
            onClick={(event) => event.stopPropagation()}
          >
            {/* Modal Header */}
            <div className="flex items-center justify-between border-b border-gray-100 px-5 py-3.5 bg-gray-50/70">
              <div className="flex flex-wrap items-center gap-2.5">
                <span className="text-base font-bold text-gray-900">
                  Page {modalPageIndex + 1} of {pages.length}
                </span>
                {modalPage.sourcePageNumber !== modalPageIndex + 1 && (
                  <span className="text-xs text-gray-500">
                    (Original Page {modalPage.sourcePageNumber})
                  </span>
                )}
                <div className="flex flex-wrap items-center gap-1.5 ml-1">
                  {modalPage.selected && (
                    <span className="rounded-full bg-blue-100 px-2.5 py-0.5 text-xs font-semibold text-blue-700">
                      ✓ Selected
                    </span>
                  )}
                  {modalPage.rotation !== 0 && !modalPage.deleted && (
                    <span className="rounded-full bg-blue-50 border border-blue-200 px-2 py-0.5 text-xs font-medium text-blue-700">
                      ↻ {modalPage.rotation}° rotated
                    </span>
                  )}
                  {modalPage.crop && !modalPage.deleted && (
                    <span className="rounded-full bg-purple-100 px-2.5 py-0.5 text-xs font-medium text-purple-700">
                      ✂ Cropped
                    </span>
                  )}
                  {modalPage.deleted && (
                    <span className="rounded-full bg-red-100 px-2.5 py-0.5 text-xs font-bold text-red-700">
                      ✕ Marked for deletion
                    </span>
                  )}
                </div>
              </div>

              <button
                type="button"
                onClick={closePreviewModal}
                aria-label="Close preview"
                className="rounded-full p-1.5 text-gray-400 hover:bg-gray-200 hover:text-gray-700 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 cursor-pointer"
              >
                <span className="text-xl font-bold leading-none">✕</span>
              </button>
            </div>

            {/* Deletion Warning Banner in Modal */}
            {modalPage.deleted && (
              <div className="bg-red-50 border-b border-red-200 px-5 py-2.5 text-xs font-medium text-red-700 flex items-center justify-between">
                <span>This page is marked for deletion and will be omitted when changes are applied.</span>
                <button
                  type="button"
                  onClick={() => {
                    setPages((current) =>
                      current.map((p) =>
                        p.sourcePageNumber === modalPage.sourcePageNumber
                          ? { ...p, deleted: false }
                          : p,
                      ),
                    );
                  }}
                  className="underline font-semibold hover:text-red-900 ml-2 cursor-pointer"
                >
                  Keep page
                </button>
              </div>
            )}

            {/* High-Resolution Content Area */}
            <div className="flex-1 overflow-auto p-4 sm:p-6 flex items-center justify-center bg-gray-100/60 min-h-[320px]">
              {isLoadingPreviewImage && (
                <div className="flex flex-col items-center justify-center py-20 text-gray-500">
                  <svg
                    className="h-8 w-8 animate-spin text-blue-600 mb-3"
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
                  <p className="text-sm font-medium text-gray-600">
                    Loading high-resolution page content...
                  </p>
                </div>
              )}

              {previewImageError && (
                <div
                  role="alert"
                  className="py-12 text-center text-red-600 text-sm font-medium"
                >
                  {previewImageError}
                </div>
              )}

              {!isLoadingPreviewImage && !previewImageError && previewImage && (
                <div className="flex flex-col items-center justify-center">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={previewImage.dataUrl}
                    alt={`Page ${modalPage.sourcePageNumber} large readable preview`}
                    className={`max-h-[70vh] w-auto max-w-full object-contain rounded shadow-lg bg-white transition-transform duration-200 ${
                      rotationClasses[modalPage.rotation]
                    } ${modalPage.deleted ? "opacity-40" : ""}`}
                  />
                </div>
              )}
            </div>

            {/* Modal Footer / Navigation */}
            <div className="flex items-center justify-between border-t border-gray-100 px-5 py-3 bg-white">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => goToAdjacentPage(-1)}
                  disabled={!canGoPrev || isProcessing}
                  aria-label="Previous page"
                  className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                >
                  ◀ Previous
                </button>
                <button
                  type="button"
                  onClick={() => goToAdjacentPage(1)}
                  disabled={!canGoNext || isProcessing}
                  aria-label="Next page"
                  className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                >
                  Next ▶
                </button>
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => toggleSelection(modalPage.sourcePageNumber)}
                  className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors cursor-pointer ${
                    modalPage.selected
                      ? "bg-blue-50 text-blue-700 border border-blue-200 hover:bg-blue-100"
                      : "bg-blue-600 text-white hover:bg-blue-700"
                  }`}
                >
                  {modalPage.selected ? "Deselect page" : "Select page"}
                </button>
                <button
                  type="button"
                  onClick={closePreviewModal}
                  className="rounded-lg border border-gray-300 bg-white px-4 py-1.5 text-xs font-semibold text-gray-700 hover:bg-gray-50 cursor-pointer"
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
