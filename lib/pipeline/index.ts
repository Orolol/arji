import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { epics, settings, userStories } from "@/lib/db/schema";
import { createId } from "@/lib/utils/nanoid";
import { logTransition } from "@/lib/workflow/log";
import type { AgentProvider } from "@/lib/agent-config/constants";
import { transitionReviewRejected } from "@/lib/workflow/automatic-transitions";
import { runForensic } from "./forensic";
import { createVerifyGate } from "./verify";
import {
  DEFAULT_PIPELINE_MAX_ATTEMPTS,
  DEFAULT_PIPELINE_MAX_FIX_CYCLES,
  PIPELINE_ENABLED_SETTING_KEY,
  PIPELINE_GRADER_ENABLED_SETTING_KEY,
  PIPELINE_MAX_ATTEMPTS_SETTING_KEY,
  PIPELINE_MAX_FIX_CYCLES_SETTING_KEY,
  PIPELINE_MAX_SESSIONS_PER_RUN,
  PIPELINE_REASONS,
  parsePipelineEnabledSetting,
  parsePipelineMaxAttempts,
  parsePipelineMaxFixCycles,
  pipelineEnabledSettingKey,
  pipelineGraderEnabledSettingKey,
  pipelineMaxAttemptsSettingKey,
  pipelineMaxFixCyclesSettingKey,
} from "./constants";
import { pipelineRegistry, listPipelineRunsByProject } from "./registry";
import { createPipelineStageDriver } from "./stages";
import {
  runPipeline,
  type PipelineStageResult,
  type PipelineTerminalSummary,
} from "./runner";

/**
 * Autonomous pipeline entry point (build → review → auto-fix → forensic).
 *
 * `startPipelineRun` is called by the two single-ticket build routes AFTER
 * they created their own build session and wrapped its launch closure with
 * the settle pattern. It registers the run, wires the real stage drivers
 * into the pure runner, and returns synchronously — the run continues in the
 * background exactly like the DAG wave engine outlives its HTTP request.
 *
 * Success leaves the ticket in 'review': the pipeline never auto-approves
 * (review → done stays human-gated by the workflow engine). asked_question
 * at any stage pauses the run terminally; stopping the live stage session
 * stops the pipeline.
 */

export interface StartPipelineRunInput {
  projectId: string;
  scope: "epic" | "story";
  epicId: string;
  userStoryId: string | null;
  buildSessionId: string;
  buildProvider: AgentProvider;
  buildNamedAgentId: string | null;
  buildSettled: Promise<PipelineStageResult>;
  /**
   * Batch/night run that dispatched this pipeline. Threaded onto every
   * session row the run creates (stage + forensic sessions) so DB-derived
   * summaries and cost caps can group by run. Null/absent for standalone
   * dispatches (the epic/story build routes).
   */
  batchRunId?: string | null;
  /**
   * Awaitable terminal seam: fires EXACTLY ONCE when the run reaches any
   * terminal state — including the engine-crash safety net. Invoked after
   * the registry snapshot is finished; must not rely on the run still being
   * active. Exceptions are swallowed (the engine never crashes over a
   * callback).
   */
  onTerminal?(summary: PipelineTerminalSummary): void;
}

function readSettingValue(key: string): string | null {
  const row = db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, key))
    .get();
  return row?.value ?? null;
}

/**
 * Effective "run the pipeline by default" answer for a project:
 * `pipeline_enabled:<projectId>` → `pipeline_enabled` → OFF. An explicit
 * request flag beats both (handled by the routes).
 */
export function resolvePipelineEnabled(projectId: string): boolean {
  for (const key of [
    pipelineEnabledSettingKey(projectId),
    PIPELINE_ENABLED_SETTING_KEY,
  ]) {
    const parsed = parsePipelineEnabledSetting(readSettingValue(key));
    if (parsed !== null) return parsed;
  }
  return false;
}

