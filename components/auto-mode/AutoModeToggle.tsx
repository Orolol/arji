"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Infinity as InfinityIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AutoModeStatus } from "@/lib/auto-mode/status";

interface AutoModeToggleProps {
  projectId: string;
  /** Opens the configuration dialog. */
  onOpen: () => void;
  /** Bumped by the page whenever the board changes, to re-read the status. */
  refreshTrigger?: number;
  /** Poll cadence; 0 disables polling (tests drive refreshTrigger instead). */
  pollIntervalMs?: number;
}

/**
 * Board-toolbar entry point for Full Auto Mode: a button that opens the
 * dialog and, while the mode is running, carries a live badge of what it is
 * doing right now ("2 building · 1 reviewing"). Off, it is just a quiet
 * label — the mode should be invisible until it is armed.
 */
export function AutoModeToggle({
  projectId,
  onOpen,
  refreshTrigger = 0,
  pollIntervalMs = 5000,
}: AutoModeToggleProps) {
  const t = useTranslations("AutoMode");
  const [status, setStatus] = useState<AutoModeStatus | null>(null);

  // One effect owns both the initial read and the poll, and every setState
  // happens in a fetch callback rather than in the effect body (the board is
  // the external system being subscribed to here).
  useEffect(() => {
    let cancelled = false;

    const load = (): void => {
      fetch(`/api/projects/${projectId}/auto-mode`)
        .then((r) => r.json())
        .then((d) => {
          if (cancelled || !d?.data) return;
          setStatus(d.data as AutoModeStatus);
        })
        .catch(() => {
          // A failed status read must never break the board toolbar.
        });
    };

    load();
    if (!pollIntervalMs) return () => {
      cancelled = true;
    };

    const timer = setInterval(load, pollIntervalMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [projectId, refreshTrigger, pollIntervalMs]);

  const active = status?.enabled === true;
  const badge = active
    ? t("toggle.badge", {
        build: status.inFlight.build,
        review: status.inFlight.review,
      })
    : null;

  return (
    <button
      type="button"
      onClick={onOpen}
      data-testid="auto-mode-toggle"
      aria-pressed={active}
      title={t("toggle.title")}
      className={cn(
        "flex shrink-0 items-center gap-[6px] rounded-[7px] border px-[10px] py-[4px] text-[12px] font-medium transition-colors",
        active
          ? "border-agent-border bg-agent-bg text-agent"
          : "border-border bg-background text-foreground shadow-sm hover:border-agent-border hover:bg-agent-bg/40 hover:text-agent"
      )}
    >
      <InfinityIcon className="h-[13px] w-[13px]" aria-hidden />
      {t("toggle.label")}
      <span
        aria-hidden
        className={cn(
          "h-[7px] w-[7px] rounded-full",
          active ? "bg-agent" : "bg-muted-foreground/40"
        )}
      />
      {badge && (
        <span
          data-testid="auto-mode-toggle-badge"
          className="rounded-full bg-agent/10 px-[6px] py-[1px] text-[11px] tabular-nums"
        >
          {badge}
        </span>
      )}
    </button>
  );
}
