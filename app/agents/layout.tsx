import { WorkshopHeader } from "@/components/agents-workshop/WorkshopHeader";

/**
 * The agents workshop shell (frame 7a).
 *
 * The global project rail hides itself on /agents (see SELF_NAVIGATING in
 * components/layout/Sidebar.tsx), so this header IS the page's navigation.
 * The header gutter is 24px and every body gutter 14px — that asymmetry comes
 * from the frames and is deliberate.
 *
 * `<main>` in the root layout already provides `flex-1 min-w-0 overflow-auto`
 * inside an `h-screen` row, so the shell only has to fill it.
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
