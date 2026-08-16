type ToolCategoryCardProps = {
  name: string;
  description: string;
  tools: readonly string[];
  href: string;
};

/**
 * Homepage entry point into one DocFlow workflow category. Navigation only
 * — links to the existing in-page category section and must not duplicate
 * a tool's own UI or business logic.
 */
export default function ToolCategoryCard({
  name,
  description,
  tools,
  href,
}: ToolCategoryCardProps) {
  return (
    <a
      href={href}
      className="group flex h-full flex-col rounded-xl border border-gray-200 bg-white p-6 transition-colors hover:border-blue-300 hover:bg-blue-50/30 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
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

      <ul className="mt-4 space-y-1.5">
        {tools.map((tool) => (
          <li
            key={tool}
            className="flex items-center gap-1.5 text-xs text-gray-500"
          >
            <span
              aria-hidden="true"
              className="h-1 w-1 shrink-0 rounded-full bg-gray-300"
            />
            {tool}
          </li>
        ))}
      </ul>

      <span className="mt-5 inline-flex items-center text-sm font-medium text-blue-600 group-hover:text-blue-700">
        Explore {name}
        <span
          aria-hidden="true"
          className="ml-1 transition-transform group-hover:translate-x-0.5"
        >
          →
        </span>
      </span>
    </a>
  );
}
