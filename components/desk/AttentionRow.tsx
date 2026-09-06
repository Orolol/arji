"use client";

import * as React from "react";
import { useCallback, useState } from "react";
import { GitMerge, Hammer, RefreshCw, Send, X } from "lucide-react";
import { useLocale } from "next-intl";

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
import { formatRelative } from "@/lib/i18n/format";
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
 * NARROW VIEWPORTS — B-arij-M9zsQujUTCoR.
 *
 * The row used to be ONE flex line at every width, and the note that stood
 * here claimed a flexible field kept it single-line "instead of wrapping into
 * two". It did not: every child but the message is `shrink-0` (the stamp, the
 * chip, all three buttons) or floored at `min-w-[120px]` (the field), so the
 * line has a ~544px min-content width it cannot go under. Measured in Chrome
 * at 390×844 on a 326px card: content 570px, the question span 0px wide,
 * `Send to dev` ending at x=561 and the ✕ at x=573 — both outside the
 * viewport. At 768 the line fitted (702 in 704) and the question was STILL 0px.
 *
 * So the row folds. Below `lg` it is a COLUMN of two groups — identity and
 * message, then field and actions — each of which wraps internally, so the
 * browser decides how many lines a given width needs rather than a breakpoint
 * guessing. From `lg` up both groups are `display: contents`: the card gets
 * its original six children back as direct flex items and the desktop
 * proportions are unchanged by construction, not by re-tuning.
 *
 * `lg` (1024px), not `md`: at 768 a single line still fits arithmetically and
 * the measurement is what rejected it — the fixed children take 544px of a
 * 676px card, leaving the message nothing.
 */

const ROW_CLASS = cn(
  "flex items-center gap-3 px-[14px] py-[10px]",
  "max-lg:flex-col max-lg:items-stretch max-lg:gap-2",
  // New rows slide-fade in, using the existing tw-animate-css utilities.
  "animate-in fade-in slide-in-from-bottom-2 motion-reduce:animate-none",
  "outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring",
);

/**
 * Identity and message. `contents` at `lg` — the wrapper exists only to give
 * the phone a line to wrap inside, and above the breakpoint it is not a box at
 * all, so it cannot change a single desktop measurement.
 */
const ROW_HEAD_CLASS = cn(
  "contents",
  "max-lg:flex max-lg:min-w-0 max-lg:flex-wrap max-lg:items-center max-lg:gap-x-2 max-lg:gap-y-1.5",
);

/** Field, buttons and the ✕ — same rule, right-aligned while it is a box. */
const ROW_ACTIONS_CLASS = cn(
  "contents",
  "max-lg:flex max-lg:min-w-0 max-lg:flex-wrap max-lg:items-center max-lg:justify-end max-lg:gap-2",
);

/**
 * The send/dismiss cluster of the ASKS YOU row, kept on ONE line below `lg`.
 *
 * Without it the three buttons wrap individually against the reply field, and
 * every width has its own arbitrary split — at 390 "Send" stayed beside the
 * field while "Send to dev" and the ✕ dropped. As a single unwrappable unit
 * they either all share the field's line or all take the next one, and the
 * threshold is the cluster's own width rather than a breakpoint.
 */
const ROW_BUTTONS_CLASS = cn(
  "contents",
  "max-lg:flex max-lg:shrink-0 max-lg:items-center max-lg:gap-2",
);

/**
 * The row's message — the question, the error, the conflicted branch.
 *
 * `basis-full` below `sm` only: on a phone it is the whole point of the row and
 * the identity chips leave it 142px, while from 640px up the head line has
 * enough width to carry all three.
 */
const ROW_MESSAGE_CLASS = "min-w-0 flex-1 max-sm:basis-full";

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
  return useCallback(
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
  const [draft, setDraft] = useState("");
  const [focusKey, setFocusKey] = useState<number | undefined>(undefined);
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
      <div data-testid="desk-row-head" className={ROW_HEAD_CLASS}>
        <Stamp tone="asks">ASKS YOU</Stamp>
        <IdentityChip
          label={item.readableId ?? project?.shortName ?? "—"}
          tone={projectTone(project?.colorIndex ?? 0)}
          size="sm"
        />
        <span
          className={cn(
            ROW_MESSAGE_CLASS,
            "line-clamp-1 font-sans text-[14px] font-medium text-foreground",
            // Two lines on a phone, where the row has one line of its own to
            // spend and 40 characters is not a question.
            "max-sm:line-clamp-2",
          )}
        >
          {item.question ? `« ${item.question} »` : item.title}
        </span>
      </div>
      <div data-testid="desk-row-actions" className={ROW_ACTIONS_CLASS}>
        <GhostInputPill
          value={draft}
          onChange={setDraft}
          onSubmit={send}
          placeholder="Répondre à l'agent…"
          fill="field"
          autoFocusKey={focusKey}
          disabled={pending}
          // `flex-[1 1 200px]` below lg, NOT the desktop `min-w-[120px]` floor:
          // a 200px hypothetical size is what makes the three buttons wrap onto
          // their own line at 390px and stay beside the field at 768px, with the
          // browser — not a breakpoint — deciding which.
          className={cn(
            "w-full max-w-[300px] min-w-[120px] shrink",
            "max-lg:max-w-none max-lg:flex-[1_1_240px]",
          )}
          aria-label="Répondre à l'agent"
        />
        <div data-testid="desk-row-buttons" className={ROW_BUTTONS_CLASS}>
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
        </div>
      </div>
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
  const locale = useLocale();
  // "21m ago" — the frame's relative stamp, counted in seconds while fresh.
  const age = formatRelative(item.failedAt, { locale, precision: "second" }) || "—";
  const meta = [age, item.agentName].filter(Boolean).join(" · ");

  return (
    <SurfaceCard
      radius={12}
      tabIndex={0}
      onKeyDown={onKeyDown}
      data-testid="desk-failed-row"
      className={cn(ROW_CLASS, className)}
    >
      <div data-testid="desk-row-head" className={ROW_HEAD_CLASS}>
        <Stamp tone="failed">FAILED</Stamp>
        <IdentityChip
          label={item.readableId ?? project?.shortName ?? "—"}
          tone={projectTone(project?.colorIndex ?? 0)}
          size="sm"
        />
        <Mono size={12.5} tone="you-deep" clamp={1} className={ROW_MESSAGE_CLASS}>
          {item.error}
        </Mono>
        <Mono size={10.5} tone="you-mid" className="shrink-0">
          {meta}
        </Mono>
      </div>
      <div data-testid="desk-row-actions" className={ROW_ACTIONS_CLASS}>
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
      </div>
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
      <div data-testid="desk-row-head" className={ROW_HEAD_CLASS}>
        <Stamp tone="conflict">CONFLICT</Stamp>
        <IdentityChip
          label={item.readableId ?? project?.shortName ?? "—"}
          tone={projectTone(project?.colorIndex ?? 0)}
          size="sm"
        />
        <span
          className={cn(
            ROW_MESSAGE_CLASS,
            "line-clamp-1 font-sans text-[14px] font-medium text-foreground",
            "max-sm:line-clamp-2",
          )}
        >
          {resolvable ? "Conflit avec main · " : "Marqueurs de conflit commités · "}
          <Mono size={12} tone="muted">
            {item.branchName ?? item.title}
          </Mono>
        </span>
      </div>
      <div data-testid="desk-row-actions" className={ROW_ACTIONS_CLASS}>
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
      </div>
    </SurfaceCard>
  );
}
