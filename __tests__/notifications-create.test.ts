import { describe, it, expect, vi, beforeEach } from "vitest";
import { dbMockState, resetDbMockState } from "@/__tests__/helpers/db-mock";

// ---- Mocks must be hoisted above all imports ----
// Only the raw-sqlite prune helper needs a bespoke stub; the drizzle chain and
// the real @/lib/db/schema come from the shared helpers.
const mockSqliteState = vi.hoisted(() => ({
  pruneCount: { cnt: 5 },
}));

vi.mock("@/lib/db", async () => {
  const { dbModuleMock } = await import("@/__tests__/helpers/db-mock");
  return {
    ...dbModuleMock(),
    sqlite: {
      prepare: vi.fn(() => ({
        get: vi.fn(() => mockSqliteState.pruneCount),
      })),
      exec: vi.fn(),
    },
  };
});

vi.mock("@/lib/utils/nanoid", () => ({
  createId: vi.fn(() => "notif-123"),
}));

import {
  buildTitle,
  buildTargetUrl,
  buildAskedQuestionTitle,
  buildDagWaveOutcomeTitle,
  buildEpicTargetUrl,
  buildStalledTitle,
  createNotificationFromSession,
  createAskedQuestionNotificationFromSession,
  createDagWaveOutcomeNotification,
  createMergeRetryFailedNotification,
  buildUnresolvedMentionsTitle,
  createUnresolvedMentionsNotification,
} from "@/lib/notifications/create";

// ---- Tests ----

describe("buildTitle()", () => {
  it("formats completed build with epic context", () => {
    expect(buildTitle("build", "completed", "Login feature", "E-proj-003")).toBe(
      "Build completed \u2014 E-proj-003: Login feature"
    );
  });

  it("formats failed tech check without epic", () => {
    expect(buildTitle("tech_check", "failed")).toBe("Tech Check failed");
  });

  it("formats completed review with epic title but no readable ID", () => {
    expect(buildTitle("review_code", "completed", "Signup flow", null)).toBe(
      "Review: Code completed \u2014 Signup flow"
    );
  });

  it("uses agent type string when label not found", () => {
    expect(buildTitle("unknown_type", "completed")).toBe("unknown_type completed");
  });

  it("uses 'Agent' when agentType is null", () => {
    expect(buildTitle(null, "failed")).toBe("Agent failed");
  });

  it("formats team build", () => {
    expect(buildTitle("team_build", "completed", "Auth system", "E-auth-001")).toBe(
      "Team Build completed \u2014 E-auth-001: Auth system"
    );
  });
});

describe("buildTargetUrl()", () => {
  it("routes tech_check to QA tab", () => {
    expect(buildTargetUrl("p1", "s1", "tech_check")).toBe("/projects/p1/qa");
  });

  it("routes e2e_test to QA tab", () => {
    expect(buildTargetUrl("p1", "s1", "e2e_test")).toBe("/projects/p1/qa");
  });

  it("routes failure_digest to QA tab", () => {
    expect(buildTargetUrl("p1", "s1", "failure_digest")).toBe(
      "/projects/p1/qa",
    );
  });

  it("routes build to session detail", () => {
    expect(buildTargetUrl("p1", "s1", "build")).toBe("/projects/p1/sessions/s1");
  });

  it("routes review_code to session detail", () => {
    expect(buildTargetUrl("p1", "s1", "review_code")).toBe("/projects/p1/sessions/s1");
  });

  it("routes null agentType to session detail", () => {
    expect(buildTargetUrl("p1", "s1", null)).toBe("/projects/p1/sessions/s1");
  });
});

