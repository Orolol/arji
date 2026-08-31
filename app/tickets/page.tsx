import { TicketsRegistryView } from "@/components/tickets-registry/TicketsRegistryView";
import { TicketOverlayProvider } from "@/components/ticket/TicketOverlayProvider";

/**
 * `/tickets` — the exhaustive ticket registry (frame 12a).
 *
 * A SERVER PAGE THAT ONLY READS THE SCOPE. `?project=` arrives through
 * `searchParams` (awaited — Next 16 hands it over as a promise) and is passed
 * down as a prop, so the client view needs no `useSearchParams()` and this
 * route needs no Suspense boundary of its own. A client page reading the param
 * itself forces a boundary on a statically-analysable route, which is both an
 * extra hydration hop and a `next build` hazard.
 *
 * When `?project=` is absent the registry spans every project — its normal
 * mode, and the reason the top bar's project chips are a filter rather than a
 * prerequisite.
 *
 * `TicketOverlayProvider` with NO `renderPanel`, so a row click opens the real
 * 6a overlay and inherits its Escape-precedence rules. The registry keeps
 * polling behind the scrim.
 */
export default async function TicketsPage({
  searchParams,
}: {
  searchParams: Promise<{ project?: string }>;
}) {
  const { project } = await searchParams;
  return (
    <TicketOverlayProvider>
      <TicketsRegistryView projectId={project?.trim() || undefined} />
    </TicketOverlayProvider>
  );
}
