/**
 * The pure half of the control desk.
 *
 * `app/api/control-desk/route.ts` runs the SQL; everything that turns rows
 * into the desk's five strata lives here, with no database import, so the
 * whole derivation is testable from plain objects.
 *
 * The rule this module follows everywhere: derive with the EXISTING shared
 * predicates (`lib/kanban/*`, `lib/agent-sessions/latest-failure.ts`) rather
 * than re-deciding anything. A second opinion about "ready to merge" or
 * "awaiting reply" is exactly the drift those modules exist to prevent.
 */

import {
  evaluateMergeReadiness,
  type MergeReadinessFacts,
} from "@/lib/kanban/merge-readiness";
import { isAwaitingReply } from "@/lib/kanban/awaiting-reply";
import { hasUnreadAiComment } from "@/lib/kanban/unread-ai";
import {
  compareExecutionOrder,
  computeBlockedBy,
  computeQueueRanks,
  type ExecutionOrderEpic,
} from "@/lib/kanban/queue";
import { isDeliveredStatus, type TicketDependencyEdge } from "@/lib/types/kanban";
import {
  selectLatestFailures,
  type FailureCandidateSession,
} from "@/lib/agent-sessions/latest-failure";

import type {
  DeskAwaitingReply,
  DeskConflict,
  DeskFailure,
  DeskLandRow,
  DeskProject,
  DeskQueuedSession,
  DeskQueueTicket,
  DeskTaskType,
  DeskToday,
  DeskUpNextProject,
  DeskWorkingSession,
} from "./types";
import { LOG_LINE_LIMIT } from "./types";

/* ------------------------------------------------------------------ */
/* Projects                                                            */
/* ------------------------------------------------------------------ */

export interface ProjectRow {
  id: string;
  name: string;
  createdAt?: string | null;
  activeAgents?: number | null;
  autoModeEnabled?: boolean;
}

/**
 * Mono rail label. The design wants "ARIJ" / "LEDGER" / "PIXELBOX"; the only
 * stored identity is the project name, and the ticket prefix is a slug of that
 * same name, so there is exactly one source and this is it.
 */
export function shortProjectName(name: string): string {
  const words = name.split(/[^A-Za-z0-9]+/).filter((word) => word.length > 0);
  if (words.length === 0) return "?";

  const squashed = words.join("").toUpperCase();
  if (squashed.length <= MAX_SHORT_NAME) return squashed;

  // Too long to squash. Keep the head of the first word and ONE initial per
  // remaining word: "Arij Front" → ARIJF, not ARIJFRON. Distinctness is the
  // job here — two projects rendering the same rail label makes the UP NEXT
  // rows indistinguishable, which is worse than an abbreviation.
  const initials = words.slice(1).map((word) => word[0].toUpperCase()).join("");
  const head = words[0]
    .toUpperCase()
    .slice(0, Math.max(1, MAX_SHORT_NAME - initials.length));
  return `${head}${initials}`.slice(0, MAX_SHORT_NAME);
}

/** The rail label sits in a fixed 70px mono column. */
const MAX_SHORT_NAME = 8;

/**
 * Project identity colours.
 *
 * There is no `projects.color_index` column and this packet may not add one, so
 * the handoff's documented alternative is used: the position in creation order.
 * Ordering is done here rather than in SQL so the mapping is one deterministic
 * rule the tests can pin. Beyond four projects the cycle wraps and two projects
 * share a colour — accepted by the design.
 */
export function deriveProjects(rows: readonly ProjectRow[]): DeskProject[] {
  return [...rows]
    .sort((a, b) => {
      const byCreated = (a.createdAt ?? "").localeCompare(b.createdAt ?? "");
      if (byCreated !== 0) return byCreated;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    })
    .map((row, index) => ({
      id: row.id,
      name: row.name,
      shortName: shortProjectName(row.name),
      colorIndex: index,
      activeAgents: Math.max(0, Math.trunc(Number(row.activeAgents ?? 0)) || 0),
      autoModeEnabled: row.autoModeEnabled === true,
    }));
}

/* ------------------------------------------------------------------ */
/* WORKING / QUEUED                                                    */
/* ------------------------------------------------------------------ */

