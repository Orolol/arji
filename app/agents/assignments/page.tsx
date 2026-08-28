import { AssignmentsView } from "@/components/agents-workshop/AssignmentsView";

/**
 * The full 21-role assignment table. See app/agents/page.tsx for why the scope
 * is read here, on the server, rather than by a hook in the view.
 */
export default async function AssignmentsPage({
  searchParams,
}: {
  searchParams: Promise<{ project?: string }>;
}) {
  const { project } = await searchParams;
  return <AssignmentsView projectId={project?.trim() || undefined} />;
}
