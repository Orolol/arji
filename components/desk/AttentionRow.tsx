"use client";

import * as React from "react";
import { GitMerge, Hammer, RefreshCw, Send, X } from "lucide-react";

import {
  GhostInputPill,
  IdentityChip,
  Mono,
  PillButton,
  Stamp,
  SurfaceCard,
  projectTone,
} from "@/components/piscine";
import type {
  DeskAwaitingReply,
  DeskConflict,
  DeskFailure,
  DeskProject,
} from "@/lib/control-desk/types";
import { cn } from "@/lib/utils";

/**
 * The three rows of the coral stratum.
 *
 * One skeleton, three contents: `Stamp` · `IdentityChip` · flexible content ·
 * fixed extras · EXACTLY ONE filled button and one outline button, then the
 * dismiss ✕. The filled one is `--action` deep water-green, never coral:
 * colour names the stratum, the WORD names the state ("ASKS YOU" / "FAILED" /
 * "CONFLICT").
 *
 * The ✕ is the row's only NON-action: it wipes a signal the user has already
 * handled somewhere else. It resolves nothing, so it is the quietest thing on
 * the row — a neutral hairline circle, last in the tab order.
 *
 * Rows are tab-walkable; ⏎ on a focused row focuses its reply field, which is
 * what the header hint "↹ parcourir · ⏎ répondre" promises.
 *
 * NARROW VIEWPORTS: the frame gives the row six children of which one flexes
 * and pins the reply field at 300px. Below roughly 1200px that overflows, so
 * the field falls back to a flexible width and the row keeps its single-line
 * shape instead of wrapping into two.
 */

const ROW_CLASS = cn(
  "flex items-center gap-3 px-[14px] py-[10px]",
  // New rows slide-fade in, using the existing tw-animate-css utilities.
  "animate-in fade-in slide-in-from-bottom-2 motion-reduce:animate-none",
  "outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring",
);

/**
 * "I have handled this elsewhere."
 *
 * Deliberately a real <button> with a spelled-out accessible name rather than
 * a hover-revealed glyph: the row is tab-walkable, so the dismiss has to be
 * reachable and announceable by keyboard too.
 */
function DismissButton({
  label,
  onDismiss,
  disabled,
}: {
  label: string;
  onDismiss: () => void;
  disabled?: boolean;
}) {
  return (
    <PillButton
      variant="outline"
      outlineTone="neutral"
      iconOnly
      icon={X}
      onClick={onDismiss}
      disabled={disabled}
      data-testid="desk-dismiss"
      className="shrink-0"
    >
      {label}
    </PillButton>
  );
}

function useRowEnter(onEnter: () => void) {
  return React.useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key !== "Enter") return;
      if (event.target !== event.currentTarget) return;
      event.preventDefault();
      onEnter();
    },
    [onEnter],
  );
}

/* ------------------------------------------------------------------ */
/* ASKS YOU                                                            */
/* ------------------------------------------------------------------ */

export interface AsksYouRowProps {
  item: DeskAwaitingReply;
  project: DeskProject | undefined;
  onReply: (item: DeskAwaitingReply, message: string) => void | Promise<void>;
  onSendToDev: (item: DeskAwaitingReply, message: string) => void | Promise<void>;
  /** Omit to hide the ✕ — the row still works without a dismissal store. */
  onDismiss?: (item: DeskAwaitingReply) => void | Promise<void>;
  pending?: boolean;
  className?: string;
}

export function AsksYouRow({
  item,
  project,
  onReply,
  onSendToDev,
  onDismiss,
  pending = false,
  className,
}: AsksYouRowProps) {
  const [draft, setDraft] = React.useState("");
  const [focusKey, setFocusKey] = React.useState<number | undefined>(undefined);
  const onKeyDown = useRowEnter(() => setFocusKey((key) => (key ?? 0) + 1));

  const send = () => {
    const message = draft.trim();
    if (!message) return;
    void onReply(item, message);
    setDraft("");
  };

  return (
    <SurfaceCard
      radius={12}
      tabIndex={0}
      onKeyDown={onKeyDown}
      data-testid="desk-asks-you-row"
      className={cn(ROW_CLASS, className)}
    >
      <Stamp tone="asks">ASKS YOU</Stamp>
      <IdentityChip
        label={item.readableId ?? project?.shortName ?? "—"}
        tone={projectTone(project?.colorIndex ?? 0)}
        size="sm"
      />
      <span className="line-clamp-1 min-w-0 flex-1 font-sans text-[14px] font-medium text-foreground">
        {item.question ? `« ${item.question} »` : item.title}
      </span>
      <GhostInputPill
        value={draft}
        onChange={setDraft}
        onSubmit={send}
        placeholder="Répondre à l'agent…"
        fill="field"
        autoFocusKey={focusKey}
        disabled={pending}
        className="w-full max-w-[300px] min-w-[120px] shrink"
        aria-label="Répondre à l'agent"
      />
      <PillButton
        variant="filled"
        size="md"
        icon={Send}
        onClick={send}
        disabled={pending || draft.trim().length === 0}
        className="gap-1.5 px-[14px]"
      >
        Send
      </PillButton>
      <PillButton
        variant="outline"
        size="md"
        icon={Hammer}
        onClick={() => void onSendToDev(item, draft.trim())}
        disabled={pending}
        className="gap-1.5"
      >
        Send to dev
      </PillButton>
      {onDismiss ? (
        <DismissButton
          label="Écarter cette question"
          onDismiss={() => void onDismiss(item)}
          disabled={pending}
        />
      ) : null}
    </SurfaceCard>
  );
}

