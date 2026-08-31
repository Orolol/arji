import { LimitsView } from "@/components/agents-workshop/LimitsView";

/**
 * Runtime limits and the review-bounce readout. See app/agents/page.tsx for
 * why the scope is read here, on the server, rather than by a hook in the view.
 */
export default async function LimitsPage({
  searchParams,
}: {
  searchParams: Promise<{ project?: string }>;
}) {
  const { project } = await searchParams;
  return <LimitsView projectId={project?.trim() || undefined} />;
}
