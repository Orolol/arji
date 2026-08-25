import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import {
  projects,
  epics,
  userStories,
  ticketComments,
} from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { createId } from "@/lib/utils/nanoid";
import { createWorktree, isGitRepo } from "@/lib/git/manager";
import { processManager } from "@/lib/claude/process-manager";
import { waitForProcessCompletion } from "@/lib/agent-sessions/wait-for-completion";
import {
  buildBuildPrompt,
  buildTeamBuildPrompt,
  type TeamEpic,
} from "@/lib/claude/prompt-builder";
import { resolveAgentPrompt } from "@/lib/agent-config/prompts";
import {
  classifySessionOutcome,
  extractSessionUsage,
  resolveSessionOutput,
} from "@/lib/claude/resolve-session-output";
import { handleAskedQuestionOutcome } from "@/lib/workflow/agent-question";

import fs from "fs";
import path from "path";
import { tryExportArjiJson } from "@/lib/sync/export";
import {
  createAgentAlreadyRunningPayload,
  getRunningSessionForTarget,
} from "@/lib/agents/concurrency";
import { agentScheduler } from "@/lib/agents/scheduler";
import {
  createQueuedSession,
  isSessionLifecycleConflictError,
  markSessionRunning,
  markSessionTerminal,
} from "@/lib/agent-sessions/lifecycle";
import { resolveAgentByNamedId } from "@/lib/agent-config/agent-resolution";
import { buildExecutionPlan } from "@/lib/dependencies/scheduler";
import {
  filterBuildableTickets,
  getTransitiveDependencies,
  loadProjectGraph,
} from "@/lib/dependencies/validation";
import {
  countPlanStatuses,
  runExecutionWaves,
  type WaveSkippedTicket,
  type WaveTicketResult,
} from "@/lib/dependencies/wave-runner";
import { dagBatchRegistry } from "@/lib/agents/dag-batch-registry";
import { logTransition } from "@/lib/workflow/log";
import { createDagWaveOutcomeNotification } from "@/lib/notifications/create";
import { listPipelineRunsByProject } from "@/lib/pipeline";
import { isPipelineRunActive } from "@/lib/pipeline/constants";
import { NIGHT_RUN_ID_PREFIX } from "@/lib/night/constants";
import { nightRunRegistry } from "@/lib/night/registry";
import { startNightRun } from "@/lib/night/run";
import { providerAcceptsAssignedSessionId } from "@/lib/agent-sessions/resume-capability";
import {
  finalizeBuildTerminalOutcome,
  holdFailedBuild,
  pullTicketBackIfPromoted,
  resolveBuildSessionResult,
  transitionBuildStarted,
  WorkflowTransitionError,
} from "@/lib/workflow/automatic-transitions";

/**
 * Batch build options (everything except `epicIds`, which keeps its
 * historical bespoke check and error message). `failurePolicy` only matters
 * in "dag" mode:
 *   - "halt" (default): a blocked epic skips its dependents, but independent
 *     branches keep building.
 *   - "stop": abandon all remaining waves after the first blocked wave.
 *
 * `pipeline: true` is only legal with mode "dag" and turns the batch into a
 * NIGHT RUN: every epic runs the full autonomous pipeline, waves settle at
 * pipeline terminal, and the breaker/cost-cap overrides apply (see
 * lib/night). The pipeline_enabled setting is deliberately ignored here —
 * the explicit request flag is the only trigger.
 */
