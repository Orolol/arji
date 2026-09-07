"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";

import {
  GhostInputPill,
  Mono,
  ProgressTrack,
  QuietLink,
  StrataBand,
} from "@/components/piscine";
import { formatCostUsd } from "@/lib/utils/format-usage";
import type { UsageMonthlyCap } from "@/lib/types/usage";

/**
 * PLAFOND MENSUEL — the linden budget tile of frame 8d.
 *
 * DISPLAY-ONLY. Nothing in `lib/auto-mode/*` reads a spend cap, so the tile
 * states a threshold and never enforces one.
 *
 * The cap lives in the generic `settings` key/value table under
 * `usage_budget_usd_month` (no migration, no new table) and is edited inline
 * here rather than on the settings page. An empty input CLEARS it — which is
 * why "no cap" and "a cap of zero" stay distinguishable all the way down to
 * the aggregate's defensive parse.
 *
 * When no cap is configured the tile collapses toward its label line: the
 * month-to-date spend alone plus a link, and NO bar. A bar with no denominator
 * is an invented number.
 */
export interface MonthlyCapTileProps {
  cap: UsageMonthlyCap;
  /** Re-read the report after a successful save. Never with `fresh`. */
  onSaved: () => void;
}

export function MonthlyCapTile({ cap, onSaved }: MonthlyCapTileProps) {
  const t = useTranslations("Usage");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const hasCap = cap.capUsd !== null;
  const spent = formatCostUsd(cap.spentUsd) ?? "—";
  const over = cap.usedPercent !== null && cap.usedPercent >= 100;

  function startEditing() {
    setDraft(cap.capUsd === null ? "" : String(cap.capUsd));
    setMessage(null);
    setEditing(true);
  }

  /**
   * Mirrors `handleSaveUsageBudget` in app/settings/page.tsx: an empty string
   * clears the cap (writes null), anything non-finite or non-positive is
   * refused inline, and a failed PATCH leaves the previous cap on screen
   * rather than blanking the tile.
   */
  async function commit() {
    const raw = draft.trim();
    let next: number | null = null;
    if (raw !== "") {
      const parsed = Number(raw);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        setMessage(t("cap.invalid"));
        return;
      }
      next = parsed;
    }

    setSaving(true);
    try {
      const response = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ usage_budget_usd_month: next }),
      });
      if (!response.ok) {
        setMessage(t("cap.saveFailed"));
        return;
      }
      setEditing(false);
      setMessage(null);
      // A plain refresh: the cap lives in Arij's own database, so forcing the
      // route's live-quota re-poll would spawn two CLIs for nothing.
      onSaved();
    } catch {
      setMessage(t("cap.saveFailed"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <StrataBand
      stratum="feed"
      gap={8}
      className="flex-[2_1_320px] shrink px-[18px] py-[15px]"
    >
      <div className="flex items-baseline gap-[10px]">
        <Mono size={10} weight={700} tracking={0.08} uppercase tone="feed-deep">
          {t("cap.label")}
        </Mono>

        {editing ? (
          <GhostInputPill
            className="ml-auto"
            value={draft}
            onChange={setDraft}
            // BOTH keys are handled here, not through `onSubmit`:
            // GhostInputPill spreads `{...props}` AFTER its own onKeyDown, so
            // a caller that needs Escape necessarily owns Enter as well.
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                setEditing(false);
                setMessage(null);
                return;
              }
              if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void commit();
              }
            }}
            placeholder="250"
            fill="card"
            width={96}
            disabled={saving}
            autoFocusKey={editing}
            data-testid="usage-cap-input"
          />
        ) : (
          <button
            type="button"
            onClick={startEditing}
            data-testid="usage-cap-readout"
            className="ml-auto border-0 bg-transparent p-0 outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            {/*
              Over the cap is one of the design's two sanctioned alarms.
              `--destructive` is the same value as `--strata-you-deep`, so
              "text is never coloured except stratum deeps" still holds.
            */}
            <Mono size={12} weight={700} tone={over ? "danger" : "feed-deep"}>
              {hasCap ? `${spent} / ${formatCostUsd(cap.capUsd)}` : spent}
            </Mono>
          </button>
        )}
      </div>

      {hasCap && (
        <ProgressTrack
          height={8}
          // The BAR clamps to [0,100]; the readout above never does, so a
          // blown cap still reads the true ratio.
          percent={Math.min(100, Math.max(0, cap.usedPercent ?? 0))}
          fillColor="var(--strata-feed-deep)"
          trackColor="var(--card)"
          fillTestId="usage-cap-fill"
        />
      )}

      {hasCap ? (
        /*
         * Frame 8d also promises "— Full Auto se met en pause au plafond".
         * No such pause exists (lib/auto-mode has no budget concept), so the
         * clause is withheld rather than shipped as a false promise. Restore
         * it verbatim the day auto-mode reads the cap.
         */
        <span className="font-sans text-[11px] text-strata-feed-deep">
          {t("cap.alert", { percent: cap.alertPercent })}
        </span>
      ) : (
        <QuietLink
          tone="muted"
          size={11.5}
          onClick={startEditing}
          className="self-start"
          testId="usage-cap-set"
        >
          {t("cap.set")}
        </QuietLink>
      )}

      {message && (
        <span
          className="font-sans text-[11px] text-destructive"
          data-testid="usage-cap-message"
        >
          {message}
        </span>
      )}
    </StrataBand>
  );
}
