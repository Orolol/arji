import { NewTicketView } from "@/components/tickets-registry/NewTicketView";

/**
 * `/tickets/new` — the app's create-a-ticket surface.
 *
 * The global bar's "New" is a `<Link>`, so its destination has to be a ROUTE:
 * `components/piscine/TopBar.tsx` parks that button on "/" and says in a
 * comment that 12a "will give this a screen of its own". This is that screen —
 * repoint `top-bar-new` here.
 *
 * Server page, `?project=` through `searchParams`, exactly like `/tickets` and
 * `/agents`: no `useSearchParams()`, so no Suspense boundary on a
 * statically-analysable route.
 */
export default async function NewTicketPage({
  searchParams,
}: {
  searchParams: Promise<{ project?: string }>;
}) {
  const { project } = await searchParams;
  return <NewTicketView projectId={project?.trim() || undefined} />;
}
