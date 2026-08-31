"use client";

import { AppearanceBand } from "@/components/settings-piscine";

/**
 * Paramètres → Apparence.
 *
 * One band, no footer: the theme is not a settings key. It lives in
 * localStorage via `next-themes` and is applied as a class on `<html>`; a
 * database row would be a second source of truth that disagreed with the first
 * browser to be opened somewhere else.
 */
export default function AppearanceSettingsPage() {
  return (
    <div className="flex flex-col gap-[10px]">
      <AppearanceBand />
    </div>
  );
}
