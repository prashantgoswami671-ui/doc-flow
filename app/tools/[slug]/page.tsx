import type { Metadata } from "next";
import { notFound } from "next/navigation";

import AppShell from "../../../components/AppShell";
import ToolPageShell from "../../../components/tools/ToolPageShell";
import { TOOL_COMPONENTS } from "../../../components/tools/toolRegistry";
import { getToolBySlug, TOOL_CATALOG } from "../../../lib/toolCatalog";

/**
 * Dedicated tool route: /tools/{slug}. Pure routing/composition — looks the
 * slug up in the catalog (metadata) and registry (component), then renders
 * the existing, unmodified tool card. Holds no PDF/document state itself.
 */

/**
 * Local params type. The generated `PageProps<Route>` helper (from
 * .next/types/routes.d.ts) only has an entry for "/" until Next.js
 * regenerates it for this route, which currently causes
 * `PageProps<"/tools/[slug]">` to fail to typecheck. Using an explicit
 * local type sidesteps that generated-types timing issue.
 */
type ToolPageProps = {
  params: Promise<{ slug: string }>;
};

export function generateStaticParams() {
  return TOOL_CATALOG.map((tool) => ({ slug: tool.slug }));
}

export async function generateMetadata(
  props: ToolPageProps,
): Promise<Metadata> {
  const { slug } = await props.params;
  const tool = getToolBySlug(slug);

  if (!tool) {
    return {};
  }

  return {
    title: `${tool.name} — DocFlow`,
    description: tool.description,
  };
}

export default async function ToolPage(props: ToolPageProps) {
  const { slug } = await props.params;
  const tool = getToolBySlug(slug);
  const ToolComponent = TOOL_COMPONENTS[slug];

  if (!tool || !ToolComponent) {
    notFound();
  }

  return (
    <AppShell>
      <ToolPageShell tool={tool}>
        <ToolComponent />
      </ToolPageShell>
    </AppShell>
  );
}
