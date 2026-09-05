import { TicketsRegistryView } from "@/components/tickets-registry/TicketsRegistryView";
import { TicketOverlayProvider } from "@/components/ticket/TicketOverlayProvider";

/**
 * `/tickets` — the exhaustive ticket registry (frame 12a).
 *
 * A SHELL. Every filter this screen has — `?project=`, `?status=`, `?state=`,
 * `?sort=`, `?direction=` — is read from and written back to the query string
 * by the client view (`lib/tickets-registry/url-state.ts`), because a
 * selection kept in component state made the address bar disagree with the
 * table: picking another project left `?project=` naming the old one, and a
 * reload restored it. The URL is the single source of truth, so the scope a
 * navigation supplies keeps its priority with nothing to arbitrate.
 *
 * That makes the page itself read nothing. It stays DYNAMIC on purpose: the
 * client view reads the parameters with `useSearchParams()`, and on a
 * statically prerendered route that hook needs a Suspense boundary and
 * de-opts the tree to client-side rendering. Rendering the route dynamically —
 * which it already was, having awaited `searchParams` — populates the hook
 * server-side instead, so the first paint is already scoped and this route
 * still needs no boundary of its own.
 *
 * When `?project=` is absent the registry spans every project — its normal
 * mode, and the reason the top bar's project chips are a filter rather than a
 * prerequisite.
 *
 * `TicketOverlayProvider` with NO `renderPanel`, so a row click opens the real
 * 6a overlay and inherits its Escape-precedence rules. The registry keeps
 * polling behind the scrim.
 */
export const dynamic = "force-dynamic";

export default function TicketsPage() {
  return (
    <TicketOverlayProvider>
      <TicketsRegistryView />
    </TicketOverlayProvider>
  );
}