const batchBuildOptionsSchema = z.object({
  mode: z.enum(["sequential", "parallel", "dag"]).default("parallel"),
  team: z.boolean().default(false),
  namedAgentId: z.string().nullable().default(null),
  failurePolicy: z.enum(["halt", "stop"]).default("halt"),
  pipeline: z.boolean().default(false),
  circuitBreaker: z.number().int().min(0).max(10).optional(),
  costCapUsd: z.number().positive().optional(),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const { projectId } = await params;
  const body = await request.json().catch(() => null);
  const { epicIds } = (body ?? {}) as { epicIds?: string[] };

  if (!epicIds || !Array.isArray(epicIds) || epicIds.length === 0) {
    return NextResponse.json(
      { error: "epicIds array is required" },
      { status: 400 }
    );
  }

  const parsedOptions = batchBuildOptionsSchema.safeParse(body ?? {});
  if (!parsedOptions.success) {
    return NextResponse.json(
      {
        error: "Validation failed",
        details: parsedOptions.error.flatten().fieldErrors,
      },
      { status: 400 }
    );
  }
  const {
    mode,
    team,
    namedAgentId,
    failurePolicy,
    pipeline,
    circuitBreaker,
    costCapUsd,
  } = parsedOptions.data;

  // Pipelines compose with the wave engine only: each epic's ticket settles
  // at PIPELINE terminal, so dependency ordering stays meaningful. The flat
  // batch modes have no blocking semantics to hang a pipeline on.
  if (pipeline && mode !== "dag") {
    return NextResponse.json(
      { error: "Pipeline batch builds run as dependency waves — use mode 'dag'" },
      { status: 400 }
    );
  }

  if (team && mode === "dag") {
    return NextResponse.json(
      { error: "Team mode cannot be combined with wave (dag) mode" },
      { status: 400 }
    );
  }

  // DAG mode plans over the full dependency closure: the client auto-includes
  // prerequisites too, but the server re-expands so the waves are complete
  // even for direct API callers. The closure already stops at done/released
  // prerequisites (they are satisfied, not work).
  const targetEpicIds =
    mode === "dag"
      ? Array.from(getTransitiveDependencies(projectId, epicIds))
      : epicIds;

  // Conflict check up-front so batch launches fail fast with a deterministic payload.
  for (const epicId of targetEpicIds) {
    const conflict = getRunningSessionForTarget({
      scope: "epic",
      projectId,
      epicId,
    });
    if (conflict) {
      return NextResponse.json(
        createAgentAlreadyRunningPayload(
          { scope: "epic", projectId, epicId },
          conflict,
          "Another agent is already running for this epic."
        ),
        { status: 409 }
      );
    }
  }

  // Team mode is Claude Code exclusive — no sub-agent delegation outside Claude today.
  const resolvedTeamCheck = resolveAgentByNamedId("team_build", projectId, namedAgentId);
  if (team && resolvedTeamCheck.provider !== "claude-code") {
    return NextResponse.json(
      { error: "Team mode is only available with Claude Code. Other providers do not support sub-agent delegation." },
      { status: 400 }
    );
  }

  const project = db
    .select()
    .from(projects)
    .where(eq(projects.id, projectId))
    .get();
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  if (!project.gitRepoPath) {
    return NextResponse.json(
      { error: "Project has no git repository configured" },
      { status: 400 }
    );
  }

  const gitRepoPath = project.gitRepoPath;
  // Captured alongside gitRepoPath: the closures below outlive the narrowing
  // TypeScript does on `project` here.
  const projectDefaultBranch = project.defaultBranch;

  const isRepo = await isGitRepo(gitRepoPath);
  if (!isRepo) {
    return NextResponse.json(
      { error: `Path is not a git repository: ${gitRepoPath}` },
      { status: 400 }
    );
  }

  // Load project context
  const buildSystemPrompt = await resolveAgentPrompt("build", projectId);
  const teamBuildSystemPrompt = await resolveAgentPrompt(
    "team_build",
    projectId
  );

  const sessionsCreated: string[] = [];
  const projectRef = project;

  // -----------------------------------------------------------------------
  // TEAM MODE — single CC session managing multiple epics via Task tool
  // -----------------------------------------------------------------------
  if (team) {
    try {
      const resolvedTeamAgent = resolveAgentByNamedId(
        "team_build",
        projectId,
        namedAgentId
      );
      if (resolvedTeamAgent.provider !== "claude-code") {
        return NextResponse.json(
          { error: "Team mode is only available with Claude Code." },
          { status: 400 }
        );
      }

      const sessionId = createId();
      // Validate every ticket before the first move. A guard failure on one
      // epic must not leave earlier epics in_progress without the shared
      // team session.
      for (const epicId of epicIds) {
        transitionBuildStarted({
          projectId,
          epicId,
          scope: "epic",
          sessionId,
          reason: "Team build agent started",
          validateOnly: true,
        });
      }

      // Pre-create all worktrees
      const teamEpics: TeamEpic[] = [];
      const epicRecords: Array<{ id: string; branchName: string }> = [];

      for (const epicId of epicIds) {
        const epic = db.select().from(epics).where(eq(epics.id, epicId)).get();
        if (!epic) continue;

        const us = db
          .select()
          .from(userStories)
          .where(eq(userStories.epicId, epicId))
          .orderBy(userStories.position)
          .all();

        const { worktreePath, branchName } = await createWorktree(
          gitRepoPath,
          epic.id,
          epic.title,
          { defaultBranch: projectDefaultBranch }
        );

        teamEpics.push({
          title: epic.title,
          description: epic.description,
          worktreePath,
          userStories: us,
          // A bug batched into a team build carries its screenshots like any
          // other dispatch; solo mode gets them by passing the row whole.
          projectId: epic.projectId,
          images: epic.images,
        });

        epicRecords.push({ id: epicId, branchName });

        const now = new Date().toISOString();
        transitionBuildStarted({
          projectId,
          epicId,
          scope: "epic",
          sessionId,
          reason: "Team build agent started",
        });
        db.update(epics)
          .set({ branchName, updatedAt: now })
          .where(eq(epics.id, epicId))
          .run();
      }

      // Build team prompt
      const prompt = buildTeamBuildPrompt(
        projectRef,
        [],
        teamEpics,
        teamBuildSystemPrompt
      );
      // No document mentions to resolve: the batch prompt carries no
      // user-written text — epic and story fields are generated content, and
      // an agent's `@some/file.ts` points at the project's codebase, not Docs.
      const enrichedTeamPrompt = prompt;
      // Create single team session
      const now = new Date().toISOString();
      const logsDir = path.join(process.cwd(), "data", "sessions", sessionId);
      fs.mkdirSync(logsDir, { recursive: true });
      const logsPath = path.join(logsDir, "logs.json");

      const teamCliSessionId = providerAcceptsAssignedSessionId(
        resolvedTeamAgent.provider,
      )
        ? crypto.randomUUID()
        : undefined;

      createQueuedSession({
        id: sessionId,
        projectId,
        mode: "code",
        orchestrationMode: "team",
        provider: resolvedTeamAgent.provider,
        prompt: enrichedTeamPrompt,
        logsPath,
        cliSessionId: teamCliSessionId,
        namedAgentId: resolvedTeamAgent.namedAgentId ?? null,
        agentType: "team_build",
        namedAgentName: resolvedTeamAgent.name || null,
        model: resolvedTeamAgent.model || null,
        createdAt: now,
      });

      // Update project status
      db.update(projects)
        .set({ status: "building", updatedAt: now })
        .where(eq(projects.id, projectId))
        .run();

      // Scheduled team launch: one slot for the whole coordinating session.
      // Spawns a single CC session from main repo root with Task in
      // allowedTools, waits for completion, updates all epic statuses.
      const allEpicIds = epicRecords.map((e) => e.id);
      agentScheduler.submit(projectId, sessionId, async () => {
        markSessionRunning(sessionId);
        processManager.start(sessionId, {
          mode: "code",
          prompt: enrichedTeamPrompt,
          cwd: gitRepoPath,
          allowedTools: [
            "Edit",
            "Write",
            "Bash",
            "Read",
            "Glob",
            "Grep",
            "Task",
          ],
          model: resolvedTeamAgent.model,
          cliSessionId: teamCliSessionId,
        }, resolvedTeamAgent.provider);

        const info = await waitForProcessCompletion(sessionId);

        const completedAt = new Date().toISOString();
        const result = info?.result;

        try {
          fs.writeFileSync(logsPath, JSON.stringify(result, null, 2));
        } catch {
          // ignore
        }

        const outcome = classifySessionOutcome(result, sessionId);

        try {
          markSessionTerminal(
            sessionId,
            {
              success: !!result?.success,
              error: result?.error || null,
              outcome,
              usage: extractSessionUsage(result),
            },
            completedAt
          );
        } catch (error) {
          if (!isSessionLifecycleConflictError(error)) {
            console.error("[build/team] Failed to finalize session", error);
          }
        }

        // Update all associated epics unless the agent ended by asking a question.
        if (result?.success && outcome !== "asked_question") {
          for (const eid of allEpicIds) {
            finalizeBuildTerminalOutcome({
              projectId,
              epicId: eid,
              scope: "epic",
              sessionId,
              success: true,
              outcome,
              reason: "Team build completed successfully",
            });
          }
        } else if (result?.success) {
          // asked_question: the work is not delivered, so a coordinated epic
          // the agent promoted to Review mid-run comes back first; then hold
          // every coordinated epic, notify once, and log on each feed. Each
          // epic is logged with the status its own pullback actually left it
          // in — a coordinated set can straddle several columns, so one
          // shared guess would put a false hold entry on the others.
          const heldStatusByEpicId: Record<string, string> = {};
          for (const eid of allEpicIds) {
            heldStatusByEpicId[eid] = pullTicketBackIfPromoted({
              projectId,
              epicId: eid,
              scope: "epic",
              sessionId,
              reason:
                "The team build ended with an open question; returning ticket to in_progress",
            });
          }
          handleAskedQuestionOutcome({
            projectId,
            epicIds: allEpicIds,
            sessionId,
            ticketStatusByEpicId: heldStatusByEpicId,
          });
        } else {
          for (const eid of allEpicIds) {
            holdFailedBuild({
              projectId,
              epicId: eid,
              sessionId,
              error: result?.error,
            });
          }
        }

        // Post output as comment on each epic
        const teamOutput = resolveSessionOutput(result, sessionId);

        for (const eid of allEpicIds) {
          db.insert(ticketComments)
            .values({
              id: createId(),
              epicId: eid,
              author: "agent",
              content: teamOutput,
              agentSessionId: sessionId,
              createdAt: completedAt,
            })
            .run();
        }
      });

      sessionsCreated.push(sessionId);
      tryExportArjiJson(projectId);

      return NextResponse.json({
        data: {
          sessions: sessionsCreated,
          count: sessionsCreated.length,
          orchestrationMode: "team",
        },
      });
    } catch (e) {
      return NextResponse.json(
        { error: e instanceof Error ? e.message : "Team build launch failed" },
        { status: e instanceof WorkflowTransitionError ? 409 : 500 }
      );
    }
  }

  // Batch/night run tag stamped on every session this request creates
  // (agent_sessions.batch_run_id). Set by the dag branch (plain batches get
  // their batchId, night runs their night_ runId); sequential/parallel
  // dispatches stay untagged.
  let currentBatchRunId: string | null = null;

  // -----------------------------------------------------------------------
  // SOLO MODE — one session per epic (existing behavior). DAG mode reuses
  // this launcher wave by wave; the returned `settled` promise resolves when
  // the session reaches a terminal state (it never rejects).
  // -----------------------------------------------------------------------
  async function launchEpic(
    epicId: string
  ): Promise<
    { sessionId: string; settled: Promise<WaveTicketResult> } | undefined
  > {
    const epic = db.select().from(epics).where(eq(epics.id, epicId)).get();
    if (!epic) return;

    const us = db
      .select()
      .from(userStories)
      .where(eq(userStories.epicId, epicId))
      .orderBy(userStories.position)
      .all();

    // Create worktree + branch
    const { worktreePath, branchName } = await createWorktree(
      gitRepoPath,
      epic.id,
      epic.title,
      { defaultBranch: projectDefaultBranch }
    );

    // Compose prompt
    const prompt = buildBuildPrompt(
      projectRef,
      [],
      epic,
      us,
      buildSystemPrompt
    );
    // Same as team mode: nothing user-written to resolve mentions from.
    const enrichedPrompt = prompt;
    const resolvedBuildAgent = resolveAgentByNamedId("build", projectId, namedAgentId);

    // Create session in DB
    const sessionId = createId();
    const now = new Date().toISOString();
    const logsDir = path.join(process.cwd(), "data", "sessions", sessionId);
    fs.mkdirSync(logsDir, { recursive: true });
    const logsPath = path.join(logsDir, "logs.json");

    // Check concurrency guard first
    const conflict = getRunningSessionForTarget({
      scope: "epic",
      projectId,
      epicId,
    });
    if (conflict) {
      throw createAgentAlreadyRunningPayload(
        { scope: "epic", projectId, epicId },
        conflict,
        "Another agent is already running for this epic."
      );
    }

    const soloCliSessionId = providerAcceptsAssignedSessionId(
      resolvedBuildAgent.provider,
    )
      ? crypto.randomUUID()
      : undefined;

    transitionBuildStarted({
      projectId,
      epicId,
      scope: "epic",
      sessionId,
    });
    db.update(epics)
      .set({ branchName, updatedAt: now })
      .where(eq(epics.id, epicId))
      .run();

    createQueuedSession({
      id: sessionId,
      projectId,
      epicId,
      mode: "code",
      orchestrationMode: "solo",
      provider: resolvedBuildAgent.provider,
      prompt: enrichedPrompt,
      logsPath,
      branchName,
      worktreePath,
      cliSessionId: soloCliSessionId,
      namedAgentId: resolvedBuildAgent.namedAgentId ?? null,
      agentType: "build",
      namedAgentName: resolvedBuildAgent.name || null,
      model: resolvedBuildAgent.model || null,
      batchRunId: currentBatchRunId,
      createdAt: now,
    });

    // Update project status to building
    db.update(projects)
      .set({ status: "building", updatedAt: now })
      .where(eq(projects.id, projectId))
      .run();

    // Launch closure body: spawns the agent, waits for completion, and
    // updates the DB. Submitted to the per-project scheduler below — a batch
    // of N epics enqueues N sessions but only maxConcurrent CLIs run at once.
    const runBuildSession = async () => {
      markSessionRunning(sessionId);
      processManager.start(sessionId, {
        mode: "code",
        prompt: enrichedPrompt,
        cwd: worktreePath,
        allowedTools: ["Edit", "Write", "Bash", "Read", "Glob", "Grep"],
        model: resolvedBuildAgent.model,
        cliSessionId: soloCliSessionId,
      }, resolvedBuildAgent.provider);

      const info = await waitForProcessCompletion(sessionId);

      const completedAt = new Date().toISOString();
      const result = info?.result;

      try {
        fs.writeFileSync(logsPath, JSON.stringify(result, null, 2));
      } catch {
        // ignore
      }

      const outcome = classifySessionOutcome(result, sessionId);

      try {
        markSessionTerminal(
          sessionId,
          {
            success: !!result?.success,
            error: result?.error || null,
            outcome,
            usage: extractSessionUsage(result),
          },
          completedAt
        );
      } catch (error) {
        if (!isSessionLifecycleConflictError(error)) {
          console.error("[build/solo] Failed to finalize session", error);
        }
      }

      const terminal = finalizeBuildTerminalOutcome({
        projectId,
        epicId,
        scope: "epic",
        sessionId,
        success: !!result?.success,
        outcome,
        error: result?.error,
      });

      // Post output as epic comment
      const output = resolveSessionOutput(result, sessionId);

      db.insert(ticketComments)
        .values({
          id: createId(),
          epicId,
          author: "agent",
          content: output,
          agentSessionId: sessionId,
          createdAt: completedAt,
        })
        .run();

      return resolveBuildSessionResult(terminal, {
        success: !!result?.success,
        outcome,
        error: result?.error ?? null,
      });
    };

    // Settlement signal for the wave engine (and any future caller that
    // needs to await terminal state). Resolved — never rejected — so
    // `Promise.all` over a wave cannot bail early.
    let settleLaunch!: (result: WaveTicketResult) => void;
    const settled = new Promise<WaveTicketResult>((resolve) => {
      settleLaunch = resolve;
    });

    agentScheduler.submit(projectId, sessionId, async () => {
      try {
        settleLaunch({ epicId, sessionId, ...(await runBuildSession()) });
      } catch (error) {
        // The scheduler's safety net finalizes the session row; the wave
        // engine only needs to know this ticket settled as failed.
        settleLaunch({
          epicId,
          sessionId,
          success: false,
          outcome: "error",
          error:
            error instanceof Error ? error.message : "Agent launch failed",
        });
        throw error;
      }
    });

    sessionsCreated.push(sessionId);
    return { sessionId, settled };
  }

  // -----------------------------------------------------------------------
  // DAG MODE — dependency-ordered waves over the full closure.
  // Wave N launches through the scheduler (budget still throttles CLIs),
  // the engine waits for every session to settle, then wave N+1 starts.
  // Blocked epics (failed session or asked_question) skip their transitive
  // dependents: no session, an activity-log entry, and a wave notification.
  // -----------------------------------------------------------------------
  if (mode === "dag") {
    try {
      // A done/released epic explicitly named in the selection is dropped
      // here: it is already delivered, so it gets no wave, no session, and
      // (being absent from the plan) never blocks a dependent — a dependent
      // whose only prerequisites are done therefore lands in wave 1.
      const buildableEpicIds = filterBuildableTickets(projectId, targetEpicIds);
      if (buildableEpicIds.length === 0) {
        return NextResponse.json(
          {
            error:
              "No buildable epics in the selection — every ticket is already done or released",
          },
          { status: 400 }
        );
      }

      const plan = buildExecutionPlan(projectId, buildableEpicIds);
      const graph = loadProjectGraph(projectId);
      const totalWaves = plan.layers.length;

      // -------------------------------------------------------------------
      // NIGHT SEMANTICS — dag + pipeline. Guards run synchronously between
      // the plan build and startNightRun (which registers the run before
      // returning), so the double-POST race window is a single sync block.
      // Conflicting work is REFUSED, never queued. Plain dag batches get
      // none of these guards (behavior preserved).
      // -------------------------------------------------------------------
      if (pipeline) {
        if (nightRunRegistry.getActiveByProject(projectId)) {
          return NextResponse.json(
            {
              error: "A night run is already active for this project",
              code: "NIGHT_RUN_ACTIVE",
            },
            { status: 409 }
          );
        }
        if (dagBatchRegistry.listByProject(projectId).length > 0) {
          return NextResponse.json(
            {
              error:
                "A wave batch build is already running for this project",
              code: "BATCH_ACTIVE",
            },
            { status: 409 }
          );
        }
        const buildableSet = new Set(buildableEpicIds);
        const activePipeline = listPipelineRunsByProject(projectId).find(
          (run) => isPipelineRunActive(run.state) && buildableSet.has(run.epicId)
        );
        if (activePipeline) {
          return NextResponse.json(
            {
              error:
                "An autonomous pipeline is already running on an epic in the selection",
              code: "PIPELINE_ACTIVE_ON_EPIC",
            },
            { status: 409 }
          );
        }

        const nightRunId = `${NIGHT_RUN_ID_PREFIX}${createId()}`;
        currentBatchRunId = nightRunId;

        const { firstWaveLaunched, engineDone } = startNightRun({
          projectId,
          runId: nightRunId,
          plan,
          graph,
          failurePolicy,
          namedAgentId,
          breakerThreshold: circuitBreaker ?? null,
          costCapUsd: costCapUsd ?? null,
          launchBuild: async (epicId) => (await launchEpic(epicId)) ?? null,
        });

        const firstWaveSessions = await Promise.race([
          firstWaveLaunched,
          engineDone.then(() => [] as string[]),
        ]);

        tryExportArjiJson(projectId);
        return NextResponse.json({
          data: {
            sessions: firstWaveSessions,
            count: firstWaveSessions.length,
            orchestrationMode: "dag",
            batchId: nightRunId,
            waves: totalWaves,
            totalEpics: buildableEpicIds.length,
            failurePolicy,
            pipeline: true,
          },
        });
      }

      const batchId = createId();
      // Retroactive benefit: plain DAG batches tag their sessions too.
      currentBatchRunId = batchId;

      dagBatchRegistry.start({
        batchId,
        projectId,
        failurePolicy,
        totalWaves,
        totalEpics: buildableEpicIds.length,
      });

      const skipReason = (skip: WaveSkippedTicket): string => {
        if (skip.kind === "stopped") {
          return `skipped: batch stopped after wave ${skip.wave} failure`;
        }
        const blocker = skip.blockedById
          ? db
              .select({ readableId: epics.readableId, title: epics.title })
              .from(epics)
              .where(eq(epics.id, skip.blockedById))
              .get()
          : null;
        const ref =
          blocker?.readableId || blocker?.title || skip.blockedById || "unknown";
        return skip.kind === "failed"
          ? `skipped: dependency ${ref} failed`
          : `skipped: dependency ${ref} asked a question`;
      };

      // Resolves once the first wave's launches are submitted, so the HTTP
      // response can report the initial sessions while later waves keep
      // running in the background.
      let resolveFirstWave!: (sessionIds: string[]) => void;
      let firstWaveResolved = false;
      const firstWaveLaunched = new Promise<string[]>((resolve) => {
        resolveFirstWave = resolve;
      });

      const engineRun = runExecutionWaves({
        plan,
        graph,
        failurePolicy,
        launch: async (epicId) => (await launchEpic(epicId)) ?? null,
        callbacks: {
          onWaveStart: (wave) => {
            dagBatchRegistry.setWave(batchId, wave);
            dagBatchRegistry.setCounts(batchId, countPlanStatuses(plan));
          },
          onWaveLaunched: (_wave, sessionIds) => {
            if (!firstWaveResolved) {
              firstWaveResolved = true;
              resolveFirstWave(sessionIds);
            }
          },
          onWaveSettled: () => {
            dagBatchRegistry.setCounts(batchId, countPlanStatuses(plan));
          },
          onSkip: (skip) => {
            // The skipped ticket never moves — log the decision so the board
            // history answers "why didn't this build?".
            try {
              const held = db
                .select({ status: epics.status })
                .from(epics)
                .where(eq(epics.id, skip.epicId))
                .get();
              const heldStatus = held?.status ?? "backlog";
              logTransition({
                projectId,
                epicId: skip.epicId,
                fromStatus: heldStatus,
                toStatus: heldStatus,
                actor: "system",
                reason: skipReason(skip),
                sessionId: skip.blockedBySessionId ?? undefined,
              });
            } catch (error) {
              console.warn(
                `[build/dag] Failed to log skip for epic ${skip.epicId}`,
                error
              );
            }
          },
          onWaveBlocked: (wave, blocked, waveSkipped) => {
            // Dedupe: a wave blocked *solely* by questions that skipped
            // nothing adds no information — handleAskedQuestionOutcome
            // already raised the per-session "Agent asked a question"
            // notification for each blocker. A failure, or any actually
            // skipped dependent, still deserves the wave summary.
            const onlyUnblockingQuestions =
              blocked.every((b: WaveTicketResult) => b.success) &&
              waveSkipped.length === 0;
            if (onlyUnblockingQuestions) return;

            try {
              createDagWaveOutcomeNotification({
                projectId,
                wave,
                totalWaves,
                blocked: blocked.map((b: WaveTicketResult) => ({
                  epicId: b.epicId,
                  kind: b.success ? ("asked_question" as const) : ("failed" as const),
                })),
                skippedCount: waveSkipped.length,
                stopped: failurePolicy === "stop",
              });
            } catch (error) {
              console.warn(
                "[build/dag] Failed to create wave notification",
                error
              );
            }
          },
          onFinish: () => {
            dagBatchRegistry.setCounts(batchId, countPlanStatuses(plan));
            dagBatchRegistry.finish(batchId);
          },
        },
      });

      // The engine outlives this request — waves 2+ launch after the
      // response. Launch failures become wave results, so a rejection here
      // is an engine bug, not a build failure.
      const engineSafe = engineRun.catch((error) => {
        console.error("[build/dag] Wave engine crashed", error);
        dagBatchRegistry.finish(batchId);
        return null;
      });

      const firstWaveSessions = await Promise.race([
        firstWaveLaunched,
        engineSafe.then(() => [] as string[]),
      ]);

      tryExportArjiJson(projectId);
      return NextResponse.json({
        data: {
          sessions: firstWaveSessions,
          count: firstWaveSessions.length,
          orchestrationMode: "dag",
          batchId,
          waves: totalWaves,
          totalEpics: buildableEpicIds.length,
          failurePolicy,
        },
      });
    } catch (e) {
      // Synchronous planning failures only — per-epic launch errors inside
      // waves are handled by the engine.
      return NextResponse.json(
        { error: e instanceof Error ? e.message : "Wave build launch failed" },
        { status: 500 }
      );
    }
  }

  try {
    if (mode === "sequential") {
      for (const epicId of epicIds) {
        await launchEpic(epicId);
      }
    } else {
      await Promise.all(epicIds.map(launchEpic));
    }

    tryExportArjiJson(projectId);
    return NextResponse.json({
      data: {
        sessions: sessionsCreated,
        count: sessionsCreated.length,
        orchestrationMode: "solo",
      },
    });
  } catch (e) {
    if (
      e &&
      typeof e === "object" &&
      "code" in e &&
      (e as { code?: string }).code === "AGENT_ALREADY_RUNNING"
    ) {
      return NextResponse.json(e, { status: 409 });
    }
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Build launch failed" },
      { status: 500 }
    );
  }
}
