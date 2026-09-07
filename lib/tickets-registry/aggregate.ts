/**
 * The pure half of the tickets registry (frame 12a).
 *
 * `app/api/tickets/route.ts` runs the SQL; everything that turns rows into the
 * registry's five groups lives here, with no database import, so the whole
 * derivation is testable from plain objects. Exactly the discipline of
 * `lib/control-desk/aggregate.ts`, and for the same reason.
 *
 * THE RULE THIS MODULE EXISTS TO ENFORCE: every group predicate is a CALL into
 * a helper the desk already calls. The registry must never disagree with the
 * desk about what state a ticket is in — a fresh `if (status === ...)` here is
 * precisely the drift `lib/control-desk/aggregate.ts` was written to prevent.
 *
 *   active      → `deriveWorking()`         (filters `status === "running"`)
 *   your_turn/asks     → `deriveAwaitingReply()` → `isAwaitingReply()`
 *   your_turn/failed   → `deriveFailures()`      → `selectLatestFailures()`
 *   your_turn/conflict → `deriveConflicts()`     → `evaluateMergeReadiness()`
 *   waiting rank/blocks→ `deriveUpNext()`        → `computeQueueRanks()` +
 *                                                  `computeBlockedBy()` +
 *                                                  `compareExecutionOrder()`
 *   done readiness     → `evaluateMergeReadiness()` / `describeMergeBlocker()`
 *   released/done/waiting membership → `lib/types/kanban.ts` statuses
 */

import type { TranslationKey } from "@/lib/i18n/catalogue";
import { formatRelative } from "@/lib/i18n/format";
import type { UiLocale } from "@/lib/i18n/locales";
import {
  deriveAwaitingReply,
  deriveConflicts,
  deriveFailures,
  deriveQueued,
  deriveUpNext,
  deriveWorking,
  normalizeLogLine,
  type EpicRow,
  type DependencyEpicRow,
  type FailureSessionRow,
  type SessionRow,
} from "@/lib/control-desk/aggregate";
import type { DeskProject, DeskTaskType } from "@/lib/control-desk/types";
import {
  describeMergeBlocker,
  evaluateMergeReadiness,
  type MergeReadinessFacts,
} from "@/lib/kanban/merge-readiness";

import type { TicketDependencyEdge } from "@/lib/types/kanban";

import {
  REGISTRY_GROUP_ORDER,
  type RegistryCounts,
  type RegistryGroup,
  type RegistryRow,
  type YourTurnKind,
} from "./types";

/* ------------------------------------------------------------------ */
/* Display vocabularies                                                */
/* ------------------------------------------------------------------ */

/**
 * The ACTIVE cell's word for a dispatch role.
 *
 * An explicit map, not `taskType[0] + taskType.slice(1).toLowerCase()`: that
 * would render "Qa" for QA. Tailwind's "write the class out in full" rule has
 * a copy analogue, and this is it.
 *
 * NO COPY IN THIS TABLE, per `lib/i18n/catalogue.ts` pattern 3: it is
 * evaluated at import time and read by the route as well as by the row, so it
 * holds catalogue KEY REFERENCES and the component that draws it resolves
 * them with the namespace-less translator — `t(TASK_LABEL[taskType].labelKey)`.
 */
export const TASK_LABEL: Record<DeskTaskType, { labelKey: TranslationKey }> = {
  BUILD: { labelKey: "Registry.task.build" },
  REVIEW: { labelKey: "Registry.task.review" },
  MERGE: { labelKey: "Registry.task.merge" },
  GRADING: { labelKey: "Registry.task.grading" },
  QA: { labelKey: "Registry.task.qa" },
  MEMORY: { labelKey: "Registry.task.memory" },
  RELEASE: { labelKey: "Registry.task.release" },
  REFINEMENT: { labelKey: "Registry.task.refinement" },
  CHAT: { labelKey: "Registry.task.chat" },
};

/**
 * Group header copy. Source form is sentence case; CSS uppercases it — and
 * the table holds the catalogue key, not the word (pattern 3 again: the group
 * header draws it, the CSV writes it, and neither may fork the vocabulary).
 */
