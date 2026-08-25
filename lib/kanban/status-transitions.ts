/**
 * UI-facing decision layer for the ticket status control.
 *
 * The workflow engine (`lib/workflow/engine.ts`) is the source of truth and
 * validates every transition server-side; this module mirrors the parts of
 * its rules the client can evaluate on its own so the status dropdown only
 * offers what the engine would accept:
 *
 * - structural edges (backlog → todo → in_progress → review → done →
 *   released);
 * - review → done requires the explicit Approve action (or a merge) — a
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

import {
  KANBAN_COLUMNS,
  COLUMN_LABELS,
  type KanbanStatus,
} from "@/lib/types/kanban";
import { isAllowedTransition } from "@/lib/workflow/engine";

export interface TicketStatusOption {
  status: KanbanStatus;
  label: string;
  /** True for the ticket's current column (never selectable). */
  isCurrent: boolean;
  /** Selectable in the status control. */
  enabled: boolean;
  /**
   * Why the option is not selectable: null when enabled, "Current status"
   * semantics are expressed via `isCurrent`, and a human-readable reason
   * for every disabled non-current option.
   */
  disabledReason: string | null;
}

export interface TicketStatusContext {
  /**
   * A queued/running agent session on this ticket. The workflow engine
   * refuses to move an in_progress ticket while its session is live.
   */
  hasRunningSession?: boolean;
}

export const REASON_APPROVAL_REQUIRED =
  "Done requires approval — use the Approve action.";
export const REASON_RELEASED_SYSTEM_ONLY =
  "Tickets reach Released automatically when a release is created.";
export const REASON_SESSION_RUNNING =
  "An agent session is running or queued for this ticket.";

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
    const label = COLUMN_LABELS[status] ?? status;

    if (status === current) {
      return {
        status,
        label,
        isCurrent: true,
        enabled: false,
        disabledReason: null,
      };
    }

    // Released is a system-only destination from any column — explain the
    // rule even where the edge is structurally unreachable, because it is
    // the more informative reason ("the engine will get you there").
    if (status === "released") {
      return {
        status,
        label,
        isCurrent: false,
        enabled: false,
        disabledReason: REASON_RELEASED_SYSTEM_ONLY,
      };
    }

    if (!isAllowedTransition(from, status)) {
      return {
        status,
        label,
        isCurrent: false,
        enabled: false,
        disabledReason: `No direct transition from ${COLUMN_LABELS[from] ?? from}`,
      };
    }

    // review → done carries the engine's approval guard (completed review,
    // resolved comments, approve/merge): a plain status change is rejected,
    // so the option is shown but explicitly disabled with the reason.
    if (from === "review" && status === "done") {
      return {
        status,
        label,
        isCurrent: false,
        enabled: false,
        disabledReason: REASON_APPROVAL_REQUIRED,
      };
    }

    if (sessionLocked) {
      return {
        status,
        label,
        isCurrent: false,
        enabled: false,
        disabledReason: REASON_SESSION_RUNNING,
      };
    }

    return { status, label, isCurrent: false, enabled: true, disabledReason: null };
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