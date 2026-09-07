/** Real resolver, stage driver, grader dispatcher and migrated session writes.
 * Git, scheduling, prompt assembly and process execution are stubs; no CLI runs.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", async () => {
  const { createTestDb } = await import("@/lib/db/test-utils");
  return { ...createTestDb(), ensureDbReady: vi.fn() };
});
vi.mock("@/lib/git/manager", () => ({
  createWorktree: vi.fn(async () => ({
    worktreePath: "/tmp/grading-composite-worktree",
    branchName: "feature/grading-composite",
  })),
  isGitRepo: vi.fn(async () => true),
}));
vi.mock("@/lib/tokens", () => ({
  assembleGradingPrompt: vi.fn(async () => ({
    prompt: "Grade the rubric.", tokens: { total: 5, breakdown: {} },
  })),
}));
vi.mock("@/lib/agents/scheduler", () => ({
  agentScheduler: { submit: vi.fn() },
}));
vi.mock("@/lib/claude/process-manager", () => ({
  processManager: { start: vi.fn() },
}));
vi.mock("@/lib/agent-sessions/wait-for-completion", () => ({
  waitForProcessCompletion: vi.fn(async () => ({
    result: { success: false, error: "Grader unavailable", messages: [] },
  })),
}));
vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return { ...actual, default: {
    ...actual, mkdirSync: vi.fn(), writeFileSync: vi.fn(),
  } };
});

import { sqlite } from "@/lib/db";
import { agentScheduler } from "@/lib/agents/scheduler";
import { processManager } from "@/lib/claude/process-manager";
import { createPipelineStageDriver } from "@/lib/pipeline/stages";
import { runPipeline, type PipelineStageRequest } from "@/lib/pipeline/runner";
import { logTransition } from "@/lib/workflow/log";

function driver() {
  return createPipelineStageDriver({
    projectId: "p", epicId: "e", scope: "epic", userStoryId: null,
    buildNamedAgentId: null,
    // An explicit reviewer must not override the independent grading role.
    reviewNamedAgentId: "rc",
  });
}

function request(attempt: number): PipelineStageRequest {
  return {
    stage: "grading", attempt, fixCycle: 0,
    previousAttemptSessionId: null, lastCodeSessionId: null,
  };
}

function session(id: string | null) {
  return sqlite.prepare(`SELECT named_agent_id, composite_agent_id, provider,
    model, agent_type FROM agent_sessions WHERE id = ?`).get(id);
}

async function finishQueued() {
  const calls = vi.mocked(agentScheduler.submit).mock.calls;
  await calls[calls.length - 1][2]();
}

beforeEach(() => {
  vi.clearAllMocks();
  sqlite.exec(`
    DELETE FROM projects; DELETE FROM agent_provider_defaults;
    DELETE FROM composite_agent_members; DELETE FROM named_agents; DELETE FROM settings;
    INSERT INTO projects(id,name,git_repo_path) VALUES('p','Project','/tmp/grading-repo');
    INSERT INTO epics(id,project_id,title,status) VALUES('e','p','Epic','review');
    INSERT INTO user_stories(id,epic_id,title,status,acceptance_criteria)
      VALUES('s','e','Story','review','The flow works');
    INSERT INTO named_agents(id,name,provider,model,kind) VALUES
      ('g1','First grader','codex','model-one','simple'),
      ('g2','Second grader','agy','model-two','simple'),
      ('g3','Third reviewer','claude-code','opus','simple'),
      ('gc','Grading ladder','composite','','composite'),
      ('rc','Review ladder','composite','','composite');
    INSERT INTO composite_agent_members(id,composite_id,member_id,position) VALUES
      ('gm1','gc','g1',0),('gm2','gc','g2',1),
      ('rm1','rc','g1',0),('rm2','rc','g2',1),('rm3','rc','g3',2);
    INSERT INTO agent_provider_defaults(id,agent_type,provider,scope,named_agent_id) VALUES
      ('gd','grading','codex','global','gc'),
      ('rd','review_code','codex','global','rc');
  `);
});

describe("pipeline grading composite", () => {
  it("sizes grading from its own role rather than the larger explicit review composite", async () => {
    const stages = driver();
    expect(await stages.attemptBudget("review", 5)).toBe(3);
    expect(await stages.attemptBudget("grading", 5)).toBe(2);
  });

  it("dispatches ordered members with both IDs, provider/model and descent metadata", async () => {
    const stages = driver();
    await stages.attemptBudget("grading", 5);
    for (const attempt of [1, 2]) {
      const handle = await stages.launchStage(request(attempt));
      expect(session(handle.sessionId)).toEqual({
        named_agent_id: `g${attempt}`, composite_agent_id: "gc",
        provider: attempt === 1 ? "codex" : "agy",
        model: attempt === 1 ? "model-one" : "model-two", agent_type: "grading",
      });
      expect(handle.compositeDescent).toEqual(attempt === 1 ? null : {
        from: "First grader", to: "Second grader",
      });
      await finishQueued();
      await expect(handle.settled).resolves.toMatchObject({ success: false });
      expect(processManager.start).toHaveBeenLastCalledWith(
        handle.sessionId,
        expect.objectContaining({ model: attempt === 1 ? "model-one" : "model-two" }),
        attempt === 1 ? "codex" : "agy",
      );
    }
  });

  it("pins a project-scoped simple grader for every attempt of a stage entry", async () => {
    sqlite.exec(`INSERT INTO agent_provider_defaults(id,agent_type,provider,scope,named_agent_id)
      VALUES('pgd','grading','agy','p','g2')`);
    const stages = driver();
    expect(await stages.attemptBudget("grading", 4)).toBe(4);
    // Changing the role after sizing must not change the in-flight ladder.
    sqlite.exec("UPDATE agent_provider_defaults SET named_agent_id = 'gc' WHERE id = 'pgd'");
    for (const attempt of [1, 2, 3, 4]) {
      const handle = await stages.launchStage(request(attempt));
      expect(session(handle.sessionId)).toMatchObject({
        named_agent_id: "g2", composite_agent_id: null,
      });
      expect(handle.compositeDescent).toBeNull();
      await finishQueued();
      await handle.settled;
    }
    expect(await stages.attemptBudget("grading", 4)).toBe(2);
  });

  it("exhausts the grading list and persists an activity trace naming both members and the failure", async () => {
    const stages = driver();
    const forensic = vi.fn(async () => ({ sessionId: null, settled: Promise.resolve({
      sessionId: "", success: true, outcome: "answered", error: null,
    }) }));
    const summary = await runPipeline({
      maxAttempts: 5, maxFixCycles: 2, maxSessions: 12, gradingEnabled: true,
      initialBuild: { sessionId: "initial-build", settled: Promise.resolve({
        sessionId: "initial-build", success: true, outcome: "answered", error: null,
      }) },
      attemptBudget: (stage) => stages.attemptBudget(stage, 5),
      launchStage: async (next) => {
        const handle = await stages.launchStage(next);
        await finishQueued();
        return handle;
      },
      assessReview: stages.assessReview,
      readSessionStatus: stages.readSessionStatus,
      checkGuards: stages.checkGuards,
      runForensic: forensic,
      callbacks: { onTrace: (reason, sessionId) => logTransition({
        projectId: "p", epicId: "e", fromStatus: "review", toStatus: "review",
        actor: "system", reason, sessionId: sessionId ?? undefined,
      }) },
    });
    expect(summary).toMatchObject({ state: "failed" });
    expect(agentScheduler.submit).toHaveBeenCalledTimes(2);
    expect(forensic).toHaveBeenCalledWith(expect.objectContaining({ stage: "grading", attempts: 2 }));
    const reasons = sqlite.prepare("SELECT reason FROM ticket_activity_log WHERE epic_id = 'e'")
      .all() as { reason: string }[];
    expect(reasons.some(({ reason }) => reason.includes("First grader") &&
      reason.includes("Second grader") && reason.includes("failed"))).toBe(true);
  });

  it("keeps rubric-free grading a journalled skip without resolving a retry member", async () => {
    const stages = driver();
    await stages.attemptBudget("grading", 5);
    sqlite.exec("UPDATE user_stories SET acceptance_criteria = NULL");
    const handle = await stages.launchStage(request(3));
    await expect(handle.settled).resolves.toMatchObject({
      success: true, gradingSkipped: true,
    });
    expect(handle.sessionId).toBeNull();
    expect(handle.compositeDescent).toBeNull();
    expect(agentScheduler.submit).not.toHaveBeenCalled();
    expect(sqlite.prepare("SELECT reason FROM ticket_activity_log WHERE epic_id = 'e'").get())
      .toEqual({ reason: "Grading skipped — no user story has acceptance criteria." });
  });
});
