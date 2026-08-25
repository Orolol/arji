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
 *   - the digest NEVER embeds raw chunk streams. Only the signals that carry a
 *     lesson, each capped, and the whole thing cut to DREAM_DIGEST_MAX_CHARS
 *     by a fair (water-filling) allocation so one verbose session cannot
 *     starve the rest — see lib/workflow/dreaming-digest.ts;
 *   - NO epicId on the session row (same trick as lib/pipeline/forensic.ts):
 *     a background project-level pass must never occupy an epic's concurrency
 *     slot, so it can never block a ticket;
 *   - batchRunId IS inherited when a night run triggers the dream, because the
 *     night cost cap and the morning summary query `agent_sessions.batch_run_id`
 *     and nothing else — the tag alone is the entire integration (same pitfall
 *     documented on memory-distill);
 *   - the memory is replaced ONLY when the session actually delivers
 *     (`outcome === 'answered'` with non-empty output), the same guard
 *     spec-auto-rewrite.ts applies to the spec. The previous memory is
 *     snapshotted first (documents row, kind 'memory_archive').
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
// Single source of truth for the heading the pipeline files diagnostics under —
// the digest recognises forensic comments by exactly that string.
import { FORENSIC_COMMENT_HEADING } from "@/lib/pipeline/forensic";
import {
  archiveProjectMemory,
  getProjectMemoryContent,
  saveProjectMemory,
} from "@/lib/documents/memory";
import { createMemoryDreamedNotification } from "@/lib/notifications/create";
import {
  DREAMING_AFTER_NIGHT_RUN_SETTING_KEY,
  DREAMING_AGENT_TYPE,
  DREAMING_LOG_PREFIX,
  DREAM_DIGEST_MAX_CHARS,
  DREAM_FORENSIC_ATTACH_SLACK_MS,
  DREAM_MAX_SESSIONS,
  DREAM_SOURCE_AGENT_TYPES,
  DREAM_WINDOW_DAYS,
  dreamingAfterNightRunSettingKey,
  parseDreamingAfterNightRunSetting,
} from "./dreaming-constants";
import {
  assembleDreamDigest,
  extractReviewVerdict,
  parseTimestampMs,
  resolveDreamWindow,
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
  /** Inclusive lower bound of the collection window. */
  sinceIso: string;
  /** Timestamp of the dream this window follows, or null for a first dream. */
  lastDreamAt: string | null;
  /** Candidates inside the window before the session-count cap. */
  candidateCount: number;
  /** Per-session records that were rendered (chronological order). */
  sessions: DreamSessionDigest[];
}

/**
 * When the project last DELIVERED a dream.
 *
 * Deliberately keyed on delivery, not on dispatch: a dream that failed or
 * stayed silent never folded its window into the memory, so the next dream
 * must read that evidence again rather than skip it.
 */
export function findLastDreamAt(projectId: string): string | null {
  const rows = db
    .select({
      createdAt: agentSessions.createdAt,
      endedAt: agentSessions.endedAt,
      completedAt: agentSessions.completedAt,
    })
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.projectId, projectId),
        eq(agentSessions.agentType, DREAMING_AGENT_TYPE),
        eq(agentSessions.status, "completed"),
        eq(agentSessions.outcome, "answered")
      )
    )
    .all();

  let latest: number | null = null;
  let latestIso: string | null = null;
  for (const row of rows) {
    const iso = row.completedAt ?? row.endedAt ?? row.createdAt;
    const ms = parseTimestampMs(iso);
    if (ms === null) continue;
    if (latest === null || ms > latest) {
      latest = ms;
      latestIso = iso;
    }
  }
  return latestIso;
}

/** True when a dream is already queued/running for the project. */
export function hasPendingDream(projectId: string): boolean {
  const row = db
    .select({ id: agentSessions.id })
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.projectId, projectId),
        eq(agentSessions.agentType, DREAMING_AGENT_TYPE),
        inArray(agentSessions.status, ["queued", "running"])
      )
    )
    .get();
  return !!row;
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

/** Sort key of a session: when it actually started, else when it was queued. */
function sessionAt(row: DreamCandidateRow): string | null {
  return row.startedAt ?? row.createdAt;
}

function sessionEndMs(row: DreamCandidateRow): number | null {
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
    const ms = parseTimestampMs(sessionAt(row));
    // A session we cannot date cannot be placed in the window — leaving it out
    // is the choice that keeps consecutive dreams from re-reading it forever.
    if (ms === null) return false;
    return sinceMs === null || ms >= sinceMs;
  });

  inWindow.sort(
    (a, b) =>
      (parseTimestampMs(sessionAt(b)) ?? 0) - (parseTimestampMs(sessionAt(a)) ?? 0)
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
}