export interface SessionRow {
  id: string;
  projectId: string;
  epicId: string | null;
  userStoryId: string | null;
  status: string | null;
  mode: string | null;
  agentType: string | null;
  orchestrationMode: string | null;
  provider: string | null;
  namedAgentName: string | null;
  prompt: string | null;
  batchRunId: string | null;
  startedAt: string | null;
  createdAt: string | null;
  lastLogLine: string | null;
  epicTitle: string | null;
  epicReadableId: string | null;
  storyTitle: string | null;
  stale?: boolean;
}

/**
 * Dispatch role of a session, as the card prints it.
 *
 * The classification is the one `app/api/projects/[projectId]/sessions/active`
 * applies (agent type first, orchestration second, prompt heuristics last);
 * only the vocabulary differs, because the card prints one uppercase word.
 * Kept as a pure function here so the desk does not have to fan out to that
 * per-project route once per project.
 */
export function inferTaskType(row: {
  agentType: string | null;
  orchestrationMode: string | null;
  mode: string | null;
  prompt: string | null;
}): DeskTaskType {
  const agentType = row.agentType ?? "";
  if (agentType === "release_notes") return "RELEASE";
  if (agentType === "grading") return "GRADING";
  if (agentType === "refinement") return "REFINEMENT";
  if (agentType.startsWith("review_")) return "REVIEW";
  if (agentType === "tech_check" || agentType === "e2e_test" || agentType === "failure_digest") {
    return "QA";
  }
  if (agentType === "memory_distill" || agentType === "dreaming") return "MEMORY";
  if (agentType === "merge") return "MERGE";
  if (row.orchestrationMode === "team") return "BUILD";

  const prompt = (row.prompt ?? "").toLowerCase();
  if (prompt.includes("merge conflict") || prompt.includes("git merge main")) {
    return "MERGE";
  }
  if (row.mode === "plan" || /you are performing a \*\*.+review/.test(prompt)) {
    return "REVIEW";
  }
  return "BUILD";
}

function sessionTitle(row: SessionRow, taskType: DeskTaskType): string {
  if (row.storyTitle) return row.storyTitle;
  if (row.epicTitle) return row.epicTitle;
  switch (taskType) {
    case "RELEASE":
      return "Generating release notes";
    case "MEMORY":
      return "Distilling project memory";
    case "REFINEMENT":
      return "Refining the board";
    case "GRADING":
      return "Grading acceptance criteria";
    case "QA":
      return "Running checks";
    case "MERGE":
      return "Merging";
    case "REVIEW":
      return "Reviewing";
    default:
      return "Building";
  }
}

/**
 * The last streamed line, already clipped.
 *
 * `agent_sessions.last_non_empty_text` is UNCAPPED at the write side — a CLI
 * that emits one 4 MB line stores 4 MB — so the route selects
 * `substr(..., 1, 200)`. This only trims whitespace and refuses an empty
 * string; it is not the place the cap is enforced.
 */
export function normalizeLogLine(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const flat = value.replace(/\s+/g, " ").trim();
  if (flat.length === 0) return null;
  return flat.length > LOG_LINE_LIMIT ? `${flat.slice(0, LOG_LINE_LIMIT - 1)}…` : flat;
}

export function deriveWorking(rows: readonly SessionRow[]): DeskWorkingSession[] {
  return rows
    .filter((row) => row.status === "running")
    .map((row) => {
      const taskType = inferTaskType(row);
      return {
        sessionId: row.id,
        projectId: row.projectId,
        epicId: row.epicId,
        readableId: row.epicReadableId,
        title: sessionTitle(row, taskType),
        taskType,
        agentName: row.namedAgentName ?? null,
        startedAt: row.startedAt || row.createdAt || new Date().toISOString(),
        lastLogLine: normalizeLogLine(row.lastLogLine),
        nightRun: Boolean(row.batchRunId),
        stale: row.stale === true,
      };
    })
    .sort((a, b) => (a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : 0));
}

export function deriveQueued(rows: readonly SessionRow[]): DeskQueuedSession[] {
  return rows
    .filter((row) => row.status === "queued")
    .map((row) => ({
      sessionId: row.id,
      projectId: row.projectId,
      epicId: row.epicId,
      readableId: row.epicReadableId,
      title: sessionTitle(row, inferTaskType(row)),
    }));
}

