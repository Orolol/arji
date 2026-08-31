import { PromptsView } from "@/components/agents-workshop/PromptsView";

/**
 * Role prompts and review agents. See app/agents/page.tsx for why the scope is
 * read here, on the server, rather than by a hook in the view.
 */
export default async function PromptsPage({
  searchParams,
}: {
  searchParams: Promise<{ project?: string }>;
}) {
  const { project } = await searchParams;
  return <PromptsView projectId={project?.trim() || undefined} />;
}
