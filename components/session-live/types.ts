/**
 * The client-side view model of the live-session screen.
 *
 * `SessionDetail` mirrors, field for field, what
 * `GET /api/projects/:projectId/sessions/:sessionId` returns — every
 * `agent_sessions` column EXCEPT `prompt`, plus the derived extras the route
 * computes (`status`, `cliSessionId`, `logs`, `chunkStreams`, `arijActions`
 * and the three explicit failure flags). The prompt is served only on
 * `?include=prompt` because it reaches 1.8 MB per row on the live database,
 * so it is optional here and arrives through its own lazy request.
 *
 * `SessionFilesResponse` mirrors the new read-only sibling route
 * `GET /api/projects/:projectId/sessions/:sessionId/files`.
 */
import type { ArijActionItem } from "@/components/shared/ArijActionsList";
import type { SessionStreamSeed } from "@/components/sessions/SessionOutputStream";
import type { AgentSessionStreamType } from "@/lib/agent-sessions/chunks";

export interface SessionDetail {
  id: string;
  status: string;
  mode: string;
  provider?: string;
  prompt?: string;
  error?: string;
  branchName?: string;
  worktreePath?: string;
  epicId?: string;
  startedAt?: string;
  endedAt?: string;
  completedAt?: string;
  createdAt: string;
  lastNonEmptyText?: string | null;
  cliSessionId?: string | null;
  agentType?: string | null;
  outcome?: string | null;
  namedAgentName?: string | null;
  model?: string | null;
  /** JSON object of the per-CLI options in effect for this run. */
  cliOptions?: string | null;
  cliCommand?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  totalCostUsd?: number | null;
  estimatedPromptTokens?: number | null;
  estimatedPromptBreakdown?: string | null;
  arijActions?: ArijActionItem[] | null;
  logs?: {
    success?: boolean;
    result?: string;
    error?: string;
    duration?: number;
  } | null;
  /** Bounded first page of each stream; the rest is paged in on demand. */
  chunkStreams?: Partial<Record<AgentSessionStreamType, SessionStreamSeed>> | null;
  /** The chunk read failed — distinct from a session that wrote nothing. */
  chunkStreamsUnavailable?: boolean;
  /** `logs.json` was too large to serve whole, or its result was capped. */
  logsTruncated?: boolean;
  /** `logs.json` exists but could not be read or parsed. */
  logsUnavailable?: boolean;
}

/** The epic this session was dispatched against, as the header renders it. */
export interface SessionFilesTicket {
  id: string;
  readableId: string | null;
  title: string;
}

/** Just enough of the project row for the identity chip. */
export interface SessionFilesProject {
  id: string;
  name: string;
}

/** Why the diff could not be produced. Never a thrown 500 — see the route. */
export type SessionDiffUnavailableReason =
  | "no-worktree"
  | "worktree-missing"
  | "not-a-repo"
  | "git-failed";

/**
 * One changed file. `added`/`removed` are `null` for a binary file, where
 * `git diff --numstat` writes `-` rather than a count — `DiffDelta` then
 * renders nothing rather than a false `+0 −0`.
 */
export interface SessionDiffFile {
  path: string;
  added: number | null;
  removed: number | null;
  /** Present in the staged/unstaged numstat: the agent is still writing it. */
  inProgress: boolean;
}

export interface SessionDiffTotals {
  files: number;
  added: number;
  removed: number;
}

export interface SessionDiff {
  available: boolean;
  reason?: SessionDiffUnavailableReason;
  branchName: string | null;
  baseBranch: string | null;
  mergeBase: string | null;
  behind: number | null;
  ahead: number | null;
  files: SessionDiffFile[];
  /** Computed over ALL rows, even when `files` was capped. */
  totals: SessionDiffTotals | null;
  /** `files` was cut at the row cap; `totals` still covers everything. */
  truncated: boolean;
}

export interface SessionFilesResponse {
  sessionId: string;
  ticket: SessionFilesTicket | null;
  project: SessionFilesProject | null;
  diff: SessionDiff;
}
