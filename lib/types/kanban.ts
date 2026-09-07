import type { GradingStatus } from "@/lib/grading/report";
import type { TranslationKey } from "@/lib/i18n/catalogue";
import type { MergeReadiness } from "@/lib/kanban/merge-readiness";

export const KANBAN_COLUMNS = [
  "backlog",
  "todo",
  "in_progress",
  "review",
  "to_merge",
  "done",
  "released",
] as const;

export type KanbanStatus = (typeof KANBAN_COLUMNS)[number];

export const COLUMN_LABELS: Record<KanbanStatus, string> = {
  backlog: "Backlog",
  todo: "To Do",
  in_progress: "In Progress",
  review: "Review",
  to_merge: "To Merge",
  done: "Done",
  released: "Released",
};

/** Columns that support drag-and-drop (all except released) */
export const DRAGGABLE_COLUMNS = KANBAN_COLUMNS.filter(
  (col) => col !== "released"
) as Exclude<KanbanStatus, "released">[];

/**
 * Statuses a build agent may be dispatched from. `done` and `released` are
 * terminal delivery states: there is nothing left for a build agent to do,
 * and as a *dependency* such a ticket is an already-SATISFIED prerequisite —
 * it must never be rebuilt by a batch, and it must never hold its dependents
 * back (a ticket whose only prerequisites are done belongs to wave 1).
 */
export const BUILDABLE_STATUSES = [
  "backlog",
  "todo",
  "in_progress",
  "review",
  "to_merge",
] as const;

export type BuildableStatus = (typeof BUILDABLE_STATUSES)[number];

const BUILDABLE_STATUS_SET: ReadonlySet<string> = new Set(BUILDABLE_STATUSES);

/** Whether a ticket status still admits a build agent (see BUILDABLE_STATUSES). */
export function isBuildableStatus(status: string | null | undefined): boolean {
  return status != null && BUILDABLE_STATUS_SET.has(status);
}

/**
 * Terminal delivery states. A ticket here has shipped: nothing left to build,
 * and as a *prerequisite* it is already satisfied.
 *
 * This is deliberately not "the complement of BUILDABLE_STATUSES", and the
 * two predicates answer different questions. `isBuildableStatus` asks "may an
 * agent still be dispatched here?" and answers *no* for an unknown status.
 * `isDeliveredStatus` asks "did this prerequisite ship?" and must also answer
 * *no* for an unknown status — blocking a dependent is the conservative
 * direction, whereas negating the buildable check would silently unblock it.
 */
export const DELIVERED_STATUSES = ["done", "released"] as const;

export type DeliveredStatus = (typeof DELIVERED_STATUSES)[number];

const DELIVERED_STATUS_SET: ReadonlySet<string> = new Set(DELIVERED_STATUSES);

/**
 * Whether a ticket has shipped, i.e. whether it satisfies a dependency edge
 * pointing at it. The single definition of "delivered": dependency gates
 * (lib/dependencies/validation.ts), the board's execution queue
 * (lib/kanban/queue.ts) and the Full Auto selector all read it, so adding a
 * terminal status updates every consumer at once.
 */
export function isDeliveredStatus(status: string | null | undefined): boolean {
  return status != null && DELIVERED_STATUS_SET.has(status);
}

export const PRIORITY_LABELS: Record<number, string> = {
  0: "Low",
  1: "Medium",
  2: "High",
  3: "Critical",
};

export const PRIORITY_COLORS: Record<number, string> = {
  0: "bg-muted text-muted-foreground",
  1: "bg-priority-blue/10 text-priority-blue",
  2: "bg-priority-yellow/10 text-priority-yellow",
  3: "bg-priority-red/10 text-priority-red",
};

