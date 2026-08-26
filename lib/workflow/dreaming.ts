/**
 * Dreaming — cross-session distillation of the project memory.
 *
 * `memory_distill` (lib/workflow/memory-distill.ts) is a per-session pass: one
 * build finishes, one agent folds what it taught into the memory document.
 * Dreaming is the transversal pass: it reads the last N TERMINAL sessions
 * across MANY tickets — successes and failures — and rewrites the memory
 * around what no single session can show (recurring agent mistakes, traps the
 * codebase keeps setting, strategies that actually land).
 *
 * Shape (deliberately the same as the distill and the spec auto-rewrite, so
 * all three read alike):
 *   collector → guard matrix → queued 'dreaming' session → per-project
 *   scheduler closure → guarded memory replacement.
 *
 * Notable choices, all load-bearing:
 *   - the digest NEVER embeds a session's raw CLI stream. What it reads is the
 *     TAIL of the final response (the `response`/`output` chunks, not `raw`),
 *     plus the signals that carry a lesson — each capped, and the whole thing
 *     cut to DREAM_DIGEST_MAX_CHARS by a fair (water-filling) allocation so one
 *     verbose session cannot starve the rest — see lib/workflow/dreaming-digest.ts;
 *   - NO epicId on the session row (same trick as lib/pipeline/forensic.ts):
 *     a background project-level pass must never occupy an epic's concurrency
 *     slot, so it can never block a ticket;
 *   - batchRunId IS inherited when a night run triggers the dream, because the
 *     night cost cap and the morning summary query `agent_sessions.batch_run_id`
 *     and nothing else — the tag alone is the entire integration (same pitfall
 *     documented on memory-distill);
 *   - the memory is replaced ONLY when the session actually delivers
 *     (`outcome === 'answered'` with non-empty output) AND the text that would
 *     be stored still carries the four imposed sections — a cap-truncated or
 *     unstructured document is refused rather than saved. The previous memory is
 *     snapshotted in the SAME transaction (documents row, kind
 *     'memory_archive'), so a failed save can never burn the snapshot — and
 *     only when the stored memory is still the one the dream reasoned from, so
 *     a human edit made mid-dream is never silently overwritten.
 */

import fs from "fs";
import path from "path";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  agentSessions,
  epics,
  projects,
  reviewComments,
  settings,
  ticketComments,
  userStories,
} from "@/lib/db/schema";
import { createId } from "@/lib/utils/nanoid";
import { agentScheduler } from "@/lib/agents/scheduler";
import { processManager } from "@/lib/claude/process-manager";
import { waitForProcessCompletion } from "@/lib/agent-sessions/wait-for-completion";
import {
  createQueuedSession,
  isSessionLifecycleConflictError,
  markSessionRunning,
  markSessionTerminal,
} from "@/lib/agent-sessions/lifecycle";
import {
  classifySessionOutcome,
  extractSessionUsage,
  resolveSessionOutput,
} from "@/lib/claude/resolve-session-output";
import { extractLastNonEmptyTextFromFile } from "@/lib/agent-sessions/last-text";
import { buildDreamingPrompt } from "@/lib/claude/prompt-builder";
import { resolveAgentPrompt } from "@/lib/agent-config/prompts";
import { resolveAgentByNamedId } from "@/lib/agent-config/agent-resolution";
import { providerAcceptsAssignedSessionId } from "@/lib/agent-sessions/resume-capability";
// Single source of truth for the heading the pipeline files diagnostics under,
// and for the dead-session marker it stamps into them.
import {
  FORENSIC_COMMENT_HEADING,
  parseForensicDeadSessionId,
  readChunkTail,
} from "@/lib/pipeline/forensic";
import {
  enforceMemoryCap,
  getProjectMemoryContent,
  isProjectMemoryChangedError,
  replaceProjectMemoryWithSnapshot,
} from "@/lib/documents/memory";
import { createMemoryDreamedNotification } from "@/lib/notifications/create";
import { recordMemoryWriteProvenance } from "@/lib/documents/memory-provenance";
import { eventBus } from "@/lib/events/bus";
// Client-safe constants module (no db import) — no cycle back into the engine.
import { NIGHT_STOPPED_ABORT_REASON } from "@/lib/night/constants";
import {
  DREAMING_AFTER_NIGHT_RUN_SETTING_KEY,
  DREAMING_AGENT_TYPE,
  DREAMING_LOG_PREFIX,
  DREAM_DIGEST_MAX_CHARS,
  DREAM_FINAL_TEXT_SOURCE_MAX_CHARS,
  DREAM_FORENSIC_ATTACH_SLACK_MS,
  DREAM_MAX_SESSIONS,
  DREAM_SOURCE_AGENT_TYPES,
  DREAM_WINDOW_DAYS,
  dreamingAfterNightRunSettingKey,
  dreamingLastCutoffSettingKey,
  parseDreamingAfterNightRunSetting,
} from "./dreaming-constants";
import { hasPendingMemoryWriter } from "./memory-writer-lock";
import {
  assembleDreamDigest,
  extractReviewVerdict,
  parseTimestampMs,
  resolveDreamWindow,
  validateDreamedMemoryStructure,
  type AssembledDreamDigest,
  type DreamSessionDigest,
} from "./dreaming-digest";

