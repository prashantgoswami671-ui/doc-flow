import type { ComponentType } from "react";

import OrganizePagesCard from "../OrganizePagesCard";
import ExtractPagesCard from "../ExtractPagesCard";
import SplitPdfCard from "../SplitPdfCard";
import InsertPagesCard from "../InsertPagesCard";
import MergePdfCard from "../MergePdfCard";
import ImageToPdfCard from "../ImageToPdfCard";
import PdfToImageCard from "../PdfToImageCard";
import CompressPdfCard from "../CompressPdfCard";
import FixPageOrientationCard from "../FixPageOrientationCard";
import RepairValidatePdfCard from "../RepairValidatePdfCard";
import MetadataEditorCard from "../MetadataEditorCard";
import WatermarkPdfCard from "../WatermarkPdfCard";
import ProtectPdfCard from "../ProtectPdfCard";
import UnlockPdfCard from "../UnlockPdfCard";
import SummarizePdfCard from "../SummarizePdfCard";

/**
 * Maps a tool-catalog slug to its existing, already-functional tool
 * component. This is the ONLY file that imports the tool cards for routing
 * purposes — app/tools/[slug]/page.tsx looks components up here and renders
 * them unmodified. Adding a tool means adding an entry both here and in
 * lib/toolCatalog.ts; the two are kept in sync deliberately rather than
 * merged, so the catalog (used for homepage rendering) never has to import
 * "use client" tool components itself.
 */
export const TOOL_COMPONENTS: Record<string, ComponentType> = {
  "organize-pages": OrganizePagesCard,
  "extract-pages": ExtractPagesCard,
  "split-pdf": SplitPdfCard,
  "insert-pages": InsertPagesCard,
  "merge-pdf": MergePdfCard,
  "image-to-pdf": ImageToPdfCard,
  "pdf-to-image": PdfToImageCard,
  "compress-pdf": CompressPdfCard,
  "fix-orientation": FixPageOrientationCard,
  "repair-validate": RepairValidatePdfCard,
  metadata: MetadataEditorCard,
  watermark: WatermarkPdfCard,
  "protect-pdf": ProtectPdfCard,
  "unlock-pdf": UnlockPdfCard,
  "summarize-pdf": SummarizePdfCard,
};
