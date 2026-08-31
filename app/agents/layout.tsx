import { WorkshopHeader } from "@/components/agents-workshop/WorkshopHeader";

/**
 * The agents workshop shell (frame 7a).
 *
 * Navigation is the global bar (`components/piscine/TopBar.tsx`), mounted once
 * in the root layout. `WorkshopHeader` is no longer a header at all: it is this
 * screen's SECOND ROW — the five tabs and the Frictions pill — sitting inside
 * the content area on the 14px body gutter, so /agents draws exactly one 60px
 * band and it is the bar's.
 *
 * `<main>` in the root layout already provides `flex-1 min-h-0 min-w-0
 * overflow-auto` under the bar, so the shell only has to fill it.
 */
export default function AgentsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col bg-background font-sans text-foreground">
      <WorkshopHeader />
      {children}
    </div>
  );
}