export const GROUP_LABEL: Record<RegistryGroup, { labelKey: TranslationKey }> = {
  active: { labelKey: "Registry.groups.active" },
  your_turn: { labelKey: "Registry.groups.yourTurn" },
  waiting: { labelKey: "Registry.groups.waiting" },
  done: { labelKey: "Registry.groups.done" },
  released: { labelKey: "Registry.groups.released" },
};

/** Rows a collapsed group shows before the "+ n autres" line, per the frame. */
export const GROUP_PREVIEW: Record<RegistryGroup, number> = {
  active: 4,
  your_turn: 4,
  waiting: 4,
  done: 3,
  released: 2,
};

/** `null` → the em-dash. A count that does not exist is never a zero. */
export function fmtCount(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "—";
}

/* ------------------------------------------------------------------ */
/* Inputs                                                             */
/* ------------------------------------------------------------------ */

/**
 * An epic row as the registry reads it: everything `EpicRow` carries (so the
 * desk's helpers accept it unchanged) plus the four columns only this screen
 * needs.
 *
 * `epics.description` is NOT here and must never be: it is uncapped
 * agent-written markdown of the same hazard class as `agent_sessions.prompt`,
 * and the registry renders no description.
 */
export interface RegistryEpicRow extends EpicRow {
  createdAt: string | null;
  updatedAt: string | null;
  releaseId: string | null;
}

export interface RegistrySessionRow extends SessionRow {
  activityAt: string | null;
}

export interface RegistryDeriveInput {
  projects: readonly DeskProject[];
  epics: readonly RegistryEpicRow[];
  /** Every `running` / `queued` session, the desk's own read. */
  sessions: readonly RegistrySessionRow[];
  /** Newest-session-per-epic rows inside the 14-day failure cutoff. */
  failureSessions: readonly FailureSessionRow[];
  edges: readonly TicketDependencyEdge[];
  /** Prerequisite facts independent of search, filters and terminal windows. */
  dependencyEpics?: readonly DependencyEpicRow[];
  /** `releases.id → version`, for the released group's stamp. */
  releaseVersionById: ReadonlyMap<string, string>;
  /** `SUM(total_cost_usd)` per epic. Absent AND null both mean "no cost". */
  costByEpicId: ReadonlyMap<string, number | null>;
  /**
   * The interface locale the activity stamps are written in. The route
   * composes these strings on the server, so it resolves the request's
   * locale (`resolveUiLocaleForRequest`) and passes it down: the shared
   * `formatRelative` never guesses one.
   */
  locale: UiLocale;
  now?: Date;
}

function mergeFactsOf(epic: RegistryEpicRow): MergeReadinessFacts {
  return {
    status: epic.status,
    branchName: epic.branchName,
    openFindings: epic.openFindings,
    lastCleanReviewAt: epic.lastCleanReviewAt,
    lastTerminalCodeAt: epic.lastTerminalCodeAt,
    lastNegativeVerdictReviewAt: epic.lastNegativeVerdictReviewAt,
    supersessionAt: epic.supersessionAt,
    lastMergeConflictAt: epic.lastMergeConflictAt,
    lastConflictMarkersAt: epic.lastConflictMarkersAt,
  };
}



/* ------------------------------------------------------------------ */
/* The composed DERNIÈRE ACTIVITÉ string                               */
/* ------------------------------------------------------------------ */

export interface ActivityInput {
  group: RegistryGroup;
  yourTurnKind: YourTurnKind | null;
  status: string;
  blocked: boolean;
  mergeReady: boolean;
  lastLogLine: string | null;
  askedAt: string | null;
  failedAt: string | null;
  failureError: string | null;
  conflictAt: string | null;
  branchName: string | null;
  prNumber: number | null;
  openFindings: number | null;
  createdAt: string | null;
  updatedAt: string | null;
  locale: UiLocale;
  now?: Date;
}

