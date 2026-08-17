import ToolCategoryCard from "./ToolCategoryCard";
import {
  TOOL_CATEGORY_ORDER,
  TOOL_CATEGORY_LABELS,
  TOOL_CATEGORY_DESCRIPTIONS,
  getToolsByCategory,
} from "../../lib/toolCatalog";

/**
 * DocFlow's five workflow categories, derived from the tool catalog
 * (lib/toolCatalog.ts) so category labels, descriptions, and tool
 * names/slugs are defined in exactly one place. Category ids mirror
 * TopBar's NAV_ITEMS and the section ids rendered in app/page.tsx.
 */
const CATEGORIES = TOOL_CATEGORY_ORDER.map((category) => ({
  name: TOOL_CATEGORY_LABELS[category],
  description: TOOL_CATEGORY_DESCRIPTIONS[category],
  tools: getToolsByCategory(category).map((tool) => ({
    slug: tool.slug,
    name: tool.name,
  })),
  href: `#${category}`,
}));

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