/** Effective grader option: project override → global → OFF. */
export function resolvePipelineGraderEnabled(projectId: string): boolean {
  for (const key of [
    pipelineGraderEnabledSettingKey(projectId),
    PIPELINE_GRADER_ENABLED_SETTING_KEY,
  ]) {
    const parsed = parsePipelineEnabledSetting(readSettingValue(key));
    if (parsed !== null) return parsed;
  }
  return false;
}

function resolveCap(
  keys: string[],
  parse: (value: unknown) => number | null,
  fallback: number
): number {
  for (const key of keys) {
    const raw = readSettingValue(key);
    if (raw === null) continue;
    const parsed = parse(raw);
    if (parsed !== null) return parsed;
  }
  return fallback;
}

/** Per-stage attempt cap: project override → global → default 2 (clamped 1..5). */
export function resolvePipelineMaxAttempts(projectId: string): number {
  return resolveCap(
    [
      pipelineMaxAttemptsSettingKey(projectId),
      PIPELINE_MAX_ATTEMPTS_SETTING_KEY,
    ],
    parsePipelineMaxAttempts,
    DEFAULT_PIPELINE_MAX_ATTEMPTS
  );
}

/** Fix-cycle cap: project override → global → default 2 (clamped 0..5). */
export function resolvePipelineMaxFixCycles(projectId: string): number {
  return resolveCap(
    [
      pipelineMaxFixCyclesSettingKey(projectId),
      PIPELINE_MAX_FIX_CYCLES_SETTING_KEY,
    ],
    parsePipelineMaxFixCycles,
    DEFAULT_PIPELINE_MAX_FIX_CYCLES
  );
}

/**
 * Registers and starts one pipeline run. Synchronous return (the engine
 * runs in the background); every failure after this point surfaces through
 * the activity trace + registry snapshot, never as a thrown error.
 */