/**
 * The phrases the sixth column is built from, ALREADY RESOLVED by the caller.
 *
 * A `lib/` derivation that composes copy takes resolved phrases rather than a
 * translator (`lib/i18n/catalogue.ts`, pattern 3): that keeps every
 * `Registry.activity.*` key literal next to a real `translatorFor` binding —
 * `app/api/tickets/route.ts`, the one place that knows the request's locale —
 * where both a reader and `scripts/i18n/check-keys.mjs` can see it.
 *
 * The entries that vary with the row are small closures, exactly as
 * `components/spec/spec-format.ts` takes `copy.saved(age)`.
 */
export interface ActivityCopy {
  columns: Record<string, string>;
  running: (line: string) => string;
  question: (age: string) => string;
  failed: (error: string, age: string) => string;
  /** The word standing in for an unreadable failure line. */
  failedFallback: string;
  conflict: (branch: string, age: string) => string;
  /** The word standing in for a ticket with no recorded branch. */
  branchUnknown: string;
  blocked: (age: string) => string;
  created: (age: string) => string;
  updated: (age: string) => string;
  merged: (age: string) => string;
  released: (age: string) => string;
  reviewClean: string;
  findings: (count: number) => string;
  withPr: (pr: number, detail: string) => string;
}

/**
 * The one place the sixth column's string is built, so the CSV and the DOM can
 * never say different things about the same row.
 *
 * Real codepoints throughout: `›` U+203A, `…` U+2026, `·` U+00B7. ASCII
 * lookalikes break Space Mono's tabular alignment (see `components/piscine/
 * Mono.tsx`).
 *
 * "21m ago" is the shared `formatRelative` (seconds while fresh, the same
 * stamp the desk's failure rows print); an unreadable timestamp is an em dash.
 */
export function composeActivity(
  input: ActivityInput,
  copy: ActivityCopy,
): {
  activity: string | null;
  tone: "muted" | "you-deep";
} {
  const age = (at: string | null) =>
    formatRelative(at, { locale: input.locale, now: input.now, precision: "second" }) || "—";

  if (input.group === "active") {
    return { activity: copy.running(input.lastLogLine ?? "…"), tone: "muted" };
  }

  if (input.group === "your_turn") {
    if (input.yourTurnKind === "asks") {
      return { activity: copy.question(age(input.askedAt)), tone: "muted" };
    }
    if (input.yourTurnKind === "failed") {
      const error = normalizeLogLine(input.failureError) ?? copy.failedFallback;
      return { activity: copy.failed(error, age(input.failedAt)), tone: "you-deep" };
    }
    // conflict. The frame draws "2 files vs main"; nothing durable records the
    // conflicting file list (the activity-log reason is free prose), so the
    // branch is named instead of inventing files.
    return {
      activity: copy.conflict(input.branchName ?? copy.branchUnknown, age(input.conflictAt)),
      tone: "muted",
    };
  }

  if (input.group === "waiting") {
    if (input.blocked) {
      return { activity: copy.blocked(age(input.updatedAt)), tone: "muted" };
    }
    if (input.status === "backlog") {
      return { activity: copy.created(age(input.createdAt)), tone: "muted" };
    }
    return { activity: copy.updated(age(input.updatedAt)), tone: "muted" };
  }

  if (input.group === "done") {
    if (input.status === "to_merge" && input.mergeReady) {
      const detail =
        input.openFindings !== null && input.openFindings > 0
          ? copy.findings(input.openFindings)
          : copy.reviewClean;
      return {
        activity: input.prNumber ? copy.withPr(input.prNumber, detail) : detail,
        tone: "muted",
      };
    }
    if (input.status === "done") {
      return { activity: copy.merged(age(input.updatedAt)), tone: "muted" };
    }
    // to_merge, blocked: the blocker line already fills ÉTAT.
    return { activity: copy.updated(age(input.updatedAt)), tone: "muted" };
  }

  return { activity: copy.released(age(input.updatedAt)), tone: "muted" };
}

/* ------------------------------------------------------------------ */
/* The rows                                                            */
/* ------------------------------------------------------------------ */

