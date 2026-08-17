import Link from "next/link";

type CategoryTool = {
  slug: string;
  name: string;
};

type ToolCategoryCardProps = {
  name: string;
  description: string;
  tools: readonly CategoryTool[];
  href: string;
};

/**
 * Homepage entry point into one DocFlow workflow category. The heading,
 * description, and footer link scroll to the existing in-page category
 * section; each individual tool links straight to its dedicated
 * /tools/{slug} route so a tool can be reached in one click. Navigation
 * only — must not duplicate a tool's own UI or business logic.
 */
export default function ToolCategoryCard({
  name,
  description,
  tools,
  href,
}: ToolCategoryCardProps) {
  return (
    <div className="group flex h-full flex-col rounded-xl border border-gray-200 bg-white p-6 transition-colors hover:border-blue-300 hover:bg-blue-50/30">
      <a
        href={href}
        className="rounded-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
      >
        <span
          aria-hidden="true"
          className="mb-3 block h-1 w-8 rounded-full bg-blue-600"
        />

        <h3 className="text-lg font-semibold tracking-tight text-gray-900">
          {name}
        </h3>
        <p className="mt-2 text-sm leading-relaxed text-gray-600">
          {description}
        </p>
      </a>

      <ul className="mt-4 space-y-1">
        {tools.map((tool) => (
          <li key={tool.slug}>
            <Link
              href={`/tools/${tool.slug}`}
              className="-mx-1 flex items-center gap-1.5 rounded-sm px-1 py-1 text-xs text-gray-500 transition-colors hover:text-blue-700 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
            >
              <span
                aria-hidden="true"
                className="h-1 w-1 shrink-0 rounded-full bg-gray-300"
              />
              {tool.name}
            </Link>
          </li>
        ))}
      </ul>

      <a
        href={href}
        className="mt-5 inline-flex items-center rounded-sm text-sm font-medium text-blue-600 hover:text-blue-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
      >
        Explore {name}
        <span
          aria-hidden="true"
          className="ml-1 transition-transform group-hover:translate-x-0.5"
        >
          →
        </span>
      </a>
    </div>
  );
}
