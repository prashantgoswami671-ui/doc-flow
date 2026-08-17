import type { ReactNode } from "react";
import Link from "next/link";

import {
  TOOL_CATEGORY_LABELS,
  getToolsByCategory,
  type ToolEntry,
} from "../../lib/toolCatalog";

type ToolPageShellProps = {
  tool: ToolEntry;
  children: ReactNode;
};

/**
 * Shared workspace shell for every dedicated tool page (/tools/{slug}).
 * Renders the DocFlow context around an existing, unmodified tool
 * component: back navigation to the tool's category, the category label,
 * the tool's name/description (sourced from lib/toolCatalog.ts, never
 * duplicated here), and an optional list of related tools in the same
 * category. Holds no PDF/document state and does not constrain the width
 * of the tool component itself — each tool card already manages its own
 * internal width.
 */
export default function ToolPageShell({ tool, children }: ToolPageShellProps) {
  const categoryLabel = TOOL_CATEGORY_LABELS[tool.category];
  const relatedTools = getToolsByCategory(tool.category).filter(
    (candidate) => candidate.slug !== tool.slug,
  );

  return (
    <section className="pb-20 pt-10 sm:pt-12">
      <div className="mx-auto max-w-2xl px-4 sm:px-6">
        <Link
          href={`/#${tool.category}`}
          className="text-sm font-medium text-blue-600 hover:text-blue-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 rounded-sm"
        >
          ← Back to {categoryLabel}
        </Link>

        <p className="mt-6 text-xs font-semibold uppercase tracking-widest text-blue-600">
          {categoryLabel}
        </p>
        <h1 className="mt-2 text-2xl font-bold tracking-tight text-gray-900 sm:text-3xl">
          {tool.name}
        </h1>
        <p className="mt-2 text-sm text-gray-600 sm:text-base">
          {tool.description}
        </p>
      </div>

      <div className="mt-10">{children}</div>

      {relatedTools.length > 0 && (
        <div className="mx-auto mt-16 max-w-2xl border-t border-gray-200 px-4 pt-10 sm:px-6">
          <h2 className="text-sm font-semibold text-gray-900">
            Related {categoryLabel} tools
          </h2>
          <ul className="mt-3 flex flex-wrap gap-x-6 gap-y-2">
            {relatedTools.map((related) => (
              <li key={related.slug}>
                <Link
                  href={`/tools/${related.slug}`}
                  className="text-sm font-medium text-blue-600 hover:text-blue-700 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 rounded-sm"
                >
                  {related.name}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
