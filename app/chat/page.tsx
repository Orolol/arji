import { ChatPageView } from "@/components/chat-page/ChatPageView";
import { TicketOverlayProvider } from "@/components/ticket/TicketOverlayProvider";

/**
 * Chat (frame 11a) — a full page where a resizable side panel used to be.
 *
 * A SERVER PAGE THAT ONLY READS THE SCOPE, exactly as `app/agents/page.tsx`
 * does. `?project=` and `?conversation=` arrive through `searchParams` (awaited
 * — Next 16 hands it over as a promise) and travel down as props, so the client
 * view needs no `useSearchParams()` and this route needs no Suspense boundary
 * of its own. A client page reading the param itself would force a boundary on
 * a statically-analysable route: an extra hydration hop and a `next build`
 * hazard.
 *
 * `TicketOverlayProvider` is here because the thread's epic cards and the
 * "Créé dans ce chat" rail both open tickets. Outside a provider
 * `useTicketOverlay()` is a silent no-op, which is what lets a single card
 * mount in a unit test with no app shell.
 */
export default async function ChatPage({
  searchParams,
}: {
  searchParams: Promise<{ project?: string; conversation?: string }>;
}) {
  const { project, conversation } = await searchParams;

  return (
    <TicketOverlayProvider>
      <ChatPageView
        initialProjectId={project?.trim() || undefined}
        initialConversationId={conversation?.trim() || undefined}
      />
    </TicketOverlayProvider>
  );
}
