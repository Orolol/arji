/**
 * UI-facing decision layer for the ticket status control.
 *
 * The workflow engine (`lib/workflow/engine.ts`) is the source of truth and
 * validates every transition server-side; this module mirrors the parts of
 * its rules the client can evaluate on its own so the status dropdown only
 * offers what the engine would accept:
 *
 * - structural edges (backlog → todo → in_progress → review → to_merge →
 *   done → released);
 * - `→ done` requires a successful merge (the merge IS the approval) — a
 *   plain status change is rejected by the engine, so the option is shown
 *   but explicitly disabled with the reason;
 * - released is a system-only destination (release creation moves tickets
 *   there);
 * - an in_progress ticket with a queued/running session cannot be moved
 *   while the session is live.
 *
 * Guards the client cannot evaluate (completed review, resolved review
 * comments) stay server-side; their rejection errors surface inline on the
 * status control instead of being offered blindly.
 */

import type { TranslationKey } from "@/lib/i18n/catalogue";

import {
  KANBAN_COLUMNS,
  COLUMN_LABEL_KEYS,
  type KanbanStatus,
} from "@/lib/types/kanban";
import { isAllowedTransition } from "@/lib/workflow/engine";

export interface TicketStatusOption {
  status: KanbanStatus;
  labelKey: TranslationKey;
  /** True for the ticket's current column (never selectable). */
  isCurrent: boolean;
  /** Selectable in the status control. */
  enabled: boolean;
  /**
   * Why the option is not selectable: null when enabled, "Current status"
   * semantics are expressed via `isCurrent`, and a catalogue key for the reason
   * for every disabled non-current option.
   */
  disabledReasonKey: TranslationKey | null;
}

export interface TicketStatusContext {
  /**
   * A queued/running agent session on this ticket. The workflow engine
   * refuses to move an in_progress ticket while its session is live.
   */
  hasRunningSession?: boolean;
}

export const REASON_MERGE_REQUIRED_KEY =
  "Kanban.transitionReasons.mergeRequired";
export const REASON_RELEASED_SYSTEM_ONLY_KEY =
  "Kanban.transitionReasons.releasedSystemOnly";
export const REASON_SESSION_RUNNING_KEY =
  "Kanban.transitionReasons.sessionRunning";

/**
 * The option list for the ticket status control, in board column order.
 *
 * Every column appears exactly once so the control doubles as a map of what
 * is reachable: the current column is marked, allowed targets are enabled,
 * and everything else is disabled with the reason the engine would give.
 */
export function ticketStatusOptions(
  current: string,
  ctx: TicketStatusContext = {}
): TicketStatusOption[] {
  const from = current as KanbanStatus;
  const sessionLocked = current === "in_progress" && !!ctx.hasRunningSession;

  return KANBAN_COLUMNS.map((status): TicketStatusOption => {
    const labelKey = COLUMN_LABEL_KEYS[status];

    if (status === current) {
      return {
        status,
        labelKey,
        isCurrent: true,
        enabled: false,
        disabledReasonKey: null,
      };
    }

    // Released is a system-only destination from any column — explain the
    // rule even where the edge is structurally unreachable, because it is
    // the more informative reason ("the engine will get you there").
    if (status === "released") {
      return {
        status,
        labelKey,
        isCurrent: false,
        enabled: false,
        disabledReasonKey: REASON_RELEASED_SYSTEM_ONLY_KEY,
      };
    }

    if (!isAllowedTransition(from, status)) {
      return {
        status,
        labelKey,
        isCurrent: false,
        enabled: false,
        disabledReasonKey: "Kanban.transitionReasons.noDirect",
      };
    }

    // `→ done` carries the engine's merge guard (source "merge" only): a
    // plain status change is rejected, so the option is shown but explicitly
    // disabled with the reason.
    if (status === "done") {
      return {
        status,
        labelKey,
        isCurrent: false,
        enabled: false,
        disabledReasonKey: REASON_MERGE_REQUIRED_KEY,
      };
    }

    if (sessionLocked) {
      return {
        status,
        labelKey,
        isCurrent: false,
        enabled: false,
        disabledReasonKey: REASON_SESSION_RUNNING_KEY,
      };
    }

    return { status, labelKey, isCurrent: false, enabled: true, disabledReasonKey: null };
  });
}

/**
 * Whether a given target is selectable from `current` — the single question
 * the status control answers per option. Exported for tests and for callers
 * that only need the boolean.
 */
export function isTicketTransitionSelectable(
  current: string,
  to: string,
  ctx: TicketStatusContext = {}
): boolean {
  return ticketStatusOptions(current, ctx).find(
    (option) => option.status === to
  )?.enabled ?? false;
}