/* ------------------------------------------------------------------ */
/* TODAY                                                               */
/* ------------------------------------------------------------------ */

export interface TodayCounts {
  ticketsShipped?: number | null;
  failedSessions?: number | null;
  costUsd?: number | null;
  projects?: number | null;
  sessions?: number | null;
}

/**
 * A count is a real number or nothing. `COUNT(*)` always answers, so those pass
 * through; `SUM(total_cost_usd)` answers NULL when no session in range reported
 * a cost, and that NULL must survive all the way to the em-dash.
 */
export function deriveToday(counts: TodayCounts): DeskToday {
  const num = (value: number | null | undefined): number | null =>
    typeof value === "number" && Number.isFinite(value) ? value : null;
  return {
    ticketsShipped: num(counts.ticketsShipped),
    failedSessions: num(counts.failedSessions),
    costUsd: num(counts.costUsd),
    projects: num(counts.projects),
    sessions: num(counts.sessions),
  };
}

/* ------------------------------------------------------------------ */
/* YOUR TURN                                                           */
/* ------------------------------------------------------------------ */

export interface EpicRow {
  id: string;
  projectId: string;
  title: string;
  readableId: string | null;
  status: string | null;
  position: number | null;
  priority: number | null;
  type: string | null;
  branchName: string | null;
  prNumber: number | null;
  usCount: number;
  usDone: number;
  latestCommentId: string | null;
  latestCommentAuthor: string | null;
  latestCommentContent: string | null;
  latestCommentCreatedAt: string | null;
  latestSessionOutcome: string | null;
  latestSessionEndedAt: string | null;
  latestUserCommentCreatedAt: string | null;
  lastReadAt: string | null;
  openFindings: number | null;
  lastCleanReviewAt: string | null;
  lastTerminalCodeAt: string | null;
  lastNegativeVerdictReviewAt: string | null;
  supersessionAt: string | null;
  lastMergeConflictAt: string | null;
  lastConflictMarkersAt: string | null;
}

/** Max characters of an agent question the desk quotes on a row. */
const QUESTION_LENGTH = 200;

