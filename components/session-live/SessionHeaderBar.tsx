"use client";

import Link from "next/link";
import { ArrowLeft, StopCircle } from "lucide-react";

import {
  Chrono,
  IdentityChip,
  Mono,
  PillButton,
  Stamp,
  pillButtonVariants,
} from "@/components/piscine";
import { formatCostUsd } from "@/lib/utils/format-usage";
import { formatElapsed } from "@/lib/utils/format-elapsed";
import { cn } from "@/lib/utils";

import { AGENT_TYPE_LABELS, projectShortLabel, statusStamp } from "./labels";
import type { SessionDetail, SessionFilesProject, SessionFilesTicket } from "./types";

/**
 * The live session's SECOND ROW — identity on the left, liveness on the right.
 *
 * Frame 8a drew this as a 60px page header. Frame 13a made the top bar global,
 * so this is no longer a header at all: it is the screen's own row, inside the
 * content area, on the body's 14px gutter rather than the retired header's
 * 24px. Nothing was dropped in the move — the back pill, the two chips, the
 * state stamp, the title, the chrono, the cost and Stop are all still here,
 * because none of them is something the bar can say.
 *
 * WHERE THE BACK PILL GOES, AND WHY IT CHANGED. It used to read "Now" and lead
 * to `/projects/:id`. The bar now carries BOTH of those: its "A · Now" pill is
 * the way to the desk and the project's own chip is the way to its board. Two
 * controls a few pixels apart, both reading "Now", leading to two different
 * places, is exactly the duplication 13a exists to remove. So the pill keeps
 * its job — go up one level — and names the level that is actually above a
 * session: the project's session list, which nothing else on this screen
 * reaches.
 *
 * NEITHER CONTROL IS FILLED: this screen has no filled button by design, so the
 * Stop pill is an `--action` OUTLINE and not the coral destructive button the
 * old page used — a red border was state painted as colour, which the system
 * forbids. The word "Stop session" and the confirmation of what happens carry
 * the weight instead.
 */

export interface SessionHeaderBarProps {
  projectId: string;
  session: SessionDetail;
  ticket: SessionFilesTicket | null;
  project: SessionFilesProject | null;
  providerLabel: string;
  typeLabel: string;
  isRunning: boolean;
  onStop: () => void;
  stopping: boolean;
  stopError: string | null;
}

export function SessionHeaderBar({
  projectId,
  session,
  ticket,
  project,
  providerLabel,
  typeLabel,
  isRunning,
  onStop,
  stopping,
  stopError,
}: SessionHeaderBarProps) {
  const stamp = statusStamp(session.status);
  const showStop = isRunning || session.status === "queued";

  const cost = formatCostUsd(session.totalCostUsd);
  // Never "$0.00" and never "0": total_cost_usd is written by the CLI at
  // session END and is NULL for the whole life of a running session, for
  // legacy rows, and for every provider that does not report usage.
  const costLabel = cost === null ? "—" : isRunning ? `${cost} live` : cost;

  const endedAt = session.endedAt || session.completedAt;
  const title =
    ticket?.title ?? `${providerLabel} · ${typeLabel}`;

  return (
    <div
      data-testid="session-controls"
      className="flex h-[44px] shrink-0 items-center gap-[11px] px-[14px]"
    >
      {/* The pill recipe applied to the anchor itself rather than a
          <button> nested inside it: a button inside a link is invalid HTML and
          axe flags it, and `pillButtonVariants` is exported for exactly this. */}
      <Link
        href={`/projects/${projectId}/sessions`}
        className={cn(
          pillButtonVariants({
            variant: "outline",
            outlineTone: "neutral",
            size: "md",
          }),
          "no-underline",
        )}
      >
        <ArrowLeft size={13} aria-hidden="true" />
        Sessions
      </Link>

      {/* Colour here is PROJECT IDENTITY, never the stratum that shares the
          hex. TODO(foundation): swap the fixed tone for
          `projectTone(project.colorIndex)` once `lib/projects/color.ts`
          exists — the projects table carries no colour column yet. */}
      {project && (
        <IdentityChip
          size="sm"
          tone={1}
          label={projectShortLabel(project.name)}
        />
      )}
      {ticket && (
        <IdentityChip
          size="sm"
          tone={1}
          label={ticket.readableId ?? ticket.id.slice(0, 8).toUpperCase()}
        />
      )}

      <Stamp tone={stamp.tone} dot={stamp.dot}>
        {`${stamp.word} · ${typeLabel.toUpperCase()}`}
      </Stamp>

      <span className="min-w-0 truncate font-display text-[18px] font-bold text-foreground">
        {title}
      </span>

      <div className="ml-auto flex items-center gap-[10px]">
        {session.startedAt ? (
          isRunning ? (
            // The primitive owns its own 1s interval.
            <Chrono startedAt={session.startedAt} size={20} tone="live" />
          ) : (
            // A finished session must NOT mount the ticker: it would count on
            // forever past an end that already happened.
            <Mono size={20} weight={700} tone="live-deep">
              {compactElapsed(
                formatElapsed(
                  session.startedAt,
                  endedAt ? new Date(endedAt) : undefined
                )
              )}
            </Mono>
          )
        ) : (
          <Mono size={20} weight={700} tone="muted">
            —
          </Mono>
        )}

        <Mono size={11} tone="muted">
          {costLabel}
        </Mono>

        {stopError && (
          <Mono size={11} tone="danger">
            {stopError}
          </Mono>
        )}

        {showStop && (
          <PillButton
            variant="outline"
            outlineTone="action"
            size="md"
            icon={StopCircle}
            onClick={onStop}
            pending={stopping}
            pendingLabel="Stopping…"
          >
            Stop session
          </PillButton>
        )}
      </div>
    </div>
  );
}

/**
 * The compact elapsed glyph every frame draws: "4m12", not "4m 12s".
 *
 * `Chrono` makes exactly this transformation, but it keeps `compact()` private
 * and mounting `Chrono` for a session that has ENDED would start a 1s ticker
 * counting past the end. Duplicated here rather than forked: if the primitive
 * ever exports `compact`, delete this and import it.
 */
function compactElapsed(elapsed: string): string {
  const match = /^(\d+)([mh])\s(\d+)[ms]$/.exec(elapsed);
  if (!match) return elapsed; // "47s", and any future shape
  return `${match[1]}${match[2]}${match[3].padStart(2, "0")}`;
}

/** The agent's display name, exactly as the old page derived it. */
export function deriveTypeLabel(session: SessionDetail): string {
  return session.agentType
    ? (AGENT_TYPE_LABELS[session.agentType] ?? session.agentType)
    : session.mode;
}