const POLL_INTERVAL_MS = 2000;

/** Statuses a session must have reached to be dreamable evidence. */
const TERMINAL_SESSION_STATUSES: readonly string[] = ["completed", "failed"];

// ---------------------------------------------------------------------------
// Collector
// ---------------------------------------------------------------------------

export interface CollectDreamDigestOptions {
  /** Clock injection point (tests, and only tests, pass this). */
  now?: Date;
  maxSessions?: number;
  windowDays?: number;
  maxChars?: number;
}

export interface DreamDigestResult extends AssembledDreamDigest {
  /** Inclusive lower bound of the collection window (terminal time). */
  sinceIso: string;
  /**
   * The moment this collection happened — what `recordDreamCutoff` persists
   * once the dream has actually rewritten the memory, and therefore where the
   * NEXT window opens. Deliberately the collection instant and not the dream's
   * end: a session that reaches a terminal state while the dream is still
   * running was not in this digest and must stay readable by the next one.
   */
  collectedAtIso: string;
  /** Cutoff this window follows, or null for a first dream. */
  lastCutoffAt: string | null;
  /** Candidates inside the window before the session-count cap. */
  candidateCount: number;
  /** Per-session records that were rendered (chronological order). */
  sessions: DreamSessionDigest[];
}

/**
 * Where the project's next dream window opens: the collection cutoff of the
 * last dream that actually REPLACED the memory document.
 *
 * Read from a settings row rather than derived from dream sessions on purpose.
 * A session row can only say "this dream finished and answered", which is a
 * strictly worse question on two counts: it moves the window past sessions
 * that ended while the dream was running, and it counts a dream whose memory
 * write threw as if it had landed. The cutoff row is written at exactly one
 * place — after a successful save — so its presence means the evidence up to
 * that instant really is inside the stored memory.
 */
export function findLastDreamCutoff(projectId: string): string | null {
  const raw = readSettingValue(dreamingLastCutoffSettingKey(projectId));
  if (!raw) return null;
  // The settings PATCH route JSON-encodes values; a hand-written row may be
  // raw. Accept both, reject anything undateable.
  let value: unknown = raw;
  try {
    value = JSON.parse(raw);
  } catch {
    // raw (non-JSON) string — use as-is
  }
  if (typeof value !== "string") return null;
  return parseTimestampMs(value) === null ? null : value;
}

/**
 * Persists the collection cutoff. Called ONLY after the dreamed memory was
 * successfully stored — see the guard rails in `dispatchDreamingSession`.
 */
export function recordDreamCutoff(projectId: string, cutoffIso: string): void {
  const key = dreamingLastCutoffSettingKey(projectId);
  const value = JSON.stringify(cutoffIso);
  const now = new Date().toISOString();
  const existing = db
    .select({ key: settings.key })
    .from(settings)
    .where(eq(settings.key, key))
    .get();
  if (existing) {
    db.update(settings)
      .set({ value, updatedAt: now })
      .where(eq(settings.key, key))
      .run();
    return;
  }
  db.insert(settings).values({ key, value, updatedAt: now }).run();
}

interface DreamCandidateRow {
  id: string;
  epicId: string | null;
  userStoryId: string | null;
  agentType: string | null;
  provider: string | null;
  model: string | null;
  status: string | null;
  outcome: string | null;
  error: string | null;
  lastNonEmptyText: string | null;
  logsPath: string | null;
  createdAt: string | null;
  startedAt: string | null;
  endedAt: string | null;
  completedAt: string | null;
  totalCostUsd: number | null;
}

/** When the run began: its start, else when it was queued. */
function sessionAt(row: DreamCandidateRow): string | null {
  return row.startedAt ?? row.createdAt;
}

/**
 * When the run BECAME EVIDENCE — the moment it reached a terminal state.
 *
 * This, not the start, is what places a session in a dream's window: a build
 * that started before the previous dream and ended after it was never in that
 * digest, and keying on `startedAt` would hide it from every dream that
 * follows. Falls back to the start only for legacy rows with no terminal
 * timestamp at all.
 */
function sessionTerminalMs(row: DreamCandidateRow): number | null {
  return (
    parseTimestampMs(row.endedAt) ??
    parseTimestampMs(row.completedAt) ??
    parseTimestampMs(sessionAt(row))
  );
}

/**
 * Terminal source sessions of the project inside the window, newest first,
 * capped at `maxSessions`.
 *
 * "Inside the window" means the session REACHED a terminal state at/after
 * `sinceIso` — see `sessionTerminalMs`.
 *
 * Timestamps are compared with Date.parse in JS rather than in SQL because
 * `created_at` mixes explicit ISO strings with SQLite CURRENT_TIMESTAMP
 * defaults — the same reason lib/pipeline/findings.ts filters in JS. The SQL
 * side still narrows on project, agent type and status, so the scan stays
 * small.
 */