export function excerpt(content: string | null | undefined, limit = QUESTION_LENGTH): string | null {
  if (!content) return null;
  const flat = content.replace(/\s+/g, " ").trim();
  if (flat.length === 0) return null;
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1).trimEnd()}…`;
}

/**
 * ASKS YOU rows.
 *
 * `isAwaitingReply` is the same predicate `/api/inbox`, the board card and the
 * Full Auto selector evaluate — an epic whose latest session ended
 * `asked_question` with no user comment since. The unread-AI flag rides along
 * so the header's inbox badge and the row agree.
 */
export function deriveAwaitingReply(epics: readonly EpicRow[]): DeskAwaitingReply[] {
  return epics
    .filter((epic) => isAwaitingReply(epic))
    .map((epic) => ({
      epicId: epic.id,
      projectId: epic.projectId,
      readableId: epic.readableId,
      title: epic.title,
      question: excerpt(epic.latestCommentContent),
      author: epic.latestCommentAuthor,
      askedAt: epic.latestSessionEndedAt,
      unreadAi: hasUnreadAiComment(epic),
    }))
    .sort((a, b) => (b.askedAt ?? "").localeCompare(a.askedAt ?? ""));
}

/** Epics whose latest comment is agent-authored and newer than the cursor. */
export function countUnreadAi(epics: readonly EpicRow[]): number {
  return epics.filter((epic) => hasUnreadAiComment(epic)).length;
}

export interface FailureSessionRow extends FailureCandidateSession {
  projectId: string;
  namedAgentName?: string | null;
}

/**
 * FAILED rows.
 *
 * `selectLatestFailures` owns the "latest session wins" rule INCLUDING its
 * same-second tie-break, which is what makes a retry created in the same second
 * as the failure clear the badge instead of leaving a stale failure on the desk
 * forever. Reproducing that comparison here would be the bug.
 */
export function deriveFailures(
  sessions: readonly FailureSessionRow[],
  epicsById: ReadonlyMap<string, EpicRow>,
  runningEpicIds: ReadonlySet<string>,
): DeskFailure[] {
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const latest = selectLatestFailures([...sessions], new Set(runningEpicIds));

  const rows: DeskFailure[] = [];
  for (const [epicId, info] of Object.entries(latest)) {
    const epic = epicsById.get(epicId);
    if (!epic) continue;
    const session = byId.get(info.sessionId);
    rows.push({
      epicId,
      projectId: epic.projectId,
      readableId: epic.readableId,
      title: epic.title,
      sessionId: info.sessionId,
      error: info.error,
      agentType: info.agentType,
      agentName: session?.namedAgentName ?? null,
      provider: info.provider ?? null,
      namedAgentId: info.namedAgentId ?? null,
      userStoryId: info.userStoryId ?? null,
      producedOutput: info.producedOutput === true,
      failedAt: session?.endedAt ?? session?.createdAt ?? null,
    });
  }
  return rows.sort((a, b) => (b.failedAt ?? "").localeCompare(a.failedAt ?? ""));
}

/**
 * CONFLICT rows.
 *
 * Reconstructed from the merge-readiness blocker rather than from the raw
 * activity log: `evaluateMergeReadiness` already decides which of the two
 * conflict flavours is current (a merge-fix session clears them by touching the
 * branch), and which one outranks the other when both are recorded.
 */
export function deriveConflicts(epics: readonly EpicRow[]): DeskConflict[] {
  const rows: DeskConflict[] = [];
  for (const epic of epics) {
    const readiness = evaluateMergeReadiness(mergeFactsOf(epic));
    if (readiness.blocker !== "merge_conflict" && readiness.blocker !== "conflict_markers") {
      continue;
    }
    rows.push({
      epicId: epic.id,
      projectId: epic.projectId,
      readableId: epic.readableId,
      title: epic.title,
      blocker: readiness.blocker,
      branchName: epic.branchName,
      at:
        readiness.blocker === "conflict_markers"
          ? epic.lastConflictMarkersAt
          : epic.lastMergeConflictAt,
    });
  }
  return rows.sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""));
}

function mergeFactsOf(epic: EpicRow): MergeReadinessFacts {
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
/* READY TO LAND                                                       */
/* ------------------------------------------------------------------ */

export interface ReadyToLand {
  rows: DeskLandRow[];
  /** `to_merge` tickets a blocker holds back — the band's footer count. */
  heldBackCount: number;
}

/**
 * READY TO LAND is a DISPLAY-ONLY slice of `to_merge`.
 *
 * It never writes a position: `epics.position` is Full Auto's execution-order
 * contract (lib/kanban/reorder.ts), and a display order written back into it
 * would silently re-order the supervisor's queue.
 *
 * Ordering mirrors `sortMergeColumn`: ready first, then board position.
 */
export function deriveReadyToLand(
  epics: readonly EpicRow[],
  busyEpicIds: ReadonlySet<string>,
): ReadyToLand {
  const rows: DeskLandRow[] = [];
  let heldBackCount = 0;

  for (const epic of epics) {
    if (epic.status !== "to_merge") continue;
    const readiness = evaluateMergeReadiness(mergeFactsOf(epic));
    if (!readiness.ready) {
      heldBackCount += 1;
      continue;
    }
    rows.push({
      epicId: epic.id,
      projectId: epic.projectId,
      readableId: epic.readableId,
      title: epic.title,
      prNumber: epic.prNumber,
      usDone: epic.usDone,
      usCount: epic.usCount,
      openFindings: readiness.openFindings,
      // Any session that owns the ticket — queued included — withholds the
      // button: merging removes the worktree a queued build would land in.
      agentBusy: busyEpicIds.has(epic.id),
    });
  }

  rows.sort((a, b) => {
    const byProject = a.projectId.localeCompare(b.projectId);
    if (byProject !== 0) return byProject;
    return (a.readableId ?? a.epicId).localeCompare(b.readableId ?? b.epicId);
  });

  return { rows, heldBackCount };
}

/* ------------------------------------------------------------------ */
/* UP NEXT                                                             */
/* ------------------------------------------------------------------ */

/**
 * The order Full Auto will pick from, per project.
 *
 * This is not "the To Do column in position order": it is the very order
 * `selectBuildCandidates` walks — `compareExecutionOrder` (In Progress before
 * To Do, then position, then id) over the two buildable statuses, minus the
 * tickets `isEpicSelectable` and the dependency gate would skip. The board's
 * old queue numbering deliberately disagreed with the supervisor on both
 * counts; the desk's column claims to BE that order, so it has to earn it.
 *
 * What the desk still cannot see are the in-process registry exclusions
 * (parked tickets, pipeline/night-run ownership, merge backoff): they live in
 * `lib/auto-mode/registry.ts`, are lost on restart and no API exposes them.
 * A ticket the registry has parked therefore still shows a rank here.
 *
 * Dependency edges never cross projects (`CrossProjectError`), so per-project
 * edge sets union safely and there is no global graph and no global cycle check.
 */
export const UP_NEXT_STATUSES: ReadonlySet<string> = new Set(["in_progress", "todo"]);

export interface UpNextInput {
  epics: readonly EpicRow[];
  edges: readonly TicketDependencyEdge[];
  /** Every epic id → label, for resolving blocked-on across the whole project. */
  labelById: ReadonlyMap<string, string>;
  /** Statuses of every epic in the project, for the dependency walk. */
  statusById: ReadonlyMap<string, string>;
  busyEpicIds: ReadonlySet<string>;
}

export function deriveUpNextForProject(input: UpNextInput): DeskQueueTicket[] {
  const blockedBy = computeBlockedBy(input.edges, input.statusById);

  const candidates: (Omit<EpicRow, "status" | "position"> & ExecutionOrderEpic & {
    status: string;
    position: number;
  })[] = input.epics
    .filter((epic) => UP_NEXT_STATUSES.has(epic.status ?? ""))
    .filter((epic) => !isDeliveredStatus(epic.status))
    .map((epic) => ({ ...epic, status: epic.status ?? "", position: epic.position ?? 0 }))
    .sort(compareExecutionOrder);

  const ranks = computeQueueRanks(
    candidates.map((epic) => ({ ...epic, id: epic.id })),
    (epic) =>
      blockedBy.has(epic.id) ||
      isAwaitingReply(epic as unknown as EpicRow) ||
      input.busyEpicIds.has(epic.id),
  );

  return candidates.map((epic) => ({
    epicId: epic.id,
    projectId: epic.projectId,
    readableId: epic.readableId,
    title: epic.title,
    status: epic.status,
    rank: ranks.get(epic.id) ?? null,
    blockedBy: (blockedBy.get(epic.id) ?? []).map(
      (targetId) => input.labelById.get(targetId) ?? targetId,
    ),
    awaitingReply: isAwaitingReply(epic as unknown as EpicRow),
    specOnly: (epic.type ?? "feature") !== "bug" && epic.usCount === 0,
    storyCount: epic.usCount,
  }));
}

export function deriveUpNext(
  projects: readonly DeskProject[],
  epics: readonly EpicRow[],
  edges: readonly TicketDependencyEdge[],
  busyEpicIds: ReadonlySet<string>,
): DeskUpNextProject[] {
  const byProject = new Map<string, EpicRow[]>();
  for (const epic of epics) {
    const list = byProject.get(epic.projectId);
    if (list) list.push(epic);
    else byProject.set(epic.projectId, [epic]);
  }

  const edgesByProject = new Map<string, TicketDependencyEdge[]>();
  const projectOfEpic = new Map(epics.map((epic) => [epic.id, epic.projectId]));
  for (const edge of edges) {
    const projectId = projectOfEpic.get(edge.ticketId);
    if (!projectId) continue;
    const list = edgesByProject.get(projectId);
    if (list) list.push(edge);
    else edgesByProject.set(projectId, [edge]);
  }

  return projects.map((project) => {
    const projectEpics = byProject.get(project.id) ?? [];
    const labelById = new Map<string, string>();
    const statusById = new Map<string, string>();
    for (const epic of projectEpics) {
      labelById.set(epic.id, epic.readableId || epic.title || epic.id);
      statusById.set(epic.id, epic.status ?? "");
    }
    return {
      projectId: project.id,
      tickets: deriveUpNextForProject({
        epics: projectEpics,
        edges: edgesByProject.get(project.id) ?? [],
        labelById,
        statusById,
        busyEpicIds,
      }),
    };
  });
}