/* ------------------------------------------------------------------ */
/* FAILED                                                              */
/* ------------------------------------------------------------------ */

export interface FailedRowProps {
  item: DeskFailure;
  project: DeskProject | undefined;
  onRetry: (item: DeskFailure) => void | Promise<void>;
  onOpenLog: (item: DeskFailure) => void;
  /** Omit to hide the ✕ — the row still works without a dismissal store. */
  onDismiss?: (item: DeskFailure) => void | Promise<void>;
  pending?: boolean;
  className?: string;
}

/** "21m ago" — the frame's relative stamp, in the row's mono meta. */
export function relativeAge(at: string | null, now: Date = new Date()): string {
  if (!at) return "—";
  const normalized = at.includes("T") ? at : `${at.replace(" ", "T")}Z`;
  const then = Date.parse(normalized);
  if (Number.isNaN(then)) return "—";
  const seconds = Math.max(0, Math.round((now.getTime() - then) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function FailedRow({
  item,
  project,
  onRetry,
  onOpenLog,
  onDismiss,
  pending = false,
  className,
}: FailedRowProps) {
  const onKeyDown = useRowEnter(() => void onRetry(item));
  const meta = [relativeAge(item.failedAt), item.agentName].filter(Boolean).join(" · ");

  return (
    <SurfaceCard
      radius={12}
      tabIndex={0}
      onKeyDown={onKeyDown}
      data-testid="desk-failed-row"
      className={cn(ROW_CLASS, className)}
    >
      <Stamp tone="failed">FAILED</Stamp>
      <IdentityChip
        label={item.readableId ?? project?.shortName ?? "—"}
        tone={projectTone(project?.colorIndex ?? 0)}
        size="sm"
      />
      <Mono size={12.5} tone="you-deep" clamp={1} className="min-w-0 flex-1">
        {item.error}
      </Mono>
      <Mono size={10.5} tone="you-mid" className="shrink-0">
        {meta}
      </Mono>
      <PillButton
        variant="filled"
        size="md"
        icon={RefreshCw}
        onClick={() => void onRetry(item)}
        pending={pending}
        pendingLabel="Retrying"
        className="gap-1.5 px-[14px]"
      >
        Retry
      </PillButton>
      <PillButton variant="outline" size="md" onClick={() => onOpenLog(item)}>
        Log
      </PillButton>
      {onDismiss ? (
        <DismissButton
          label="Écarter cet échec"
          onDismiss={() => void onDismiss(item)}
          disabled={pending}
        />
      ) : null}
    </SurfaceCard>
  );
}

/* ------------------------------------------------------------------ */
/* CONFLICT                                                            */
/* ------------------------------------------------------------------ */

export interface ConflictRowProps {
  item: DeskConflict;
  project: DeskProject | undefined;
  onResolve: (item: DeskConflict) => void | Promise<void>;
  onOpenDiff: (item: DeskConflict) => void;
  /** Omit to hide the ✕ — the row still works without a dismissal store. */
  onDismiss?: (item: DeskConflict) => void | Promise<void>;
  pending?: boolean;
  className?: string;
}

export function ConflictRow({
  item,
  project,
  onResolve,
  onOpenDiff,
  onDismiss,
  pending = false,
  className,
}: ConflictRowProps) {
  // A conflict-resolution agent merges main into the branch. That repairs a
  // genuine merge conflict and does NOTHING for committed conflict markers —
  // it would find a clean merge and leave the markers in place — so the
  // affordance is withheld for that flavour rather than offered and refused.
  const resolvable = item.blocker === "merge_conflict";
  const onKeyDown = useRowEnter(() => {
    if (resolvable) void onResolve(item);
  });

  return (
    <SurfaceCard
      radius={12}
      tabIndex={0}
      onKeyDown={onKeyDown}
      data-testid="desk-conflict-row"
      className={cn(ROW_CLASS, className)}
    >
      <Stamp tone="conflict">CONFLICT</Stamp>
      <IdentityChip
        label={item.readableId ?? project?.shortName ?? "—"}
        tone={projectTone(project?.colorIndex ?? 0)}
        size="sm"
      />
      <span className="line-clamp-1 min-w-0 flex-1 font-sans text-[14px] font-medium text-foreground">
        {resolvable ? "Conflit avec main · " : "Marqueurs de conflit commités · "}
        <Mono size={12} tone="muted">
          {item.branchName ?? item.title}
        </Mono>
      </span>
      {resolvable ? (
        <PillButton
          variant="filled"
          size="md"
          icon={GitMerge}
          onClick={() => void onResolve(item)}
          pending={pending}
          pendingLabel="Resolving"
          className="gap-1.5 px-[14px]"
        >
          Resolve with agent
        </PillButton>
      ) : null}
      <PillButton variant="outline" size="md" onClick={() => onOpenDiff(item)}>
        Diff
      </PillButton>
      {onDismiss ? (
        <DismissButton
          label="Écarter ce conflit"
          onDismiss={() => void onDismiss(item)}
          disabled={pending}
        />
      ) : null}
    </SurfaceCard>
  );
}
