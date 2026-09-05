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
 *
 * BELOW `lg` THE ROW FOLDS — B-arij-iL4-FmyXgGr. The desk grammar above is one
 * flex line, and its stamp, chip, meta and pills are each `shrink-0` with only
 * the description able to give way. On a phone that arithmetic has one outcome:
 * measured in Chrome at 320/390/414px, the description collapsed to 0px and the
 * three pills were laid out from x=480 to x=748 — off the screen, inside a band
 * whose `overflow-y-auto` quietly makes `overflow-x` `auto` too. Fix with agent,
 * Diff and Dismiss are the only ways to act on a blocking finding, so that is
 * the whole screen being unusable, not a cosmetic clip.
 *
 * The fold is three lines, in the frame's own reading order:
 *
 *     [BLOCKING] [ARJ-113]            Sentinelle Sécurité · 6m
 *     Le token MCP est écrit en clair … · lib/…/injection.ts:2140
 *                          [Fix with agent] [Diff] [Dismiss]
 *
 * DOM order never changes — the meta is pulled up beside the chip with
 * `order-*`, so a screen reader and the desktop row still read stamp · chip ·
 * description · meta · actions. Every phone rule is undone at `lg:`, where the
 * row is the single line the frames draw, to the pixel: the action group's own
 * `lg:gap-3` is the gap the row used to give the loose pills.
 *
 * NOT `overflow-hidden`. Clipping would hide the pills rather than move them,
 * and a hidden Dismiss is the same unusable screen with a tidier edge.
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
        "flex flex-wrap items-center gap-x-3 gap-y-[6px] px-[14px] py-[10px]",
        "lg:flex-nowrap",
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

      {/* `basis-full` is what gives the description its own line on a phone:
          on the desk row it was the only flexible item, so it absorbed the
          whole shortfall and measured 0px. `grow` + `lg:basis-0` is `flex-1`
          spelled in two parts, so the desktop cell is the one it always was. */}
      <span
        data-testid="qa-finding-text"
        className={cn(
          "order-1 line-clamp-2 min-w-0 grow basis-full font-sans text-[13.5px]",
          "lg:order-none lg:line-clamp-1 lg:basis-0",
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

      {/* `Mono` takes no arbitrary DOM props, so the test id sits on the
          wrapper — the same shape `QaScreen` uses for the coverage stat.
          The wrapper is the flex item: on a phone it rides up beside the chip
          (`ml-auto`), and a named agent longer than the line is ellipsised
          rather than allowed to widen the card. */}
      <span
        data-testid="qa-finding-meta"
        className="order-none ml-auto min-w-0 truncate lg:ml-0 lg:shrink-0"
      >
        <Mono size={10} tone={minor ? "you-mid" : "muted"}>
          {`${finding.reviewer ?? "—"} · ${findingAge(finding.filedAt)}`}
        </Mono>
      </span>

      {/* ONE GROUP, not three loose pills: pills that wrapped one at a time
          would strand Dismiss on a line of its own. `flex-wrap` inside it is
          for 320px, where the three of them are wider than the card. */}
      <div
        data-testid="qa-finding-actions"
        className={cn(
          "order-2 flex basis-full flex-wrap items-center justify-end gap-2",
          "lg:order-none lg:basis-auto lg:shrink-0 lg:gap-3",
        )}
      >
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
      </div>
    </SurfaceCard>
  );
}