describe("createNotificationFromSession()", () => {
  beforeEach(() => {
    resetDbMockState();
    mockSqliteState.pruneCount = { cnt: 5 };
  });

  it("creates notification for completed session with epic context", () => {
    dbMockState.getQueue.push(
      undefined, // idempotency check: no message-bearing row for this session yet
      { id: "s1", projectId: "p1", epicId: "e1", status: "completed", agentType: "build" },
      { name: "My Project" },
      { title: "Login feature", readableId: "E-proj-003" }
    );

    createNotificationFromSession("s1");

    expect(dbMockState.insertCalls).toHaveLength(1);
    const payload = dbMockState.insertCalls[0] as Record<string, unknown>;
    expect(payload.id).toBe("notif-123");
    expect(payload.projectId).toBe("p1");
    expect(payload.projectName).toBe("My Project");
    expect(payload.sessionId).toBe("s1");
    expect(payload.agentType).toBe("build");
    expect(payload.status).toBe("completed");
    expect(payload.title).toBe("Build completed \u2014 E-proj-003: Login feature");
    expect(payload.message).toBeNull(); // completed: nothing to explain
    expect(payload.targetUrl).toBe("/projects/p1/sessions/s1");
  });

  it("creates notification for failed session with QA target, carrying the full error", () => {
    dbMockState.getQueue.push(
      undefined, // idempotency check
      {
        id: "s2",
        projectId: "p1",
        epicId: null,
        status: "failed",
        agentType: "tech_check",
        error: "Command exited with code 127: claude: not found",
      },
      { name: "My Project" }
    );

    createNotificationFromSession("s2");

    expect(dbMockState.insertCalls).toHaveLength(1);
    const payload = dbMockState.insertCalls[0] as Record<string, unknown>;
    expect(payload.status).toBe("failed");
    expect(payload.title).toBe("Tech Check failed");
    // The bell must carry the reason, not just the title (AC1).
    expect(payload.message).toBe("Command exited with code 127: claude: not found");
    expect(payload.targetUrl).toBe("/projects/p1/qa");
  });

  it("carries the synthesized no-output message for a silent failure", () => {
    dbMockState.getQueue.push(
      undefined, // idempotency check
      {
        id: "s2b",
        projectId: "p1",
        epicId: null,
        status: "failed",
        agentType: "build",
        error: "The agent session failed without any error message and without any output — the process exited (or was lost) without writing stderr or text.",
      },
      { name: "My Project" }
    );

    createNotificationFromSession("s2b");

    const payload = dbMockState.insertCalls[0] as Record<string, unknown>;
    expect(payload.status).toBe("failed");
    expect(payload.message).toMatch(/failed without any error message and without any output/i);
  });

  it("does nothing when session not found", () => {
    dbMockState.getQueue.push(
      undefined, // idempotency check
      undefined // session lookup
    );

    createNotificationFromSession("missing");

    expect(dbMockState.insertCalls).toHaveLength(0);
  });

  it("does nothing when project not found", () => {
    dbMockState.getQueue.push(
      undefined, // idempotency check
      { id: "s1", projectId: "p-gone", epicId: null, status: "completed", agentType: "build" },
      undefined
    );

    createNotificationFromSession("s1");

    expect(dbMockState.insertCalls).toHaveLength(0);
  });

  it("creates notification without epic context when epicId is null", () => {
    dbMockState.getQueue.push(
      undefined, // idempotency check
      { id: "s3", projectId: "p1", epicId: null, status: "completed", agentType: "review_security" },
      { name: "Security Proj" }
    );

    createNotificationFromSession("s3");

    expect(dbMockState.insertCalls).toHaveLength(1);
    const payload = dbMockState.insertCalls[0] as Record<string, unknown>;
    expect(payload.title).toBe("Review: Security completed");
    expect(payload.projectName).toBe("Security Proj");
  });

  it("skips when a message-bearing notification for the session already exists (hook + route dedup)", () => {
    dbMockState.getQueue.push(
      { id: "existing-notif" } // idempotency check: the terminal hook already created it
    );

    createNotificationFromSession("s10");

    // No second insert, and the session/project lookups are never reached.
    expect(dbMockState.insertCalls).toHaveLength(0);
    expect(dbMockState.getQueue).toHaveLength(0);
  });

  it("is not suppressed by message-less session rows (stalled watchdog, merge-parked, …)", () => {
    dbMockState.getQueue.push(
      undefined, // idempotency check: only the watcher's NULL-message row exists
      {
        id: "s11",
        projectId: "p1",
        epicId: null,
        status: "failed",
        agentType: "build",
        error: "Killed after stall",
      },
      { name: "My Project" }
    );

    createNotificationFromSession("s11");

    expect(dbMockState.insertCalls).toHaveLength(1);
    const payload = dbMockState.insertCalls[0] as Record<string, unknown>;
    expect(payload.message).toBe("Killed after stall");
  });

  it("skips sessions with the asked_question verdict (owned by the question creator)", () => {
    dbMockState.getQueue.push(
      undefined, // idempotency check
      {
        id: "s4",
        projectId: "p1",
        epicId: "e1",
        status: "completed",
        agentType: "build",
        outcome: "asked_question",
      },
      { name: "My Project" },
      { title: "Login feature", readableId: "E-proj-003" }
    );

    createNotificationFromSession("s4");

    expect(dbMockState.insertCalls).toHaveLength(0);
  });
});

