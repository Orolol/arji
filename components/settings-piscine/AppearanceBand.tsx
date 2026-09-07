"use client";

import { useSyncExternalStore } from "react";
import { useTheme } from "next-themes";
import { useTranslations } from "next-intl";

import { BandHeader, Mono, SegmentedControl, StrataBand } from "@/components/piscine";

import { SettingsSection } from "./SettingsSection";

/**
 * THÈME — jour / nuit.
 *
 * NOT A SETTINGS KEY. The theme is `next-themes` in localStorage
 * (`attribute="class"`, `enableSystem={false}`); adding a database key would
 * create a second source of truth for a value the class attribute already
 * carries — and the two would disagree the first time someone opened a second
 * browser.
 *
 * The control is held until `mounted`, because `theme` is `undefined` on the
 * server render and the segment would flip on hydration.
 */
type ThemeSegment = "light" | "dark";
const subscribe = () => () => {};
const clientSnapshot = () => true;
const serverSnapshot = () => false;

export function AppearanceBand() {
  const t = useTranslations("Settings");
  const { theme, setTheme } = useTheme();
  const mounted = useSyncExternalStore(subscribe, clientSnapshot, serverSnapshot);

  return (
    <SettingsSection
      testId="appearance-settings"
      heading={t("appearance.heading")}
    >
      <StrataBand stratum="card">
        <BandHeader stratum="card" label={t("appearance.label")} standalone />
        {mounted ? (
          <SegmentedControl<ThemeSegment>
            chrome="bordered"
            size="md"
            className="w-[240px]"
            options={[
              { value: "light", label: t("appearance.day") },
              { value: "dark", label: t("appearance.night") },
            ]}
            value={theme === "light" ? "light" : "dark"}
            onChange={(next) => setTheme(next)}
          />
        ) : null}
        <Mono size={10.5} tone="muted" as="div">
          {t("appearance.note")}
        </Mono>
      </StrataBand>
    </SettingsSection>
  );
}