export function selectDreamCandidates(
  projectId: string,
  sinceIso: string,
  maxSessions: number = DREAM_MAX_SESSIONS
): { rows: DreamCandidateRow[]; candidateCount: number } {
  const sinceMs = parseTimestampMs(sinceIso);
  const rows = db
    .select({
      id: agentSessions.id,
      epicId: agentSessions.epicId,
      userStoryId: agentSessions.userStoryId,
      agentType: agentSessions.agentType,
      provider: agentSessions.provider,
      model: agentSessions.model,
      status: agentSessions.status,
      outcome: agentSessions.outcome,
      error: agentSessions.error,
      lastNonEmptyText: agentSessions.lastNonEmptyText,
      logsPath: agentSessions.logsPath,
      createdAt: agentSessions.createdAt,
      startedAt: agentSessions.startedAt,
      endedAt: agentSessions.endedAt,
      completedAt: agentSessions.completedAt,
      totalCostUsd: agentSessions.totalCostUsd,
    })
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.projectId, projectId),
        inArray(agentSessions.agentType, [...DREAM_SOURCE_AGENT_TYPES]),
        inArray(agentSessions.status, [...TERMINAL_SESSION_STATUSES])
      )
    )
    .all();

  const inWindow = rows.filter((row) => {
    const ms = sessionTerminalMs(row);
    // A session we cannot date cannot be placed in the window — leaving it out
    // is the choice that keeps consecutive dreams from re-reading it forever.
    if (ms === null) return false;
    return sinceMs === null || ms >= sinceMs;
  });

  // Newest-terminal first, so the count cap keeps the freshest evidence.
  inWindow.sort(
    (a, b) => (sessionTerminalMs(b) ?? 0) - (sessionTerminalMs(a) ?? 0)
  );

  return {
    rows: inWindow.slice(0, Math.max(0, maxSessions)),
    candidateCount: inWindow.length,
  };
}

/** "E-proj-003: Login flow — Story title" for the digest heading. */
function loadTicketLabels(
  epicIds: string[],
  storyIds: string[]
): { epics: Map<string, string>; stories: Map<string, string> } {
  const epicLabels = new Map<string, string>();
  const storyLabels = new Map<string, string>();

  if (epicIds.length > 0) {
    for (const row of db
      .select({
        id: epics.id,
        title: epics.title,
        readableId: epics.readableId,
      })
      .from(epics)
      .where(inArray(epics.id, epicIds))
      .all()) {
      epicLabels.set(
        row.id,
        row.readableId ? `${row.readableId}: ${row.title}` : row.title
      );
    }
  }

  if (storyIds.length > 0) {
    for (const row of db
      .select({ id: userStories.id, title: userStories.title })
      .from(userStories)
      .where(inArray(userStories.id, storyIds))
      .all()) {
      storyLabels.set(row.id, row.title);
    }
  }

  return { epics: epicLabels, stories: storyLabels };
}

interface DatedRow {
  id: string;
  body: string;
  createdMs: number | null;
  /** Story the row was filed against; null for epic-scoped rows. */
  userStoryId?: string | null;
  /** Session the row explicitly names as its subject (forensic comments). */
  deadSessionId?: string | null;
  /** Session that FILED the row (review findings, since migration 0032). */
  agentSessionId?: string | null;
}

/**
 * Agent-authored `[critical]`/`[major]` findings per epic.
 *
 * Two differences from the pipeline's blocking assessment
 * (lib/pipeline/findings.ts):
 *   - RESOLVED rows are kept: a finding that was fixed still records a mistake
 *     the agents made, which is exactly what a dream is looking for;
 *   - `agentSessionId` comes along. Since migration 0032 the MCP
 *     submit_findings route records which review session filed each row, so a
 *     finding can be attributed EXACTLY. Two reviewers running on the same epic
 *     at once used to be indistinguishable by timestamp, and each would be
 *     handed the other's findings.
 */
function loadBlockingFindingsByEpic(epicIds: string[]): Map<string, DatedRow[]> {
  const byEpic = new Map<string, DatedRow[]>();
  if (epicIds.length === 0) return byEpic;

  for (const row of db
    .select({
      id: reviewComments.id,
      epicId: reviewComments.epicId,
      body: reviewComments.body,
      createdAt: reviewComments.createdAt,
      agentSessionId: reviewComments.agentSessionId,
    })
    .from(reviewComments)
    .where(
      and(
        inArray(reviewComments.epicId, epicIds),
        eq(reviewComments.author, "agent")
      )
    )
    .all()) {
    const body = row.body.trim();
    if (!/^\[(critical|major)\]/i.test(body)) continue;
    const list = byEpic.get(row.epicId) ?? [];
    list.push({
      id: row.id,
      body,
      createdMs: parseTimestampMs(row.createdAt),
      agentSessionId: row.agentSessionId ?? null,
    });
    byEpic.set(row.epicId, list);
  }
  return byEpic;
}

/**
 * Forensic diagnostic comments per epic (lib/pipeline/forensic.ts files them).
 *
 * `userStoryId` comes along because an epic can carry several story-scoped
 * runs at once: the post-mortem of story A must not be pinned onto the session
 * that built story B just because their run windows overlap.
 */