describe("buildAskedQuestionTitle()", () => {
  it("uses readable id and title when both exist", () => {
    expect(buildAskedQuestionTitle("Login feature", "E-proj-003")).toBe(
      "Agent asked a question on E-proj-003: Login feature"
    );
  });

  it("falls back to whichever identifier exists", () => {
    expect(buildAskedQuestionTitle("Login feature", null)).toBe(
      "Agent asked a question on Login feature"
    );
    expect(buildAskedQuestionTitle(null, "E-proj-003")).toBe(
      "Agent asked a question on E-proj-003"
    );
  });

  it("degrades to the bare copy without any ticket context", () => {
    expect(buildAskedQuestionTitle(null, null)).toBe("Agent asked a question");
  });
});

describe("buildEpicTargetUrl()", () => {
  it("deep-links to the ticket on the board", () => {
    expect(buildEpicTargetUrl("p1", "e1")).toBe("/projects/p1?ticket=e1");
  });
});

describe("buildStalledTitle()", () => {
  it("uses readable id and title when both exist", () => {
    expect(buildStalledTitle(5, "Login feature", "E-proj-003")).toBe(
      "Agent seems stalled on E-proj-003: Login feature — no output for 5m"
    );
  });

  it("falls back to whichever identifier exists", () => {
    expect(buildStalledTitle(12, "Login feature", null)).toBe(
      "Agent seems stalled on Login feature — no output for 12m"
    );
    expect(buildStalledTitle(12, null, "E-proj-003")).toBe(
      "Agent seems stalled on E-proj-003 — no output for 12m"
    );
  });

  it("degrades to the bare copy without any ticket context", () => {
    expect(buildStalledTitle(7, null, null)).toBe(
      "Agent seems stalled — no output for 7m"
    );
  });
});

describe("createAskedQuestionNotificationFromSession()", () => {
  beforeEach(() => {
    resetDbMockState();
    mockSqliteState.pruneCount = { cnt: 5 };
  });

  it("creates the question notification deep-linking to the epic", () => {
    dbMockState.getQueue.push(
      {
        id: "s5",
        projectId: "p1",
        epicId: "e1",
        status: "completed",
        agentType: "build",
        outcome: "asked_question",
      },
      { name: "My Project" },
      { title: "Login feature", readableId: "E-proj-003" }
    );

    createAskedQuestionNotificationFromSession("s5");

    expect(dbMockState.insertCalls).toHaveLength(1);
    const payload = dbMockState.insertCalls[0] as Record<string, unknown>;
    expect(payload.title).toBe(
      "Agent asked a question on E-proj-003: Login feature"
    );
    expect(payload.targetUrl).toBe("/projects/p1?ticket=e1");
    expect(payload.status).toBe("completed");
    expect(payload.agentType).toBe("build");
  });

  it("falls back to the session detail when the session has no epic", () => {
    dbMockState.getQueue.push(
      {
        id: "s6",
        projectId: "p1",
        epicId: null,
        status: "completed",
        agentType: "team_build",
        outcome: "asked_question",
      },
      { name: "My Project" }
    );

    createAskedQuestionNotificationFromSession("s6");

    expect(dbMockState.insertCalls).toHaveLength(1);
    const payload = dbMockState.insertCalls[0] as Record<string, unknown>;
    expect(payload.title).toBe("Agent asked a question");
    expect(payload.targetUrl).toBe("/projects/p1/sessions/s6");
  });

  it("does nothing when the session is gone", () => {
    dbMockState.getQueue.push(undefined);

    createAskedQuestionNotificationFromSession("missing");

    expect(dbMockState.insertCalls).toHaveLength(0);
  });
});