export function startPipelineRun(input: StartPipelineRunInput): {
  runId: string;
} {
  const runId = createId();
  const startedAt = new Date().toISOString();

  pipelineRegistry.register({
    runId,
    projectId: input.projectId,
    epicId: input.epicId,
    userStoryId: input.userStoryId,
    state: "running_build",
    stage: "build",
    stageAttempt: 1,
    fixCycles: 0,
    sessionIds: [input.buildSessionId],
    startedAt,
    endedAt: null,
    reason: null,
  });

  // Activity trace: actor 'system', from == to (current epic status). Story
  // runs log on the parent epic, matching reviewComments keying.
  const trace = (reason: string, sessionId: string | null): void => {
    try {
      const epicStatus =
        db
          .select({ status: epics.status })
          .from(epics)
          .where(eq(epics.id, input.epicId))
          .get()?.status ?? "in_progress";
      logTransition({
        projectId: input.projectId,
        epicId: input.epicId,
        fromStatus: epicStatus,
        toStatus: epicStatus,
        actor: "system",
        reason,
        sessionId: sessionId ?? undefined,
      });
    } catch (error) {
      console.warn(
        "[pipeline] Failed to write activity trace:",
        error instanceof Error ? error.message : error
      );
    }
  };

  trace(PIPELINE_REASONS.started, input.buildSessionId);

  // Terminal seam: fires input.onTerminal exactly once across the two
  // possible terminal paths (runner onFinish, engine-crash catch), and never
  // lets a callback exception escape into the engine.
  let terminalFired = false;
  const fireTerminal = (summary: PipelineTerminalSummary): void => {
    if (terminalFired) return;
    terminalFired = true;
    try {
      input.onTerminal?.(summary);
    } catch (error) {
      console.warn(
        "[pipeline] onTerminal callback threw:",
        error instanceof Error ? error.message : error
      );
    }
  };

  const driver = createPipelineStageDriver({
    projectId: input.projectId,
    scope: input.scope,
    epicId: input.epicId,
    userStoryId: input.userStoryId,
    buildNamedAgentId: input.buildNamedAgentId,
    batchRunId: input.batchRunId ?? null,
  });

  const engine = runPipeline({
    maxAttempts: resolvePipelineMaxAttempts(input.projectId),
    maxFixCycles: resolvePipelineMaxFixCycles(input.projectId),
    maxSessions: PIPELINE_MAX_SESSIONS_PER_RUN,
    initialBuild: {
      sessionId: input.buildSessionId,
      settled: input.buildSettled,
    },
    launchStage: driver.launchStage,
    gradingEnabled: resolvePipelineGraderEnabled(input.projectId),
    runVerifyGate: createVerifyGate({
      projectId: input.projectId,
      scope: input.scope,
      epicId: input.epicId,
      userStoryId: input.userStoryId,
    }),
    assessReview: driver.assessReview,
    assessGrading: driver.assessGrading,
    readSessionStatus: driver.readSessionStatus,
    checkGuards: driver.checkGuards,
    parkRejectedTicket: (lastCodeSessionId, reason) => {
      // Mirror of the negative-review path: a gate-rejected bug must not
      // stay in the approval-ready column. Only a ticket actually sitting
      // in review/done is moved; anything else is left untouched. The
      // caller supplies `reason` because the three park paths — rejection,
      // unrunnable command, crashed gate — are not the same event.
      if (input.scope === "story") {
        const story = input.userStoryId
          ? db
              .select()
              .from(userStories)
              .where(eq(userStories.id, input.userStoryId))
              .get()
          : null;
        if (!story) return;
        if (story.status !== "review" && story.status !== "done") return;
        transitionReviewRejected({
          projectId: input.projectId,
          epicId: input.epicId,
          scope: "story",
          userStoryId: input.userStoryId,
          sessionId: lastCodeSessionId ?? "",
          reason,
        });
        return;
      }
      const epic = db
        .select()
        .from(epics)
        .where(eq(epics.id, input.epicId))
        .get();
      if (!epic) return;
      if (epic.status !== "review" && epic.status !== "done") return;
      transitionReviewRejected({
        projectId: input.projectId,
        epicId: input.epicId,
        scope: "epic",
        sessionId: lastCodeSessionId ?? "",
        reason,
      });
    },
    runForensic: (forensicInput) =>
      runForensic({
        projectId: input.projectId,
        epicId: input.epicId,
        userStoryId: input.userStoryId,
        deadSessionId: forensicInput.deadSessionId,
        stage: forensicInput.stage,
        attempts: forensicInput.attempts,
        batchRunId: input.batchRunId ?? null,
      }),
    callbacks: {
      onStageChange: (state, stage, stageAttempt, fixCycles) => {
        try {
          pipelineRegistry.update(runId, {
            state,
            stage,
            stageAttempt,
            fixCycles,
          });
        } catch {
          // registry updates are best-effort
        }
      },
      onSessionAdded: (sessionId) => {
        try {
          pipelineRegistry.recordSession(runId, sessionId);
        } catch {
          // best-effort
        }
      },
      onTrace: trace,
      onFinish: (summary) => {
        try {
          pipelineRegistry.finish(runId, summary.state, summary.reason);
        } catch {
          // best-effort
        }
        fireTerminal(summary);
      },
    },
  });

  // The engine outlives the HTTP request. Per-stage failures feed the retry
  // ladder, so a rejection here is an engine bug — log it and close the
  // run's snapshot so it cannot look active forever.
  void engine.catch((error) => {
    console.error(`[pipeline] Run ${runId} crashed`, error);
    try {
      pipelineRegistry.finish(runId, "failed", "pipeline engine error");
    } catch {
      // best-effort
    }
    // The registry still serves the ring after finish, so the crash summary
    // carries whatever sessions the run had recorded before it died.
    fireTerminal({
      state: "failed",
      reason: "pipeline engine error",
      sessionIds: pipelineRegistry.get(runId)?.sessionIds ?? [],
      fixCycles: 0,
    });
  });

  return { runId };
}

export { listPipelineRunsByProject, pipelineRegistry };
export type { PipelineStageResult, PipelineTerminalSummary };
export type { PipelineRunSnapshot } from "./constants";