/**
 * Agent-authored `[critical]`/`[major]` findings per epic. Unlike the
 * pipeline's blocking assessment (lib/pipeline/findings.ts) this keeps
 * RESOLVED rows too: a finding that was fixed still records a mistake the
 * agents made, which is exactly what a dream is looking for.
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
    list.push({ id: row.id, body, createdMs: parseTimestampMs(row.createdAt) });
    byEpic.set(row.epicId, list);
  }
  return byEpic;
}

/** Forensic diagnostic comments per epic (lib/pipeline/forensic.ts files them). */
function loadForensicCommentsByEpic(epicIds: string[]): Map<string, DatedRow[]> {
  const byEpic = new Map<string, DatedRow[]>();
  if (epicIds.length === 0) return byEpic;

  for (const row of db
    .select({
      id: ticketComments.id,
      epicId: ticketComments.epicId,
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
    const list = byEpic.get(row.epicId) ?? [];
    list.push({
      id: row.id,
      body: row.content.slice(FORENSIC_COMMENT_HEADING.length).trim(),
      createdMs: parseTimestampMs(row.createdAt),
    });
    byEpic.set(row.epicId, list);
  }
  return byEpic;
}

/** Final response of a session: streamed column first, then the logs file. */
function resolveFinalText(row: DreamCandidateRow): string | null {
  if (row.lastNonEmptyText && row.lastNonEmptyText.trim()) {
    return row.lastNonEmptyText;
  }
  try {
    return extractLastNonEmptyTextFromFile(row.logsPath);
  } catch {
    return null;
  }
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
  const lastDreamAt = findLastDreamAt(projectId);
  const window = resolveDreamWindow({
    lastDreamAt,
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

  // A forensic comment belongs to exactly ONE session in the digest: the first
  // (chronologically) whose run window covers it. Without this, every session
  // on a ticket would repeat the same post-mortem and burn the budget.
  const claimedForensic = new Set<string>();

  const sessions: DreamSessionDigest[] = ordered.map((row) => {
    const startMs = parseTimestampMs(sessionAt(row));
    const endMs = sessionEndMs(row);
    const finalText = resolveFinalText(row);

    const findings = row.epicId
      ? (findingsByEpic.get(row.epicId) ?? [])
          .filter(
            (finding) =>
              finding.createdMs !== null &&
              (startMs === null || finding.createdMs >= startMs) &&
              (endMs === null || finding.createdMs <= endMs)
          )
          .map((finding) => finding.body)
      : [];

    let forensic: string | null = null;
    if (row.epicId) {
      const candidate = (forensicByEpic.get(row.epicId) ?? []).find(
        (comment) =>
          !claimedForensic.has(comment.id) &&
          comment.createdMs !== null &&
          (startMs === null || comment.createdMs >= startMs) &&
          (endMs === null ||
            comment.createdMs <= endMs + DREAM_FORENSIC_ATTACH_SLACK_MS)
      );
      if (candidate) {
        claimedForensic.add(candidate.id);
        forensic = candidate.body;
      }
    }

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
    lastDreamAt,
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
 *   - a dream is already queued/running for the project (two concurrent
 *     rewrites of one document would race, last-write-wins);
 *   - the window turned up nothing new (the silent, journalled no-op: paying
 *     for a dream that would re-derive the memory it already has is waste).
 */
export function evaluateDreamGuards(input: {
  hasPendingDream: boolean;
  sessionCount: number;
}): DreamDecision {
  if (input.hasPendingDream) {
    return {
      allowed: false,
      reason: "a dreaming session is already pending for this project",
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

/**
 * Night-run trigger, invoked (fire-and-forget) from the night engine's
 * terminal choke point. Best-effort by design: it must never throw into the
 * run's finish path, and every denial is silent except for the journal line.
 *
 * The run id is inherited as `batch_run_id` so the dream's spend lands inside
 * the run's cost cap and morning summary instead of escaping both.
 */
export async function maybeDreamAfterNightRun(
  projectId: string,
  runId: string
): Promise<DreamDecision> {
  try {
    if (!isDreamingAfterNightRunEnabled(projectId)) {
      return { allowed: false, reason: "dreaming_after_night_run is off" };
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

  const pending = hasPendingDream(input.projectId);
  const digest = pending
    ? null
    : collectDreamDigest(input.projectId, input.collect ?? {});

  const decision = evaluateDreamGuards({
    hasPendingDream: pending,
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

    const previous = getProjectMemoryContent(input.projectId);
    try {
      // Snapshot BEFORE the replacement: a dream rewrites the whole document,
      // so the pre-dream text is the only way back if it goes wrong.
      archiveProjectMemory(input.projectId, previous);
      saveProjectMemory(input.projectId, output);
    } catch (error) {
      console.error(`${DREAMING_LOG_PREFIX} Failed to save dreamed memory`, error);
      return;
    }

    try {
      createMemoryDreamedNotification({
        projectId: input.projectId,
        sessionId,
        sessionsAnalyzed: collected.includedCount,
        previousChars: previous?.length ?? 0,
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