describe("buildDagWaveOutcomeTitle()", () => {
  const label = (epicId: string) => `E-p-${epicId}`;

  it("names a single failed epic and its skipped dependents", () => {
    expect(
      buildDagWaveOutcomeTitle(
        {
          projectId: "p1",
          wave: 2,
          totalWaves: 4,
          blocked: [{ epicId: "007", kind: "failed" }],
          skippedCount: 2,
          stopped: false,
        },
        label
      )
    ).toBe("Wave 2/4: E-p-007 failed — 2 dependents skipped");
  });

  it("uses the question flavor and singular dependent", () => {
    expect(
      buildDagWaveOutcomeTitle(
        {
          projectId: "p1",
          wave: 1,
          totalWaves: 3,
          blocked: [{ epicId: "001", kind: "asked_question" }],
          skippedCount: 1,
          stopped: false,
        },
        label
      )
    ).toBe("Wave 1/3: E-p-001 asked a question — 1 dependent skipped");
  });

  it("aggregates multiple blocked epics and reports a stopped batch", () => {
    expect(
      buildDagWaveOutcomeTitle(
        {
          projectId: "p1",
          wave: 1,
          totalWaves: 3,
          blocked: [
            { epicId: "001", kind: "failed" },
            { epicId: "002", kind: "asked_question" },
          ],
          skippedCount: 4,
          stopped: true,
        },
        label
      )
    ).toBe("Wave 1/3: 2 epics blocked — batch stopped, 4 tickets skipped");
  });

  it("omits the tail when nothing was skipped", () => {
    expect(
      buildDagWaveOutcomeTitle(
        {
          projectId: "p1",
          wave: 3,
          totalWaves: 3,
          blocked: [{ epicId: "009", kind: "failed" }],
          skippedCount: 0,
          stopped: false,
        },
        label
      )
    ).toBe("Wave 3/3: E-p-009 failed");
  });
});

describe("createDagWaveOutcomeNotification()", () => {
  beforeEach(() => {
    resetDbMockState();
  });

  it("inserts a failed-status notification targeting the board, with the epic's readable id", () => {
    dbMockState.getQueue.push(
      { name: "My Project" }, // project lookup
      { readableId: "E-proj-004", title: "Payments" } // blocked epic lookup
    );

    createDagWaveOutcomeNotification({
      projectId: "p1",
      wave: 1,
      totalWaves: 2,
      blocked: [{ epicId: "e4", kind: "failed" }],
      skippedCount: 1,
      stopped: false,
    });

    expect(dbMockState.insertCalls).toHaveLength(1);
    const payload = dbMockState.insertCalls[0] as Record<string, unknown>;
    expect(payload.title).toBe(
      "Wave 1/2: E-proj-004 failed — 1 dependent skipped"
    );
    expect(payload.status).toBe("failed");
    expect(payload.targetUrl).toBe("/projects/p1");
    expect(payload.sessionId).toBeNull();
    expect(payload.agentType).toBe("build");
  });

  it("uses completed status when the wave blocked only on questions", () => {
    dbMockState.getQueue.push(
      { name: "My Project" },
      { readableId: null, title: "Auth epic" } // falls back to the title
    );

    createDagWaveOutcomeNotification({
      projectId: "p1",
      wave: 2,
      totalWaves: 2,
      blocked: [{ epicId: "e1", kind: "asked_question" }],
      skippedCount: 0,
      stopped: false,
    });

    const payload = dbMockState.insertCalls[0] as Record<string, unknown>;
    expect(payload.status).toBe("completed");
    expect(payload.title).toBe("Wave 2/2: Auth epic asked a question");
  });

  it("does nothing when the project is gone", () => {
    dbMockState.getQueue.push(undefined);

    createDagWaveOutcomeNotification({
      projectId: "gone",
      wave: 1,
      totalWaves: 1,
      blocked: [{ epicId: "e1", kind: "failed" }],
      skippedCount: 0,
      stopped: false,
    });

    expect(dbMockState.insertCalls).toHaveLength(0);
  });
});

