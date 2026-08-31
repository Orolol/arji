import { AgentsWorkshopView } from "@/components/agents-workshop/AgentsWorkshopView";

/**
 * The agents workshop (frame 7a) — a full page where a 480px side sheet used
 * to be.
 *
 * A SERVER PAGE THAT ONLY READS THE SCOPE. `?project=` arrives through
 * `searchParams` (awaited — Next 16 hands it over as a promise) and is passed
 * down as a prop, so the client view needs no `useSearchParams()` and this
 * route needs no Suspense boundary of its own. The alternative — a client page
 * reading the param itself — forces a boundary on a statically-analysable
 * route, which is both an extra hydration hop and a `next build` hazard.
 */
export default async function AgentsPage({
  searchParams,
}: {
  searchParams: Promise<{ project?: string }>;
}) {
  const { project } = await searchParams;
  return <AgentsWorkshopView projectId={project?.trim() || undefined} />;
}
