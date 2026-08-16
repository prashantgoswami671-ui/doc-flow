import ToolCategoryCard from "./ToolCategoryCard";

/**
 * DocFlow's five workflow categories. Mirrors TopBar's NAV_ITEMS and the
 * section ids rendered in app/page.tsx — every tool listed here must exist
 * in the repository (see the corresponding *Card component).
 */
const CATEGORIES = [
  {
    name: "Organize",
    description:
      "Shape your document. Delete, rotate, reorder, extract, split, and insert pages.",
    tools: ["Organize Pages", "Extract Pages", "Split PDF", "Insert Pages"],
    href: "#organize",
  },
  {
    name: "Create",
    description: "Build new documents. Merge PDFs and turn images into PDFs.",
    tools: ["Merge PDF", "Image to PDF"],
    href: "#create",
  },
  {
    name: "Convert",
    description: "Move between formats. Convert PDF pages into images.",
    tools: ["PDF to Image"],
    href: "#convert",
  },
  {
    name: "Enhance",
    description:
      "Improve document quality. Compress, repair, validate, fix orientation, and add finishing touches.",
    tools: [
      "Compress PDF",
      "Fix Page Orientation",
      "Repair & Validate PDF",
      "Edit Metadata",
      "Watermark & Page Numbers",
    ],
    href: "#enhance",
  },
  {
    name: "Protect",
    description: "Control document access. Password-protect and unlock PDFs.",
    tools: ["Protect PDF", "Unlock PDF"],
    href: "#protect",
  },
] as const;

/**
 * DocFlow's workflow information architecture. Presentation/navigation
 * only — must not own PDF/document state or import PDF services.
 */
export default function ToolCategoryGrid() {
  return (
    <section
      aria-labelledby="workflow-categories-heading"
      className="border-b border-gray-200 bg-gray-50/60 py-16 sm:py-20"
    >
      <div className="mx-auto max-w-5xl px-4 sm:px-6">
        <h2
          id="workflow-categories-heading"
          className="text-2xl font-bold tracking-tight text-gray-900"
        >
          Explore by workflow
        </h2>
        <p className="mt-2 max-w-2xl text-sm text-gray-600">
          Jump straight to the kind of work you need to do.
        </p>

        <div className="mt-10 grid grid-cols-1 items-stretch gap-5 sm:grid-cols-2 lg:grid-cols-5">
          {CATEGORIES.map((category) => (
            <ToolCategoryCard key={category.name} {...category} />
          ))}
        </div>
      </div>
    </section>
  );
}