/**
 * Group membership, evaluated in this order, first match wins:
 *
 *   1 active            a `running` session owns the epic
 *   2 your_turn/asks    `isAwaitingReply`
 *   3 your_turn/failed  the latest-failure selection names it
 *   4 your_turn/conflict merge blocker is `merge_conflict`/`conflict_markers`
 *   5 released          `status === "released"`
 *   6 done              `status` is `to_merge` or `done`
 *   7 waiting           everything else
 *
 * The ordering is load-bearing twice over: a `to_merge` ticket with a live
 * conflict lands in YOUR TURN exactly as it does on the desk, and a `to_merge`
 * ticket that is ready lands in DONE as "Ready to land".
 */
export function deriveRegistryRows(
  input: RegistryDeriveInput,
  copy: ActivityCopy,
): RegistryRow[] {
  const now = input.now ?? new Date();
  const projectsById = new Map(input.projects.map((project) => [project.id, project]));

  const working = new Map(
    deriveWorking(input.sessions)
      .filter((session) => session.epicId)
      .map((session) => [session.epicId as string, session]),
  );
  const queuedEpicIds = new Set(
    deriveQueued(input.sessions)
      .filter((session) => session.epicId)
      .map((session) => session.epicId as string),
  );
  const busyEpicIds = new Set([...working.keys(), ...queuedEpicIds]);
  const runningEpicIds = new Set(working.keys());

  const epicsById = new Map<string, EpicRow>(input.epics.map((epic) => [epic.id, epic]));

  const asks = new Map(
    deriveAwaitingReply(input.epics).map((row) => [row.epicId, row]),
  );
  const failures = new Map(
    deriveFailures(input.failureSessions, epicsById, runningEpicIds).map((row) => [
      row.epicId,
      row,
    ]),
  );
  const conflicts = new Map(deriveConflicts(input.epics).map((row) => [row.epicId, row]));

  // The WHOLE derivation, not `computeQueueRanks` on its own: taking it entire
  // is the only way the registry's `To Do · #1` and the desk's UP NEXT rank-1
  // chip are guaranteed to name the same ticket.
  const queueTickets = new Map(
    deriveUpNext(input.projects, input.epics, input.edges, busyEpicIds, input.dependencyEpics).flatMap(
      (project) => project.tickets.map((ticket) => [ticket.epicId, ticket] as const),
    ),
  );

  const activityBySession = new Map(input.sessions.map((session) => [session.id, session.activityAt]));

  return input.epics.map((epic) => {
    const status = epic.status ?? "";
    const live = working.get(epic.id);
    const ask = asks.get(epic.id);
    const failure = failures.get(epic.id);
    const conflict = conflicts.get(epic.id);
    const readiness = evaluateMergeReadiness(mergeFactsOf(epic));
    const queue = queueTickets.get(epic.id);
    const project = projectsById.get(epic.projectId);

    let group: RegistryGroup;
    let yourTurnKind: YourTurnKind | null = null;
    if (live) {
      group = "active";
    } else if (ask) {
      group = "your_turn";
      yourTurnKind = "asks";
    } else if (failure) {
      group = "your_turn";
      yourTurnKind = "failed";
    } else if (conflict) {
      group = "your_turn";
      yourTurnKind = "conflict";
    } else if (status === "released") {
      group = "released";
    } else if (status === "to_merge" || status === "done") {
      group = "done";
    } else {
      group = "waiting";
    }

    const blockedBy = queue?.blockedBy ?? [];
    const { activity, tone } = composeActivity(
      {
        locale: input.locale,
        group,
        yourTurnKind,
        status,
        blocked: blockedBy.length > 0,
        mergeReady: readiness.ready,
        lastLogLine: live?.lastLogLine ?? null,
        askedAt: ask?.askedAt ?? null,
        failedAt: failure?.failedAt ?? null,
        failureError: failure?.error ?? null,
        conflictAt: conflict?.at ?? null,
        branchName: epic.branchName,
        prNumber: epic.prNumber,
        openFindings: epic.openFindings,
        createdAt: epic.createdAt,
        updatedAt: epic.updatedAt,
        now,
      },
      copy,
    );

    const cost = input.costByEpicId.get(epic.id);

    return {
      epicId: epic.id,
      projectId: epic.projectId,
      readableId: epic.readableId,
      title: epic.title,
      status,
      type: epic.type ?? "feature",
      priority: typeof epic.priority === "number" ? epic.priority : null,
      group,
      taskType: live?.taskType ?? null,
      startedAt: live?.startedAt ?? null,
      yourTurnKind,
      queueLabel: group === "waiting" ? (copy.columns[status] ?? null) : null,
      queueRank: group === "waiting" ? (queue?.rank ?? null) : null,
      blockedBy: group === "waiting" ? blockedBy : [],
      isDraft: group === "waiting" && status === "backlog",
      isQueued: group === "waiting" && queuedEpicIds.has(epic.id),
      mergeReady: readiness.ready,
      mergeBlockerLine: describeMergeBlocker(readiness),
      releaseVersion:
        epic.releaseId ? (input.releaseVersionById.get(epic.releaseId) ?? null) : null,
      usDone: epic.usDone,
      usCount: epic.usCount,
      activity,
      activityTone: tone,
      activityAt: (live ? activityBySession.get(live.sessionId) ?? live.startedAt : null) ?? ask?.askedAt ?? failure?.failedAt ?? conflict?.at
        ?? (status === "backlog" && blockedBy.length === 0 ? epic.createdAt : epic.updatedAt),
      costUsd: typeof cost === "number" && Number.isFinite(cost) ? cost : null,
      projectName: project?.name ?? "",
    } satisfies RegistryRow;
  });
}

