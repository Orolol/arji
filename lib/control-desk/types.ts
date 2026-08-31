/**
 * The payload of `GET /api/control-desk` — the one read the "Now" desk makes.
 *
 * The desk supervises every project at once, so every field here is
 * cross-project by construction. Nothing in this module touches the database;
 * it is the contract shared by `lib/control-desk/aggregate.ts` (which derives
 * it), the route (which feeds that derivation), and `hooks/useControlDesk.ts`
 * (which consumes it).
 *
 * DATA-GAP RULE, everywhere in here: a figure that does not exist is `null`,
 * never `0`. The desk renders `null` as an em-dash (see `StatNumeral`), and a
 * zero would be a lie the rest of the app does not tell.
 */

/** How far back the cross-project scans reach. See the route for why. */
export const CONTROL_DESK_LOOKBACK_DAYS = 14;

/** Max characters of `agent_sessions.last_non_empty_text` the desk ever ships. */
export const LOG_LINE_LIMIT = 200;

export interface DeskProject {
  id: string;
  name: string;
  /**
   * Mono rail/label form ("ARIJ", "LEDGER"). Derived from the project name —
   * there is no stored short name, and the ticket prefix is a slug of the same
   * name, so deriving twice would only add a second answer.
   */
  shortName: string;
  /**
   * Position in the fixed 4-colour project cycle. There is no `color_index`
   * column, so this is derived from creation order — the fallback the handoff
   * names explicitly. Feed it to `projectTone()`.
   */
  colorIndex: number;
  /** Sessions currently `running` on this project. */
  activeAgents: number;
  /** Full Auto is per-project; this is that project's switch. */
  autoModeEnabled: boolean;
}

/** The dispatch role of a live session, as the card prints it. */
export type DeskTaskType =
  | "BUILD"
  | "REVIEW"
  | "MERGE"
  | "GRADING"
  | "QA"
  | "MEMORY"
  | "RELEASE"
  | "REFINEMENT"
  | "CHAT";

export interface DeskWorkingSession {
  sessionId: string;
  projectId: string;
  epicId: string | null;
  readableId: string | null;
  /** Epic or story title; falls back to the derived activity label. */
  title: string;
  taskType: DeskTaskType;
  agentName: string | null;
  /** ISO/SQLite timestamp the chrono counts from. */
  startedAt: string;
  /** `substr(last_non_empty_text, 1, 200)` — never the raw column. */
  lastLogLine: string | null;
  /** The session was dispatched by a night run (`agent_sessions.batch_run_id`). */
  nightRun: boolean;
  /** Watchdog verdict, same predicate the monitor uses. */
  stale: boolean;
}

export interface DeskQueuedSession {
  sessionId: string;
  projectId: string;
  epicId: string | null;
  readableId: string | null;
  title: string;
}

export interface DeskToday {
  /** `ticket_activity_log` transitions into done/released since 00:00 UTC. */
  ticketsShipped: number | null;
  /** Sessions that reached `failed` today. */
  failedSessions: number | null;
  /** SUM(total_cost_usd) over today's sessions; null when nothing reported one. */
  costUsd: number | null;
  /** Distinct projects that ran a session today. */
  projects: number | null;
  /** Sessions created today. */
  sessions: number | null;
}

export interface DeskAwaitingReply {
  epicId: string;
  projectId: string;
  readableId: string | null;
  title: string;
  /** The agent's last comment, flattened and clipped. */
  question: string | null;
  author: string | null;
  askedAt: string | null;
  /** The epic's latest comment is agent-authored and past the read cursor. */
  unreadAi: boolean;
}

export interface DeskFailure {
  epicId: string;
  projectId: string;
  readableId: string | null;
  title: string;
  sessionId: string;
  error: string;
  agentType: string;
  agentName: string | null;
  provider: string | null;
  namedAgentId: string | null;
  userStoryId: string | null;
  producedOutput: boolean;
  failedAt: string | null;
}

export interface DeskConflict {
  epicId: string;
  projectId: string;
  readableId: string | null;
  title: string;
  /**
   * `merge_conflict` keeps "Resolve with agent"; `conflict_markers` never
   * does — an agent merging main would find a clean merge and leave the
   * committed markers untouched (lib/workflow/merge-failure.ts).
   */
  blocker: "merge_conflict" | "conflict_markers";
  /**
   * The branch that cannot land. The frame draws a conflicting FILE LIST here;
   * nothing durable records one (the activity-log reason is free prose), so
   * the desk names the branch instead of inventing files.
   */
  branchName: string | null;
  at: string | null;
}

export interface DeskLandRow {
  epicId: string;
  projectId: string;
  readableId: string | null;
  title: string;
  /** Optional in the frame too — the second land row has no PR. */
  prNumber: number | null;
  usDone: number;
  usCount: number;
  openFindings: number;
  /** A session owns this ticket, so the Land button is withheld. */
  agentBusy: boolean;
}

export interface DeskQueueTicket {
  epicId: string;
  projectId: string;
  readableId: string | null;
  title: string;
  status: string;
  /**
   * Execution rank (1 = the next one Full Auto picks). `null` for a ticket the
   * supervisor would skip today: blocked by a dependency, or awaiting a reply.
   */
  rank: number | null;
  /** Resolved labels of the unmet prerequisites (readableId || title || id). */
  blockedBy: string[];
  awaitingReply: boolean;
  /** Feature epic with no story yet — the frame's "spec" chip. */
  specOnly: boolean;
  storyCount: number;
}

export interface DeskUpNextProject {
  projectId: string;
  tickets: DeskQueueTicket[];
}

export interface ControlDeskPayload {
  generatedAt: string;
  projects: DeskProject[];
  working: DeskWorkingSession[];
  queued: DeskQueuedSession[];
  today: DeskToday;
  yourTurn: {
    awaitingReply: DeskAwaitingReply[];
    failed: DeskFailure[];
    conflicts: DeskConflict[];
  };
  readyToLand: DeskLandRow[];
  /** Tickets in `to_merge` that a blocker keeps out of `readyToLand`. */
  heldBackCount: number;
  upNext: DeskUpNextProject[];
  /**
   * Badge count for the Inbox tile — epics with an unread agent comment,
   * counted BEFORE `applyDeskDismissals`.
   *
   * Deliberately not `yourTurn.awaitingReply.length`. Dismissing a coral row
   * hides it from this desk only; `/inbox` is a different surface and applies
   * no such filter. Deriving the badge from the filtered rows made it read "2"
   * while the page it links to still listed 3.
   */
  inboxUnread: number;
}
