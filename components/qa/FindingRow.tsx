"use client";

import { Hammer } from "lucide-react";

import {
  IdentityChip,
  Mono,
  PillButton,
  SurfaceCard,
  projectTone,
} from "@/components/piscine";
import { formatRelativeAge } from "@/components/usage/formatters";
import type { DeskProject } from "@/lib/control-desk/types";
import type { QaFinding } from "@/lib/qa/types";
import { cn } from "@/lib/utils";

import { FindingSeverityStamp } from "./FindingSeverityStamp";

/**
 * One open finding awaiting a human verdict — the coral stratum's row.
 *
 * Same skeleton and same discipline as `components/desk/AttentionRow.tsx`:
 * stamp · ticket chip · flexible content · fixed meta · EXACTLY ONE filled
 * button, outline buttons after it. The filled one is `--action` deep
 * water-green, never coral: colour names the stratum, the WORD names the state.
 *
 * MINOR rows are translucent, their body text is the ground's mid tone at
 * normal weight, they drop the file:line suffix and they offer Dismiss only —
 * the frame's fourth row, exactly.
 *
 * A finding on a shipped ticket (`fixable: false`) shows Diff + Dismiss: the
 * build route refuses `done`/`released`, and a button whose route will refuse
 * it is never rendered.
 */
export interface FindingRowProps {
  finding: QaFinding;
  project: DeskProject | undefined;
  onFix?: (finding: QaFinding) => void;
  onDiff?: (finding: QaFinding) => void;
  onDismiss?: (finding: QaFinding) => void;
  pending?: boolean;
  className?: string;
}

/**
 * "6m" / "1h" / "2h" — `components/usage/formatters.ts`, already shipped and
 * client-safe. An unparseable stamp is an em-dash, never "just now".
 *
 * SQLite's CURRENT_TIMESTAMP writes "2026-08-30 06:00:00" while the routes
 * write ISO; the space form is normalised to UTC first, the same way
 * `AttentionRow.relativeAge` does it.
 */
export function findingAge(filedAt: string | null, now: number = Date.now()): string {
  if (!filedAt) return "—";
  const normalized = filedAt.includes("T")
    ? filedAt
    : `${filedAt.replace(" ", "T")}Z`;
  const then = Date.parse(normalized);
  if (Number.isNaN(then)) return "—";
  return formatRelativeAge(Math.max(0, now - then));
}

export function FindingRow({
  finding,
  project,
  onFix,
  onDiff,
  onDismiss,
  pending = false,
  className,
}: FindingRowProps) {
  const minor = finding.tier === "minor";
  const tone = projectTone(project?.colorIndex ?? 0);

  return (
    <SurfaceCard
      radius={12}
      translucent={minor}
      data-testid="qa-finding-row"
      data-tier={finding.tier}
      className={cn(
        "flex items-center gap-3 px-[14px] py-[10px]",
        "animate-in fade-in slide-in-from-bottom-2 motion-reduce:animate-none",
        className,
      )}
    >
      <FindingSeverityStamp tier={finding.tier} label={finding.severityLabel} />
      <IdentityChip
        label={finding.readableId ?? project?.shortName ?? "—"}
        tone={tone}
        size="sm"
      />

      <span
        className={cn(
          "line-clamp-1 min-w-0 flex-1 font-sans text-[13.5px]",
          minor
            ? "font-normal text-strata-you-mid"
            : "font-medium text-foreground",
        )}
      >
        {finding.text}
        {!minor && finding.filePath ? (
          <Mono size={11.5} tone="muted">
            {` · ${finding.filePath}:${finding.lineNumber}`}
          </Mono>
        ) : null}
      </span>

      <Mono size={10} tone={minor ? "you-mid" : "muted"} className="shrink-0">
        {`${finding.reviewer ?? "—"} · ${findingAge(finding.filedAt)}`}
      </Mono>

      {!minor && finding.fixable ? (
        <PillButton
          variant="filled"
          size="sm"
          icon={Hammer}
          onClick={() => onFix?.(finding)}
          pending={pending}
          pendingLabel="Dispatch…"
          data-testid="qa-finding-fix"
        >
          Fix with agent
        </PillButton>
      ) : null}

      {!minor ? (
        <PillButton
          variant="outline"
          outlineTone="action"
          size="sm"
          onClick={() => onDiff?.(finding)}
          data-testid="qa-finding-diff"
        >
          Diff
        </PillButton>
      ) : null}

      {/* The frame draws the Dismiss LABEL in --muted-foreground while its
          border stays --action-outline. The className is the only way to get
          that pairing, and twMerge keeps it. */}
      <PillButton
        variant="outline"
        outlineTone="action"
        size="sm"
        onClick={() => onDismiss?.(finding)}
        disabled={pending}
        className="text-muted-foreground"
        data-testid="qa-finding-dismiss"
      >
        Dismiss
      </PillButton>
    </SurfaceCard>
  );
}
