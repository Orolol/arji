"use client";

import { useEffect } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

/**
 * Honours the three `?tab=` keys the global top bar links at this screen.
 *
 * `lib/piscine/nav.ts` (frozen, owned by the top-bar packet) ships
 * `/settings`, `/settings?tab=night`, `/settings?tab=notifications` and
 * `/settings?tab=integrations`, and `__tests__/top-bar.test.tsx` pins those
 * strings. This screen splits the old single page into four routes, so the
 * query keys are translated here rather than broken: the two in-page sections
 * scroll to their band, and the one that became its own route redirects.
 *
 * `router.replace`, not `push`: the query was a way in, not a step in history.
 */
const ANCHOR_BY_TAB: Readonly<Record<string, string>> = {
  night: "night-runs",
  notifications: "notifications",
};

export function SettingsTabSync() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useRouter();
  const tab = searchParams?.get("tab") ?? null;

  useEffect(() => {
    if (pathname !== "/settings" || !tab) return;

    if (tab === "integrations") {
      router.replace("/settings/integrations");
      return;
    }

    const anchorId = ANCHOR_BY_TAB[tab];
    if (!anchorId) return;
    document.getElementById(anchorId)?.scrollIntoView({ block: "start" });
  }, [pathname, tab, router]);

  return null;
}
