"use client";

import { useEffect, useState } from "react";
import { useTheme } from "next-themes";

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

export function AppearanceBand() {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  return (
    <SettingsSection testId="appearance-settings" heading="Thème">
      <StrataBand stratum="card">
        <BandHeader stratum="card" label="Thème" standalone />
        {mounted ? (
          <SegmentedControl<ThemeSegment>
            chrome="bordered"
            size="md"
            className="w-[240px]"
            options={[
              { value: "light", label: "Jour" },
              { value: "dark", label: "Nuit" },
            ]}
            value={theme === "light" ? "light" : "dark"}
            onChange={(next) => setTheme(next)}
          />
        ) : null}
        <Mono size={10.5} tone="muted" as="div">
          les grounds pastel deviennent une seule encre chaude la nuit — la
          strate se lit à son libellé
        </Mono>
      </StrataBand>
    </SettingsSection>
  );
}