export interface KanbanEpic {
  id: string;
  projectId: string;
  title: string;
  description: string | null;
  priority: number;
  status: string;
  position: number;
  branchName: string | null;
  prNumber: number | null;
  prUrl: string | null;
  prStatus: string | null;
  confidence: number | null;
  evidence: string | null;
  createdAt: string;
  updatedAt: string;
  type: string; // 'feature' | 'bug'
  linkedEpicId: string | null;
  images: string | null; // JSON array
  readableId: string | null;
  releaseId: string | null;
  usCount: number;
  usDone: number;
  /**
   * How many of the epic's user stories carry a non-empty acceptance-criteria
   * rubric. Drives the Backlog readiness indicator: `usCount` alone is
   * satisfied by a story with an empty rubric, which is exactly the state that
   * makes the grading stage a no-op.
   */
  usWithCriteriaCount?: number;
  latestCommentId?: string | null;
  latestCommentAuthor?: string | null;
  latestCommentCreatedAt?: string | null;
  /** Delivery verdict of the epic's latest agent session (any status). */
  latestSessionOutcome?: string | null;
  /** When that session ended (used to order user replies vs. the question). */
  latestSessionEndedAt?: string | null;
  /** Creation time of the epic's latest user-authored comment. */
  latestUserCommentCreatedAt?: string | null;
  /** The epic's read cursor (ticket_read_cursors.last_read_at), if any. */
  lastReadAt?: string | null;
  /**
   * True when the epic's LATEST delivered review could not file anything
   * through `submit_findings` — no verdict, no findings — on a session that
   * had the tool. That review proves nothing: Full Auto will not merge the
   * epic, and it earns another review rather than a rebuild.
   *
   * Deliberately NOT a statement about `review → done`. That guard accepts
   * ANY verifiable completed review ever (lib/workflow/context.ts), so an
   * epic reviewed cleanly and then re-reviewed on a broken channel carries
   * this flag while approval still passes. The badge speaks for the merge
   * gate and for what happens next, which is what the Review column is about
   * — see lib/pipeline/findings.ts for why the asymmetry is intended.
   */
  reviewUnverifiable?: boolean;
  /** Aggregate of the latest atomic acceptance-grading report. */
  gradingStatus?: GradingStatus | null;
  gradingSummary?: string | null;
  gradingCreatedAt?: string | null;
  /**
   * Derived "can this land on main?" signal, computed by the board API from
   * the same predicate Full Auto's merge step uses
   * (lib/kanban/merge-readiness.ts). The `to_merge` status says a review
   * passed; this signal adds the git-side facts (branch present, no live
   * conflict) that only the board API can see.
   */
  mergeReadiness?: MergeReadiness | null;
}

export type KanbanAgentActionType = "build" | "review" | "merge";

export interface KanbanEpicAgentActivity {
  sessionId: string;
  actionType: KanbanAgentActionType;
  agentName: string;
  provider?: string;
  startedAt?: string;
}

export interface ReleaseGroup {
  id: string;
  version: string;
  title: string | null;
  createdAt: string;
  epics: KanbanEpic[];
}

export interface BoardState {
  columns: Record<KanbanStatus, KanbanEpic[]>;
  releaseGroups?: ReleaseGroup[];
}

/**
 * A project ticket-dependency edge (`ticket_dependencies` row, epic-level):
 * `ticketId` depends on `dependsOnTicketId`.
 */
export interface TicketDependencyEdge {
  ticketId: string;
  dependsOnTicketId: string;
}

export interface ReorderItem {
  id: string;
  status: string;
  position: number;
}

export const USER_STORY_STATUSES = ["todo", "in_progress", "review", "done"] as const;
export type UserStoryStatus = (typeof USER_STORY_STATUSES)[number];

/**
 * A MODULE-SCOPE COPY TABLE, so it holds catalogue KEY REFERENCES rather than
 * words: it is evaluated at import time and cannot call a hook, and the panel
 * that draws it resolves each key with the namespace-less translator
 * (`lib/i18n/catalogue.ts`, pattern 3).
 */
export const USER_STORY_STATUS_LABELS: Record<
  UserStoryStatus,
  { labelKey: TranslationKey }
> = {
  todo: { labelKey: "Story.status.todo" },
  in_progress: { labelKey: "Story.status.inProgress" },
  review: { labelKey: "Story.status.review" },
  done: { labelKey: "Story.status.done" },
};
