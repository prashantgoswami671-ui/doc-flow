/**
 * DocFlow tool catalog — presentation/navigation data only.
 *
 * This is the single source of truth for which tools exist, which category
 * they belong to, and which route (`/tools/{slug}`) enters their existing,
 * unmodified interface. It intentionally contains no component references
 * and imports nothing from `services/**`; the slug -> component mapping
 * lives in `components/tools/toolRegistry.tsx`, which is the only place
 * that imports the actual tool cards.
 *
 * Every entry here must correspond to a real, already-functional tool card
 * registered in toolRegistry.tsx. Do not add an entry without also wiring
 * it up there (and vice versa) — app/tools/[slug]/page.tsx renders 404 for
 * any slug missing from either.
 */

export type ToolCategory =
  | "organize"
  | "create"
  | "convert"
  | "enhance"
  | "protect";

export type ToolEntry = {
  /** Unique URL segment: the tool lives at /tools/{slug}. */
  slug: string;
  /** Short display name, e.g. "Organize Pages". */
  name: string;
  /** One-sentence description shown on the homepage and tool page. */
  description: string;
  category: ToolCategory;
};

export const TOOL_CATEGORY_LABELS: Record<ToolCategory, string> = {
  organize: "Organize",
  create: "Create",
  convert: "Convert",
  enhance: "Enhance",
  protect: "Protect",
};

export const TOOL_CATEGORY_DESCRIPTIONS: Record<ToolCategory, string> = {
  organize:
    "Shape your document. Delete, rotate, reorder, extract, split, and insert pages.",
  create: "Build new documents. Merge PDFs and turn images into PDFs.",
  convert: "Move between formats. Convert PDF pages into images.",
  enhance:
    "Improve document quality. Compress, repair, validate, fix orientation, and add finishing touches.",
  protect: "Control document access. Password-protect and unlock PDFs.",
};

/** Display order for categories across the homepage and navigation. */
export const TOOL_CATEGORY_ORDER: ToolCategory[] = [
  "organize",
  "create",
  "convert",
  "enhance",
  "protect",
];

export const TOOL_CATALOG: ToolEntry[] = [
  {
    slug: "organize-pages",
    name: "Organize Pages",
    description:
      "Delete, rotate, reorder, crop, and select pages in one editor.",
    category: "organize",
  },
  {
    slug: "extract-pages",
    name: "Extract Pages",
    description: "Create a new PDF from the pages you choose.",
    category: "organize",
  },
  {
    slug: "split-pdf",
    name: "Split PDF",
    description:
      "Divide one PDF into multiple PDFs at the page numbers you choose.",
    category: "organize",
  },
  {
    slug: "insert-pages",
    name: "Insert Pages",
    description: "Copy pages from one PDF into another at a chosen position.",
    category: "organize",
  },
  {
    slug: "merge-pdf",
    name: "Merge PDF",
    description: "Combine multiple PDFs into one, in the order you choose.",
    category: "create",
  },
  {
    slug: "image-to-pdf",
    name: "Image to PDF",
    description: "Combine JPG and PNG images into a single PDF.",
    category: "create",
  },
  {
    slug: "pdf-to-image",
    name: "PDF to Image",
    description: "Convert PDF pages into JPG or PNG images, one per page.",
    category: "convert",
  },
  {
    slug: "compress-pdf",
    name: "Compress PDF",
    description: "Reduce PDF file size with light, heavy, or custom targets.",
    category: "enhance",
  },
  {
    slug: "fix-orientation",
    name: "Fix Page Orientation",
    description: "Detect and correct pages that are rotated the wrong way.",
    category: "enhance",
  },
  {
    slug: "repair-validate",
    name: "Repair & Validate PDF",
    description: "Validate and rebuild PDFs that aren't readable or rendering.",
    category: "enhance",
  },
  {
    slug: "metadata",
    name: "Edit Metadata",
    description: "View and update a PDF's title, author, and other details.",
    category: "enhance",
  },
  {
    slug: "watermark",
    name: "Watermark & Page Numbers",
    description: "Add a text watermark, page numbers, or both to a PDF.",
    category: "enhance",
  },
  {
    slug: "protect-pdf",
    name: "Protect PDF",
    description: "Add a password so only people who know it can open it.",
    category: "protect",
  },
  {
    slug: "unlock-pdf",
    name: "Unlock PDF",
    description: "Remove password protection from a PDF using its password.",
    category: "protect",
  },
];

export function getToolBySlug(slug: string): ToolEntry | undefined {
  return TOOL_CATALOG.find((tool) => tool.slug === slug);
}

export function getToolsByCategory(category: ToolCategory): ToolEntry[] {
  return TOOL_CATALOG.filter((tool) => tool.category === category);
}