/* ------------------------------------------------------------------ */
/* Totals                                                              */
/* ------------------------------------------------------------------ */

export interface RegistryTotalsInput {
  rows: readonly RegistryRow[];
  /** Exact `COUNT(*) GROUP BY status` over the scope, the only true tally. */
  statusCounts: ReadonlyMap<string, number>;
}

export interface RegistryTotals {
  groupTotals: Record<RegistryGroup, number>;
  groupLoaded: Record<RegistryGroup, number>;
  counts: RegistryCounts;
}

/**
 * True group totals from windowed rows.
 *
 * The open working set (`backlog…to_merge`) is loaded WHOLE, so its three
 * groups are already exact. `done` and `released` grow forever and arrive
 * through a window, so their totals are the loaded group count PLUS the rows
 * of that status the window did not reach. That remainder is what makes
 * "+ 18 autres released" the true number rather than "however many we loaded".
 *
 * The one approximation, stated rather than hidden: an unloaded `done`/
 * `released` row that a running session or an unanswered question would have
 * promoted into ACTIVE / YOUR TURN is counted in its status's group. The
 * caller chooses the window order, so even recent promotions may be omitted;
 * ACTIVE / YOUR TURN can be understated and terminal groups overstated.
 * Dependency readiness is separate: it uses complete prerequisite facts.
 */
export function deriveRegistryTotals(input: RegistryTotalsInput): RegistryTotals {
  const groupLoaded: Record<RegistryGroup, number> = {
    active: 0,
    your_turn: 0,
    waiting: 0,
    done: 0,
    released: 0,
  };
  let loadedStatusDone = 0;
  let loadedStatusReleased = 0;

  for (const row of input.rows) {
    groupLoaded[row.group] += 1;
    if (row.status === "done") loadedStatusDone += 1;
    if (row.status === "released") loadedStatusReleased += 1;
  }

  const doneRemainder = Math.max(
    0,
    (input.statusCounts.get("done") ?? 0) - loadedStatusDone,
  );
  const releasedRemainder = Math.max(
    0,
    (input.statusCounts.get("released") ?? 0) - loadedStatusReleased,
  );

  const groupTotals: Record<RegistryGroup, number> = {
    active: groupLoaded.active,
    your_turn: groupLoaded.your_turn,
    waiting: groupLoaded.waiting,
    done: groupLoaded.done + doneRemainder,
    released: groupLoaded.released + releasedRemainder,
  };

  const open = groupTotals.active + groupTotals.your_turn + groupTotals.waiting;
  return {
    groupTotals,
    groupLoaded,
    counts: {
      all: open + groupTotals.done + groupTotals.released,
      open,
      active: groupTotals.active,
      yourTurn: groupTotals.your_turn,
      done: groupTotals.done,
      released: groupTotals.released,
    },
  };
}

/** Group order, re-exported so the table never invents its own. */
export { REGISTRY_GROUP_ORDER };
