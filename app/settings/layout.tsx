import { Suspense } from "react";
import { getTranslations } from "next-intl/server";

import { UnderlineTabNav } from "@/components/piscine";
import { SettingsTabSync } from "@/components/settings-piscine";
import type { TranslationKey } from "@/lib/i18n/catalogue";

/**
 * The settings shell — frame 11c's second row and nothing else.
 *
 * NO PAGE HEADER. `components/piscine/TopBar.tsx` is mounted once by
 * `app/layout.tsx` and owns the logo, the project chips, ⌘K, the inbox, Auto
 * and "New" on every route. Per-screen controls live in a second row inside
 * the screen's own content area — here, the tab bar.
 *
 * FIVE TABS, NOT THE FRAME'S FOUR. The frame draws Workspace · Agents ·
 * Integrations · Appearance. `Pipeline` is inserted between Agents and
 * Integrations because the frame draws no home for the autonomous-pipeline
 * settings, the verification commands, the bug-regression gate, the MCP tool
 * switch, the memory/spec automation switches or the global prompt — nine live
 * settings agents read at dispatch time. A fifth tab is the smallest honest
 * container for them; losing one silently is the failure this rebuild exists
 * to avoid.
 *
 * `Agents` leaves the settings tree entirely (frame 7a owns `/agents`), which
 * is why it is not `exact` and why `Workspace` is: without it the index tab
 * would stay lit on `/settings/pipeline`.
 *
 * A MODULE-SCOPE COPY TABLE, so it holds catalogue KEY REFERENCES and the
 * layout resolves them at render (`lib/i18n/catalogue.ts`, pattern 3). This
 * is a server component and stays one: `getTranslations()` is the server
 * half of the same translator the bar reads through `useTranslations()`.
 */
const SETTINGS_TABS: ReadonlyArray<{
  href: string;
  labelKey: TranslationKey;
  exact?: boolean;
}> = [
  { href: "/settings", labelKey: "Settings.tabs.workspace", exact: true },
  { href: "/agents", labelKey: "Settings.tabs.agents" },
  { href: "/settings/pipeline", labelKey: "Settings.tabs.pipeline" },
  { href: "/settings/integrations", labelKey: "Settings.tabs.integrations" },
  { href: "/settings/appearance", labelKey: "Settings.tabs.appearance" },
];

export default async function SettingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const t = await getTranslations();
  const tabs = SETTINGS_TABS.map(({ labelKey, ...tab }) => ({
    ...tab,
    label: t(labelKey),
  }));

  return (
    <div className="flex h-full min-h-0 flex-col bg-background font-sans text-foreground">
      {/* useSearchParams needs a boundary; the sync renders nothing. */}
      <Suspense fallback={null}>
        <SettingsTabSync />
      </Suspense>
      <div className="flex h-[44px] shrink-0 items-center px-[14px]">
        <UnderlineTabNav items={tabs} />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-[14px] pb-[14px]">
        {children}
      </div>
    </div>
  );
}