describe("unresolved document mentions", () => {
  beforeEach(() => {
    resetDbMockState();
  });

  it("names the agent and every unresolved mention", () => {
    expect(buildUnresolvedMentionsTitle(["spec.md", "UI Mock.png"], "build")).toBe(
      "Build ran without @spec.md, @{UI Mock.png} — no such document in Docs"
    );
  });

  it("inserts one notification pointing at the ticket", () => {
    dbMockState.getQueue.push({ name: "My Project" });

    createUnresolvedMentionsNotification({
      projectId: "p1",
      missing: ["spec.md"],
      agentType: "build",
      targetUrl: "/projects/p1?ticket=e1",
    });

    expect(dbMockState.insertCalls).toHaveLength(1);
    const payload = dbMockState.insertCalls[0] as Record<string, unknown>;
    expect(payload.title).toBe(
      "Build ran without @spec.md — no such document in Docs"
    );
    expect(payload.targetUrl).toBe("/projects/p1?ticket=e1");
    expect(payload.sessionId).toBeNull();
  });

  it("stays silent when every mention resolved", () => {
    createUnresolvedMentionsNotification({
      projectId: "p1",
      missing: [],
      agentType: "build",
      targetUrl: "/projects/p1",
    });

    expect(dbMockState.insertCalls).toHaveLength(0);
  });
});

describe("createMergeRetryFailedNotification()", () => {
  beforeEach(() => {
    resetDbMockState();
  });

  it("inserts a failed-status notification deep-linking to the epic", () => {
    dbMockState.getQueue.push(
      { name: "My Project" }, // project lookup
      { title: "Payments", readableId: "E-proj-004" } // epic lookup
    );

    createMergeRetryFailedNotification({
      projectId: "p1",
      epicId: "e4",
      sessionId: "s9",
      error: "Branch feature/epic-4 contains unresolved conflict markers in: pay.ts",
    });

    expect(dbMockState.insertCalls).toHaveLength(1);
    const payload = dbMockState.insertCalls[0] as Record<string, unknown>;
    expect(payload.title).toBe(
      "Merge-fix agent finished, but the merge still failed for E-proj-004: Payments — Branch feature/epic-4 contains unresolved conflict markers in: pay.ts"
    );
    expect(payload.status).toBe("failed");
    expect(payload.agentType).toBe("merge");
    expect(payload.sessionId).toBe("s9");
    expect(payload.targetUrl).toBe("/projects/p1?ticket=e4");
  });

  it("falls back to the epic id when the epic row is gone", () => {
    dbMockState.getQueue.push({ name: "My Project" }, undefined);

    createMergeRetryFailedNotification({
      projectId: "p1",
      epicId: "e4",
      sessionId: null,
      error: "boom",
    });

    const payload = dbMockState.insertCalls[0] as Record<string, unknown>;
    expect(payload.title).toContain("e4");
    expect(payload.sessionId).toBeNull();
  });

  it("does nothing when the project is gone", () => {
    dbMockState.getQueue.push(undefined);

    createMergeRetryFailedNotification({
      projectId: "p-gone",
      epicId: "e4",
      sessionId: null,
      error: "boom",
    });

    expect(dbMockState.insertCalls).toHaveLength(0);
  });
});
