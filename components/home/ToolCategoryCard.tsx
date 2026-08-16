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
      className="group flex flex-col rounded-xl border border-gray-200 bg-white p-5 transition-colors hover:border-blue-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
    >
      <h3 className="text-base font-semibold text-gray-900">{name}</h3>
      <p className="mt-1.5 text-sm text-gray-600">{description}</p>

      <ul className="mt-4 space-y-1">
        {tools.map((tool) => (
          <li key={tool} className="text-xs text-gray-500">
            {tool}
          </li>
        ))}
      </ul>

      <span className="mt-4 inline-flex items-center text-sm font-medium text-blue-600 group-hover:text-blue-700">
        Explore {name}
        <span aria-hidden="true" className="ml-1">
          →
        </span>
      </span>
    </a>
  );
}