function loadForensicCommentsByEpic(epicIds: string[]): Map<string, DatedRow[]> {
  const byEpic = new Map<string, DatedRow[]>();
  if (epicIds.length === 0) return byEpic;

  for (const row of db
    .select({
      id: ticketComments.id,
      epicId: ticketComments.epicId,
      userStoryId: ticketComments.userStoryId,
      content: ticketComments.content,
      createdAt: ticketComments.createdAt,
    })
    .from(ticketComments)
    .where(
      and(
        inArray(ticketComments.epicId, epicIds),
        eq(ticketComments.author, "agent")
      )
    )
    .all()) {
    if (!row.epicId) continue;
    if (!row.content.startsWith(FORENSIC_COMMENT_HEADING)) continue;
    const deadSessionId = parseForensicDeadSessionId(row.content);
    const list = byEpic.get(row.epicId) ?? [];
    list.push({
      id: row.id,
      body: row.content
        .slice(FORENSIC_COMMENT_HEADING.length)
        // The marker is metadata, not prose — never feed it to the dream.
        .replace(/<!--\s*arij:dead-session=[^>]*-->/, "")
        .trim(),
      createdMs: parseTimestampMs(row.createdAt),
      userStoryId: row.userStoryId ?? null,
      deadSessionId,
    });
    byEpic.set(row.epicId, list);
  }
  return byEpic;
}

/**
 * Assigns each forensic diagnostic to the session it actually diagnoses.
 *
 * Two paths, in order.
 *
 * EXACT: the pipeline stamps the diagnosed session's id into the comment
 * (`forensicDeadSessionMarker`), so a marked comment is matched by id — which
 * is the only attribution that survives a forensic agent sitting in a queue
 * for an hour before it writes. A marker naming a session outside this window
 * attaches to nothing rather than falling back.
 *
 * HEURISTIC, for comments written before that marker existed: same scope,
 * comment inside the run's window (start → terminal + slack), and — the part
 * that matters — the CLOSEST such session, preferring one that had already
 * ended.
 *
 * "Closest" is what makes reruns come out right. A first attempt ending at
 * 10:00 and its retry ending at 10:20 both have windows covering a diagnostic
 * filed at 10:21; taking the first session in chronological order would hand
 * the retry's post-mortem to the attempt before it, and the dream would then
 * reason about a failure that belongs to different code.
 *
 * Returns sessionId → diagnostic body, at most one each way: a session gets
 * one post-mortem, and a post-mortem is never repeated across a ticket's runs
 * (which would also burn the digest budget).
 */
function assignForensicComments(
  rows: DreamCandidateRow[],
  forensicByEpic: Map<string, DatedRow[]>
): Map<string, string> {
  const assigned = new Map<string, string>();
  const takenSessions = new Set<string>();

  const comments = [...forensicByEpic.values()]
    .flat()
    // A comment with an explicit marker needs no timestamp; only the legacy
    // heuristic below does.
    .filter((comment) => comment.deadSessionId || comment.createdMs !== null)
    .sort((a, b) => (a.createdMs ?? 0) - (b.createdMs ?? 0));

  for (const comment of comments) {
    // Exact link when the pipeline recorded one: no timestamps, no guessing,
    // and immune to a forensic agent that was queued for an hour.
    if (comment.deadSessionId) {
      const named = rows.find(
        (row) => row.id === comment.deadSessionId && !takenSessions.has(row.id)
      );
      if (named) {
        takenSessions.add(named.id);
        assigned.set(named.id, comment.body);
      }
      // A marker pointing outside this digest's window means the diagnosed
      // session is not here — it must NOT fall through to the heuristic and
      // land on some other run.
      continue;
    }

    const at = comment.createdMs!;
    const candidates = rows
      .filter((row) => {
        if (!row.epicId || takenSessions.has(row.id)) return false;
        if ((comment.userStoryId ?? null) !== (row.userStoryId ?? null)) {
          return false;
        }
        if (!(forensicByEpic.get(row.epicId) ?? []).includes(comment)) {
          return false;
        }
        const startMs = parseTimestampMs(sessionAt(row));
        const terminalMs = sessionTerminalMs(row);
        if (startMs !== null && at < startMs) return false;
        if (terminalMs !== null && at > terminalMs + DREAM_FORENSIC_ATTACH_SLACK_MS) {
          return false;
        }
        return true;
      })
      .sort((a, b) => {
        const aEnd = sessionTerminalMs(a) ?? 0;
        const bEnd = sessionTerminalMs(b) ?? 0;
        // A session that had already ended when the diagnostic landed beats one
        // that was still running: the pipeline files post-mortems for the dead.
        const aBefore = aEnd <= at ? 0 : 1;
        const bBefore = bEnd <= at ? 0 : 1;
        if (aBefore !== bBefore) return aBefore - bBefore;
        return Math.abs(at - aEnd) - Math.abs(at - bEnd);
      });

    const best = candidates[0];
    if (best) {
      takenSessions.add(best.id);
      assigned.set(best.id, comment.body);
    }
  }

  return assigned;
}

/**
 * The tail of a session's final response.
 *
 * Resolution order matters, and the obvious first choice is the wrong one:
 * `agent_sessions.last_non_empty_text` holds only the last non-empty LINE of
 * the newest chunk (see `extractLastNonEmptyText`). Preferring it collapsed a
 * whole review report to one line — and a report's mandated
 * `**Overall Verdict: …**` only survived when it happened to BE that line, so
 * the digest silently lost most verdicts and every closing paragraph.
 *
 * So the persisted chunk streams come first:
 *   - `response` — the final assistant text for streaming providers;
 *   - `output` — where Claude Code's result envelope is persisted
 *     (`result-<sessionId>`) and where other providers put their final output;
 *   - the logs file, then the one-line column, only as last resorts.
 *
 * A TAIL rather than the whole stream: a conclusion (and the verdict line)
 * lives at the end, and the renderer trims it again to its own per-field cap.
 */
