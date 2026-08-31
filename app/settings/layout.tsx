import { Suspense } from "react";

import { UnderlineTabNav, type UnderlineTabNavItem } from "@/components/piscine";
import { SettingsTabSync } from "@/components/settings-piscine";

/**
 * The settings shell — frame 11c's second row and nothing else.
 *
 * NO PAGE HEADER. `components/piscine/TopBar.tsx` is mounted once by
 * `app/layout.tsx` and owns the logo, the project chips, ⌘K, the inbox, Auto
 * and "New" on every route. Per-screen controls live in a second row inside
 * the screen's own content area — here, the tab bar.
 *
 * FIVE TABS, NOT THE FRAME'S FOUR. The frame draws Workspace · Agents ·
 * Intégrations · Apparence. `Pipeline` is inserted between Agents and
 * Intégrations because the frame draws no home for the autonomous-pipeline
 * settings, the verification commands, the bug-regression gate, the MCP tool
 * switch, the memory/spec automation switches or the global prompt — nine live
 * settings agents read at dispatch time. A fifth tab is the smallest honest
 * container for them; losing one silently is the failure this rebuild exists
 * to avoid.
 *
 * `Agents` leaves the settings tree entirely (frame 7a owns `/agents`), which
 * is why it is not `exact` and why `Workspace` is: without it the index tab
 * would stay lit on `/settings/pipeline`.
 */
const SETTINGS_TABS: UnderlineTabNavItem[] = [
  { href: "/settings", label: "Workspace", exact: true },
  { href: "/agents", label: "Agents" },
  { href: "/settings/pipeline", label: "Pipeline" },
  { href: "/settings/integrations", label: "Intégrations" },
  { href: "/settings/appearance", label: "Apparence" },
];

export default function SettingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col bg-background font-sans text-foreground">
      {/* useSearchParams needs a boundary; the sync renders nothing. */}
      <Suspense fallback={null}>
        <SettingsTabSync />
      </Suspense>
      <div className="flex h-[44px] shrink-0 items-center px-[14px]">
        <UnderlineTabNav items={SETTINGS_TABS} />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-[14px] pb-[14px]">
        {children}
      </div>
    </div>
  );
}