function resolveFinalText(row: DreamCandidateRow): string | null {
  for (const streamType of ["response", "output"] as const) {
    const tail = readChunkTail(
      row.id,
      streamType,
      DREAM_FINAL_TEXT_SOURCE_MAX_CHARS
    );
    if (tail && tail.trim()) return tail;
  }
  try {
    const fromLogs = extractLastNonEmptyTextFromFile(row.logsPath);
    if (fromLogs && fromLogs.trim()) return fromLogs;
  } catch {
    // Best-effort: an unreadable log file must not break the digest.
  }
  return row.lastNonEmptyText && row.lastNonEmptyText.trim()
    ? row.lastNonEmptyText
    : null;
}

/**
 * Builds the cross-session digest for a project: window resolution, candidate
 * selection, per-session enrichment, then the size-budgeted assembly.
 *
 * Pure-ish by construction — it reads the database but takes its clock and
 * every cap as arguments, so the window/cap/truncation rules are testable
 * end-to-end without touching a real project.
 */
export function collectDreamDigest(
  projectId: string,
  options: CollectDreamDigestOptions = {}
): DreamDigestResult {
  const now = options.now ?? new Date();
  const lastCutoffAt = findLastDreamCutoff(projectId);
  const window = resolveDreamWindow({
    lastCutoffAt,
    now,
    windowDays: options.windowDays ?? DREAM_WINDOW_DAYS,
  });

  const { rows, candidateCount } = selectDreamCandidates(
    projectId,
    window.sinceIso,
    options.maxSessions ?? DREAM_MAX_SESSIONS
  );

  // Oldest → newest: the dream reads the period as a story, not a stack.
  const ordered = [...rows].reverse();

  const epicIds = [
    ...new Set(ordered.map((row) => row.epicId).filter((id): id is string => !!id)),
  ];
  const storyIds = [
    ...new Set(
      ordered.map((row) => row.userStoryId).filter((id): id is string => !!id)
    ),
  ];
  const labels = loadTicketLabels(epicIds, storyIds);
  const findingsByEpic = loadBlockingFindingsByEpic(epicIds);
  const forensicByEpic = loadForensicCommentsByEpic(epicIds);

  // Resolved for the whole batch at once: attributing a post-mortem needs to
  // compare candidate sessions against each other, which a per-session pass
  // cannot do (see assignForensicComments).
  const forensicBySession = assignForensicComments(ordered, forensicByEpic);

  const sessions: DreamSessionDigest[] = ordered.map((row) => {
    const startMs = parseTimestampMs(sessionAt(row));
    const endMs = sessionTerminalMs(row);
    const finalText = resolveFinalText(row);

    // Exact attribution when the filing session was recorded; the time window
    // only for rows written before migration 0032. Mixing the two would be
    // wrong in the case that matters: with two reviewers on one epic, a
    // LINKED row belongs to its session and to no other, so an unlinked
    // fallback must never claim it.
    const findings = row.epicId
      ? (findingsByEpic.get(row.epicId) ?? [])
          .filter((finding) =>
            finding.agentSessionId
              ? finding.agentSessionId === row.id
              : finding.createdMs !== null &&
                (startMs === null || finding.createdMs >= startMs) &&
                (endMs === null || finding.createdMs <= endMs)
          )
          .map((finding) => finding.body)
      : [];

    const forensic = forensicBySession.get(row.id) ?? null;

    const ticketLabel = row.userStoryId
      ? [labels.epics.get(row.epicId ?? ""), labels.stories.get(row.userStoryId)]
          .filter(Boolean)
          .join(" — ") || null
      : (labels.epics.get(row.epicId ?? "") ?? null);

    return {
      sessionId: row.id,
      at: sessionAt(row),
      ticketLabel,
      agentType: row.agentType,
      provider: row.provider,
      model: row.model,
      status: row.status,
      outcome: row.outcome,
      durationMs:
        startMs !== null && endMs !== null && endMs >= startMs
          ? endMs - startMs
          : null,
      costUsd: row.totalCostUsd ?? null,
      error: row.error,
      reviewVerdict: extractReviewVerdict(finalText),
      findings,
      forensic,
      finalText,
    };
  });

  const assembled = assembleDreamDigest(
    sessions,
    options.maxChars ?? DREAM_DIGEST_MAX_CHARS
  );

  return {
    ...assembled,
    sinceIso: window.sinceIso,
    collectedAtIso: now.toISOString(),
    lastCutoffAt,
    candidateCount,
    sessions,
  };
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

export interface DreamDecision {
  allowed: boolean;
  reason: string;
}

/**
 * Pure guard matrix — exported for exhaustive testing.
 *
 * Denials, in evaluation order:
 *   - a memory writer is already queued/running for the project. Both a dream
 *     and a distill replace the WHOLE document, so either one in flight blocks
 *     this dream — two concurrent rewrites would race, last-write-wins;
 *   - the window turned up nothing new (the silent, journalled no-op: paying
 *     for a dream that would re-derive the memory it already has is waste).
 */
export function evaluateDreamGuards(input: {
  hasPendingMemoryWriter: boolean;
  sessionCount: number;
}): DreamDecision {
  if (input.hasPendingMemoryWriter) {
    return {
      allowed: false,
      reason:
        "a memory rewrite (distill or dream) is already pending for this project",
    };
  }
  if (input.sessionCount <= 0) {
    return {
      allowed: false,
      reason: "no new sessions since the last dream",
    };
  }
  return { allowed: true, reason: "eligible" };
}

/**
 * Pure guard matrix for the night-run trigger — exported for testing.
 *
 * The dream is dispatched from the run's terminal choke point, which is AFTER
 * the wave engine's last cost-cap check. The cap therefore cannot stop the
 * dream on its own, so it is re-evaluated here: a run that already spent its
 * budget does not get to spend more on a dream just because the dream comes
 * last. Same reasoning for an explicit user stop — "stop this run" plainly
 * means "stop spending on it".
 *
 * A circuit-breaker abort is deliberately NOT a denial: a run that failed its
 * way to a breaker trip is exactly the run whose lessons are worth distilling.
 */
export function evaluateNightRunDreamGuards(input: {
  enabled: boolean;
  abortReason: string | null;
  costCapUsd: number | null;
  spentUsd: number;
}): DreamDecision {
  if (!input.enabled) {
    return { allowed: false, reason: "dreaming_after_night_run is off" };
  }
  if (input.abortReason === NIGHT_STOPPED_ABORT_REASON) {
    return { allowed: false, reason: "night run was stopped by the user" };
  }
  if (input.costCapUsd !== null && input.spentUsd >= input.costCapUsd) {
    return {
      allowed: false,
      reason: `night run cost cap reached ($${input.spentUsd.toFixed(2)} of $${input.costCapUsd.toFixed(2)})`,
    };
  }
  return { allowed: true, reason: "eligible" };
}

// ---------------------------------------------------------------------------
// Night-run trigger
// ---------------------------------------------------------------------------

function readSettingValue(key: string): string | null {
  try {
    return (
      db
        .select({ value: settings.value })
        .from(settings)
        .where(eq(settings.key, key))
        .get()?.value ?? null
    );
  } catch {
    return null;
  }
}

/**
 * Effective "dream after a night run" answer: project key → global key → OFF.
 * Tri-state parsing all the way down, so an explicit per-project `false`
 * overrides a global `true`.
 */
export function isDreamingAfterNightRunEnabled(projectId: string): boolean {
  for (const key of [
    dreamingAfterNightRunSettingKey(projectId),
    DREAMING_AFTER_NIGHT_RUN_SETTING_KEY,
  ]) {
    const parsed = parseDreamingAfterNightRunSetting(readSettingValue(key));
    if (parsed !== null) return parsed;
  }
  return false;
}

export interface NightRunDreamContext {
  /** The run's abort reason, verbatim from the engine (null = normal finish). */
  abortReason?: string | null;
  /** Effective cost cap of the run, or null when it ran uncapped. */
  costCapUsd?: number | null;
  /** What the run had spent when it closed (SUM over its tagged sessions). */
  spentUsd?: number;
}

/**
 * Night-run trigger, invoked (fire-and-forget) from the night engine's
 * terminal choke point. Best-effort by design: it must never throw into the
 * run's finish path, and every denial is silent except for the journal line.
 *
 * Cost accounting, precisely:
 *   - the run id is inherited as `batch_run_id`, so the dream's spend shows up
 *     in every DB-derived total for the run (the summary dialog, the run
 *     detail, `sumNightRunCost`);
 *   - the wave engine's own cap check cannot stop it (the run is already
 *     over), so the cap is re-applied HERE, before dispatch, from the numbers
 *     the caller measured at finish time;
 *   - the one number it cannot appear in is the morning-summary NOTIFICATION,
 *     which is sent before the dream starts. That is the accepted trade: the
 *     summary must not wait minutes for a dream, and the deep link it carries
 *     opens the detail view, which re-derives the total from the database and
 *     therefore does include it.
 */
export async function maybeDreamAfterNightRun(
  projectId: string,
  runId: string,
  context: NightRunDreamContext = {}
): Promise<DreamDecision> {
  try {
    const decision = evaluateNightRunDreamGuards({
      enabled: isDreamingAfterNightRunEnabled(projectId),
      abortReason: context.abortReason ?? null,
      costCapUsd: context.costCapUsd ?? null,
      spentUsd: context.spentUsd ?? 0,
    });
    if (!decision.allowed) {
      // Only the cost/stop denials are worth a journal line; "the setting is
      // off" is the default state of every project and would be pure noise.
      if (isDreamingAfterNightRunEnabled(projectId)) {
        console.info(
          `${DREAMING_LOG_PREFIX} skipped for project ${projectId}` +
            ` (night_run ${runId}): ${decision.reason}`
        );
      }
      return decision;
    }
    const result = await dispatchDreamingSession({
      projectId,
      batchRunId: runId,
      trigger: "night_run",
    });
    return { allowed: result.dispatched, reason: result.reason };
  } catch (error) {
    console.warn(
      `${DREAMING_LOG_PREFIX} Night-run trigger failed:`,
      (error as Error).message
    );
    return { allowed: false, reason: "dreaming trigger failed" };
  }
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export interface DispatchDreamingInput {
  projectId: string;
  /** Night run that caused the dream; tagged on the session row. */
  batchRunId?: string | null;
  /** Optional explicit named agent (manual dispatch). */
  namedAgentId?: string | null;
  /** What asked for this dream — journal context only. */
  trigger?: "manual" | "night_run";
  /** Collector overrides (tests). */
  collect?: CollectDreamDigestOptions;
}

export interface DispatchDreamingResult {
  /** Null when a guard refused — see `reason`. */
  sessionId: string | null;
  dispatched: boolean;
  reason: string;
  /** Sessions the digest carries (0 on a refusal). */
  sessionsAnalyzed: number;
}

/**
 * Strips an accidental full-document code fence from the agent's output
 * (the prompt forbids fences, but a cheap unwrap beats a corrupted doc).
 */
export function sanitizeDreamedMemory(output: string): string {
  const trimmed = output.trim();
  const fenceMatch = trimmed.match(/^```[a-zA-Z]*\n([\s\S]*)\n```$/);
  if (fenceMatch) {
    return fenceMatch[1].trim();
  }
  return trimmed;
}

/**
 * Creates a queued 'dreaming' session and submits its launch closure to the
 * per-project scheduler. Resolves as soon as the row exists; the memory lands
 * in the database when the closure finishes — and only if the session
 * delivered.
 *
 * Throws when the project does not exist. Guard refusals are NOT errors: they
 * come back as `dispatched: false` with a reason, journalled on the way out.
 */
export async function dispatchDreamingSession(
  input: DispatchDreamingInput
): Promise<DispatchDreamingResult> {
  const project = db
    .select()
    .from(projects)
    .where(eq(projects.id, input.projectId))
    .get();
  if (!project) {
    throw new Error("Project not found");
  }

  const pending = hasPendingMemoryWriter(input.projectId);
  const digest = pending
    ? null
    : collectDreamDigest(input.projectId, input.collect ?? {});

  const decision = evaluateDreamGuards({
    hasPendingMemoryWriter: pending,
    sessionCount: digest?.includedCount ?? 0,
  });

  if (!decision.allowed) {
    // The journalled no-op: a dream that finds nothing new must leave a trace
    // (why nothing happened) without spending a session on it.
    console.info(
      `${DREAMING_LOG_PREFIX} skipped for project ${input.projectId}` +
        ` (${input.trigger ?? "manual"}): ${decision.reason}`
    );
    return {
      sessionId: null,
      dispatched: false,
      reason: decision.reason,
      sessionsAnalyzed: 0,
    };
  }

  const collected = digest!;
  const currentMemory = getProjectMemoryContent(input.projectId);
  const systemPrompt = await resolveAgentPrompt(
    DREAMING_AGENT_TYPE,
    input.projectId
  );
  const resolvedAgent = resolveAgentByNamedId(
    DREAMING_AGENT_TYPE,
    input.projectId,
    input.namedAgentId ?? null
  );

  const prompt = buildDreamingPrompt(
    // Explicit `memory: null` stops the builder-level injection from re-adding
    // the doc this prompt already frames as "Current Project Memory".
    { ...project, memory: null },
    currentMemory,
    {
      digest: collected.text,
      sessionCount: collected.includedCount,
      sinceIso: collected.sinceIso,
      truncatedCount: collected.truncatedCount,
      droppedCount: collected.droppedCount,
    },
    systemPrompt
  );

  const sessionId = createId();
  const now = new Date().toISOString();
  const logsDir = path.join(process.cwd(), "data", "sessions", sessionId);
  fs.mkdirSync(logsDir, { recursive: true });
  const logsPath = path.join(logsDir, "logs.json");
  const cliSessionId = providerAcceptsAssignedSessionId(resolvedAgent.provider)
    ? crypto.randomUUID()
    : undefined;

  // Re-check under NO await: the guard above ran before `resolveAgentPrompt`,
  // and two triggers firing together (the Docs button while a night run
  // finishes, or an auto-distill racing this dream) could both have passed it
  // during that suspension. From here to the insert everything is synchronous,
  // so on Node's single thread this second look is the one that actually makes
  // "never two memory rewrites at once" true rather than merely likely.
  if (hasPendingMemoryWriter(input.projectId)) {
    const reason =
      "a memory rewrite (distill or dream) is already pending for this project";
    console.info(
      `${DREAMING_LOG_PREFIX} skipped for project ${input.projectId}` +
        ` (${input.trigger ?? "manual"}): ${reason} (raced)`
    );
    return { sessionId: null, dispatched: false, reason, sessionsAnalyzed: 0 };
  }

  // Deliberately no epicId (see the module docblock): a dream spans every
  // ticket, so pinning it to one would both lie and hold that epic's
  // concurrency slot for the whole run.
  createQueuedSession({
    id: sessionId,
    projectId: input.projectId,
    mode: "plan",
    provider: resolvedAgent.provider,
    prompt,
    logsPath,
    cliSessionId,
    namedAgentId: resolvedAgent.namedAgentId ?? null,
    agentType: DREAMING_AGENT_TYPE,
    namedAgentName: resolvedAgent.name || null,
    model: resolvedAgent.model || null,
    batchRunId: input.batchRunId ?? null,
    createdAt: now,
  });

  agentScheduler.submit(input.projectId, sessionId, async () => {
    markSessionRunning(sessionId);

    processManager.start(
      sessionId,
      {
        mode: "plan",
        prompt,
        cwd: project.gitRepoPath || process.cwd(),
        model: resolvedAgent.model,
        cliSessionId,
      },
      resolvedAgent.provider
    );

    const info = await waitForProcessCompletion(sessionId, POLL_INTERVAL_MS);

    const completedAt = new Date().toISOString();
    const result = info?.result;

    try {
      fs.writeFileSync(logsPath, JSON.stringify(result, null, 2));
    } catch {
      // Best-effort log write.
    }

    const outcome = classifySessionOutcome(result, sessionId);

    try {
      markSessionTerminal(
        sessionId,
        {
          success: !!result?.success,
          error: result?.error ?? null,
          outcome,
          usage: extractSessionUsage(result),
        },
        completedAt
      );
    } catch (error) {
      if (!isSessionLifecycleConflictError(error)) {
        console.error(`${DREAMING_LOG_PREFIX} Failed to finalize session`, error);
      }
    }

    // Only a delivered answer replaces the memory — silent runs, asked
    // questions and failures leave it exactly as it was.
    if (!result?.success || outcome !== "answered") {
      return;
    }

    const output = sanitizeDreamedMemory(
      resolveSessionOutput(result, sessionId, "")
    );
    if (!output) {
      return;
    }

    // Validate what would ACTUALLY BE STORED, not what the agent produced.
    // `saveProjectMemory` truncates at the cap, so an over-long response can
    // arrive with all four sections and land with its last one cut off — a
    // document that stops mid-sentence, injected into every future prompt,
    // with the digest window marked as learned. Checking the cap-effective
    // text catches that as well as an agent that ignored the contract.
    const structure = validateDreamedMemoryStructure(enforceMemoryCap(output));
    if (!structure.valid) {
      // Same posture as the mid-dream edit: nothing stored, cutoff unmoved, so
      // the next dream reads the same sessions and gets another attempt. The
      // rejected text stays readable on the session page.
      console.warn(
        `${DREAMING_LOG_PREFIX} discarded for project ${input.projectId}:` +
          ` the dreamed memory did not match the required structure` +
          ` (${structure.reason}); session ${sessionId}`
      );
      return;
    }

    try {
      // Snapshot and replacement commit together or not at all. A dream
      // rewrites the whole document, so the pre-dream text is the only way
      // back — and archiving it separately would let a failed save burn that
      // snapshot while leaving the live memory untouched.
      //
      // `expectedPrevious` is the memory this dream actually REASONED FROM
      // (captured minutes ago, at prompt time). A dream runs long enough for
      // someone to save an edit in the Docs tab meanwhile; replacing blindly
      // would throw that edit away in favour of text derived from the version
      // before it. The human edit is the newer intent and wins — a dream can
      // just be run again.
      replaceProjectMemoryWithSnapshot(input.projectId, output, {
        expectedPrevious: currentMemory,
      });
    } catch (error) {
      // Either way the window deliberately does NOT advance: a dream whose
      // output was never stored taught the project nothing, so the next dream
      // must read the same sessions again rather than skip past them.
      if (isProjectMemoryChangedError(error)) {
        console.info(
          `${DREAMING_LOG_PREFIX} discarded for project ${input.projectId}:` +
            ` the memory was edited while the dream ran (its output is still` +
            ` readable on session ${sessionId})`
        );
        return;
      }
      console.error(`${DREAMING_LOG_PREFIX} Failed to save dreamed memory`, error);
      return;
    }

    // Story 3: record who wrote the document, and tell every open memory
    // view to re-fetch — the single channel every other write path uses.
    try {
      recordMemoryWriteProvenance(input.projectId, {
        source: "dreaming",
        sessionId,
      });
      eventBus.emit({
        type: "memory:changed",
        projectId: input.projectId,
        data: { source: "dreaming" },
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      console.warn(
        `${DREAMING_LOG_PREFIX} Failed to record the dream memory write`,
        error
      );
    }

    // The single place the window advances — after, and only after, the memory
    // document actually changed. Stamped with the COLLECTION instant, so
    // sessions that reached a terminal state while this dream was running stay
    // inside the next window instead of falling through the crack between
    // "collected" and "finished".
    try {
      recordDreamCutoff(input.projectId, collected.collectedAtIso);
    } catch (error) {
      // Losing the cutoff costs a re-read, never a loss — leave it noisy but
      // non-fatal.
      console.warn(
        `${DREAMING_LOG_PREFIX} Failed to record the dream cutoff`,
        error
      );
    }

    try {
      createMemoryDreamedNotification({
        projectId: input.projectId,
        sessionId,
        sessionsAnalyzed: collected.includedCount,
        // The memory this dream replaced is exactly what it reasoned from —
        // the guard above just proved the two are still the same text.
        previousChars: currentMemory?.length ?? 0,
        newChars: getProjectMemoryContent(input.projectId)?.length ?? 0,
      });
    } catch (error) {
      console.warn(
        `${DREAMING_LOG_PREFIX} Failed to notify about the dreamed memory`,
        error
      );
    }
  });

  return {
    sessionId,
    dispatched: true,
    reason: decision.reason,
    sessionsAnalyzed: collected.includedCount,
  };
}
