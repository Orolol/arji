import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

const availabilityState = vi.hoisted(() => ({
  available: new Set<string>(),
}));

const dispatchState = vi.hoisted(() => ({
  launch: null as (() => Promise<void>) | null,
  starts: [] as Array<{
    sessionId: string;
    options: { mode: string; prompt: string; cwd?: string };
    provider: string;
  }>,
  diff: "diff --git a/lib/gate.ts b/lib/gate.ts\n+safe();",
  diffArgs: [] as string[],
}));

vi.mock("@/lib/db", async () => {
  const { createTestDb } = await import("@/lib/db/test-utils");
  const created = createTestDb();
  return { db: created.db, sqlite: created.sqlite, ensureDbReady: vi.fn() };
});

vi.mock("@/lib/providers", () => ({
  getProvider: (type: string) => ({
    isAvailable: async () => availabilityState.available.has(type),
  }),
}));

vi.mock("@/lib/agents/scheduler", () => ({
  agentScheduler: {
    submit: vi.fn(
      (
        _projectId: string,
        _sessionId: string,
        launch: () => Promise<void>
      ) => {
        dispatchState.launch = launch;
        return { started: false, queuedAhead: 0 };
      }
    ),
  },
}));

vi.mock("@/lib/claude/process-manager", () => ({
  processManager: {
    start: vi.fn(
      (sessionId: string, options: { mode: string; prompt: string }, provider: string) => {
        dispatchState.starts.push({ sessionId, options, provider });
        return { sessionId, status: "running" };
      }
    ),
  },
}));

vi.mock("@/lib/agent-sessions/wait-for-completion", () => ({
  waitForProcessCompletion: vi.fn(async () => ({
    result: {
      success: true,
      result: "**Overall Verdict: Approved**",
      duration: 1,
    },
  })),
}));

vi.mock("@/lib/git/manager", () => ({
  attachWorktree: vi.fn(async () => ({ worktreePath: "/repo-worktree" })),
}));

vi.mock("simple-git", () => ({
  default: vi.fn(() => ({
    diff: vi.fn(async (args: string[]) => {
      dispatchState.diffArgs = args;
      return dispatchState.diff;
    }),
  })),
}));

const { db } = await import("@/lib/db");
const {
  agentSessions,
  epics,
  notifications,
  projects,
  reviewComments,
  ticketComments,
  userStories,
} = await import("@/lib/db/schema");
const {
  dispatchSecondOpinion,
  pickSecondOpinionProvider,
  readSecondOpinionState,
} = await import("@/lib/auto-mode/second-opinion");
const { buildSecondOpinionPrompt } = await import(
  "@/lib/claude/prompt-builder"
);
const { createAutoModeSecondOpinionParkedNotification } = await import(
  "@/lib/notifications/create"
);
const { findLastSuccessfulReviewProvider } = await import(
  "@/lib/agent-config/review-segregation"
);

const PROJECT_ID = "p-second";
const EPIC_ID = "e-second";

function at(minute: number): string {
  return new Date(Date.UTC(2026, 7, 25, 10, minute)).toISOString();
}

function seedBase(): void {
  db.insert(projects)
    .values({
      id: PROJECT_ID,
      name: "Second",
      gitRepoPath: "/repo",
      defaultBranch: "develop",
    })
    .run();
  db.insert(epics)
    .values({
      id: EPIC_ID,
      projectId: PROJECT_ID,
      title: "Gate merge",
      readableId: "E-SECOND-001",
      status: "review",
      branchName: "feature/gate",
    })
    .run();
}

function addOrdinaryReview(
  id: string,
  minute: number,
  provider = "codex",
  userStoryId: string | null = null
): void {
  db.insert(agentSessions)
    .values({
      id,
      projectId: PROJECT_ID,
      epicId: EPIC_ID,
      userStoryId,
      status: "completed",
      outcome: "answered",
      agentType: "review_code",
      provider,
      createdAt: at(minute),
      endedAt: at(minute + 1),
    })
    .run();
}

function addBuilder(
  id: string,
  minute: number,
  agentType = "build",
  provider = "claude-code"
): void {
  db.insert(agentSessions)
    .values({
      id,
      projectId: PROJECT_ID,
      epicId: EPIC_ID,
      status: "completed",
      outcome: "answered",
      agentType,
      provider,
      createdAt: at(minute),
      endedAt: at(minute + 1),
    })
    .run();
}

function addSecondOpinion(input: {
  id: string;
  minute: number;
  status?: string;
  outcome?: string | null;
  verdict?: "approved" | "approved with minor issues" | "changes requested";
  proseVerdict?: "Approved" | "Approved with Minor Issues" | "Changes Requested";
}): void {
  db.insert(agentSessions)
    .values({
      id: input.id,
      projectId: PROJECT_ID,
      epicId: EPIC_ID,
      status: input.status ?? "completed",
      outcome: input.outcome === undefined ? "answered" : input.outcome,
      agentType: "review_second_opinion",
      provider: "gemini-cli",
      createdAt: at(input.minute),
      endedAt: at(input.minute + 1),
    })
    .run();
  if (input.verdict) {
    db.insert(ticketComments)
      .values({
        id: `verdict-${input.id}`,
        epicId: EPIC_ID,
        author: "agent",
        content: `**Review findings (${input.verdict})**\n\nStructured result`,
        agentSessionId: input.id,
        createdAt: at(input.minute + 1),
      })
      .run();
  }
  if (input.proseVerdict) {
    db.insert(ticketComments)
      .values({
        id: `prose-${input.id}`,
        epicId: EPIC_ID,
        author: "agent",
        content: `**Independent second opinion**\n\n**Overall Verdict: ${input.proseVerdict}**`,
        agentSessionId: input.id,
        createdAt: at(input.minute + 1),
      })
      .run();
  }
}

beforeEach(() => {
  availabilityState.available.clear();
  dispatchState.launch = null;
  dispatchState.starts.length = 0;
  dispatchState.diffArgs.length = 0;
  vi.clearAllMocks();
  db.delete(notifications).run();
  db.delete(reviewComments).run();
  db.delete(ticketComments).run();
  db.delete(agentSessions).run();
  db.delete(userStories).run();
  db.delete(epics).run();
  db.delete(projects).run();
  seedBase();
});

describe("second-opinion structured gate", () => {
  it("identifies the ordinary reviewer provider without selecting an older run", () => {
    addOrdinaryReview("review-1", 1);
    addOrdinaryReview("review-2", 3);

    expect(
      findLastSuccessfulReviewProvider({
        projectId: PROJECT_ID,
        epicId: EPIC_ID,
      })
    ).toBe("codex");
  });

  it("accepts a fresh structured approval", () => {
    addOrdinaryReview("review-1", 1);
    addSecondOpinion({ id: "opinion-1", minute: 3, verdict: "approved" });

    expect(readSecondOpinionState(PROJECT_ID, EPIC_ID)).toEqual({
      status: "approved",
      sessionId: "opinion-1",
    });
  });

  it("rejects a negative structured verdict even without findings", () => {
    addOrdinaryReview("review-1", 1);
    addSecondOpinion({
      id: "opinion-1",
      minute: 3,
      verdict: "changes requested",
    });

    expect(readSecondOpinionState(PROJECT_ID, EPIC_ID)).toEqual({
      status: "rejected",
      sessionId: "opinion-1",
      reason: "changes requested",
    });
  });

  it("rejects a blocking structured finding even with an approved verdict", () => {
    addOrdinaryReview("review-1", 1);
    addSecondOpinion({ id: "opinion-1", minute: 3, verdict: "approved" });
    db.insert(reviewComments)
      .values({
        id: "finding-1",
        epicId: EPIC_ID,
        filePath: "lib/gate.ts",
        lineNumber: 12,
        body: "[major] Race can merge stale code",
        author: "agent",
        status: "open",
        agentSessionId: "opinion-1",
      })
      .run();

    expect(readSecondOpinionState(PROJECT_ID, EPIC_ID)).toEqual({
      status: "rejected",
      sessionId: "opinion-1",
      reason: "1 blocking finding",
    });
  });

  it("treats every open finding as merge-blocking", () => {
    addOrdinaryReview("review-1", 1);
    addSecondOpinion({ id: "opinion-1", minute: 3, verdict: "approved" });
    db.insert(reviewComments)
      .values({
        id: "finding-minor",
        epicId: EPIC_ID,
        filePath: "lib/gate.ts",
        lineNumber: 18,
        body: "[minor] Cleanup remains before merge",
        author: "agent",
        status: "open",
        agentSessionId: "opinion-1",
      })
      .run();

    expect(readSecondOpinionState(PROJECT_ID, EPIC_ID)).toEqual({
      status: "rejected",
      sessionId: "opinion-1",
      reason: "1 blocking finding",
    });
  });

  it("never lets an earlier approval hide a later negative submission", () => {
    addOrdinaryReview("review-1", 1);
    addSecondOpinion({ id: "opinion-1", minute: 3, verdict: "approved" });
    db.insert(ticketComments)
      .values({
        id: "verdict-negative",
        epicId: EPIC_ID,
        author: "agent",
        content: "**Review findings (changes requested)**\n\nFinal result",
        agentSessionId: "opinion-1",
        createdAt: at(5),
      })
      .run();

    expect(readSecondOpinionState(PROJECT_ID, EPIC_ID)).toEqual({
      status: "rejected",
      sessionId: "opinion-1",
      reason: "changes requested",
    });
  });

  it("accepts the mandated Overall Verdict fallback when no structured channel is available", () => {
    addOrdinaryReview("review-1", 1);
    addSecondOpinion({
      id: "opinion-1",
      minute: 3,
      proseVerdict: "Approved",
    });

    expect(readSecondOpinionState(PROJECT_ID, EPIC_ID)).toEqual({
      status: "approved",
      sessionId: "opinion-1",
    });
  });

  it("rejects a negative Overall Verdict fallback", () => {
    addOrdinaryReview("review-1", 1);
    addSecondOpinion({
      id: "opinion-1",
      minute: 3,
      proseVerdict: "Changes Requested",
    });

    expect(readSecondOpinionState(PROJECT_ID, EPIC_ID)).toEqual({
      status: "rejected",
      sessionId: "opinion-1",
      reason: "changes requested",
    });
  });

  it("keeps submit_findings authoritative over contradictory prose", () => {
    addOrdinaryReview("review-1", 1);
    addSecondOpinion({
      id: "opinion-1",
      minute: 3,
      verdict: "approved",
      proseVerdict: "Changes Requested",
    });

    expect(readSecondOpinionState(PROJECT_ID, EPIC_ID)).toEqual({
      status: "approved",
      sessionId: "opinion-1",
    });
  });

  it("retries output that has neither structured nor fallback evidence", () => {
    addOrdinaryReview("review-1", 1);
    addSecondOpinion({ id: "opinion-1", minute: 3 });

    expect(readSecondOpinionState(PROJECT_ID, EPIC_ID)).toEqual({
      status: "retry",
      sessionId: "opinion-1",
      reason: "no submit_findings or Overall Verdict evidence was recorded",
    });
  });

  it("does not accept an Overall Verdict line that is not the final line", () => {
    addOrdinaryReview("review-1", 1);
    addSecondOpinion({ id: "opinion-1", minute: 3 });
    db.insert(ticketComments)
      .values({
        id: "prose-not-final",
        epicId: EPIC_ID,
        author: "agent",
        content: "**Overall Verdict: Approved**\n\nAdditional unstructured text",
        agentSessionId: "opinion-1",
        createdAt: at(4),
      })
      .run();

    expect(readSecondOpinionState(PROJECT_ID, EPIC_ID)).toEqual({
      status: "retry",
      sessionId: "opinion-1",
      reason: "no submit_findings or Overall Verdict evidence was recorded",
    });
  });

  it("holds a cancelled gate without charging or immediately relaunching it", () => {
    addOrdinaryReview("review-1", 1);
    addSecondOpinion({
      id: "opinion-cancelled",
      minute: 3,
      status: "cancelled",
      outcome: null,
    });

    expect(readSecondOpinionState(PROJECT_ID, EPIC_ID)).toEqual({
      status: "cancelled",
      sessionId: "opinion-cancelled",
    });
  });

  it("requires a fresh gate after the user responds to a rejection", () => {
    addOrdinaryReview("review-1", 1);
    addSecondOpinion({
      id: "opinion-1",
      minute: 3,
      verdict: "changes requested",
    });
    db.insert(ticketComments)
      .values({
        id: "user-fix-note",
        epicId: EPIC_ID,
        author: "user",
        content: "Fixed the reported issue; please check again.",
        createdAt: at(5),
      })
      .run();

    expect(readSecondOpinionState(PROJECT_ID, EPIC_ID)).toEqual({
      status: "missing",
      sessionId: null,
    });
  });

  it("uses only epic-scoped ordinary reviews for second-opinion freshness", () => {
    db.insert(userStories)
      .values({
        id: "story-1",
        epicId: EPIC_ID,
        title: "Story",
        status: "review",
      })
      .run();
    addOrdinaryReview("review-epic", 1);
    addSecondOpinion({ id: "opinion-1", minute: 3, verdict: "approved" });
    addOrdinaryReview("review-story", 5, "claude-code", "story-1");

    expect(readSecondOpinionState(PROJECT_ID, EPIC_ID)).toEqual({
      status: "approved",
      sessionId: "opinion-1",
    });
    expect(
      findLastSuccessfulReviewProvider({
        projectId: PROJECT_ID,
        epicId: EPIC_ID,
      })
    ).toBe("codex");
  });

  it("requires a new second opinion after a newer ordinary review", () => {
    addSecondOpinion({ id: "opinion-old", minute: 1, verdict: "approved" });
    addOrdinaryReview("review-new", 3);

    expect(readSecondOpinionState(PROJECT_ID, EPIC_ID)).toEqual({
      status: "missing",
      sessionId: null,
    });
  });

  it("normalizes mixed SQLite and ISO timestamps before choosing the latest review", () => {
    db.insert(agentSessions)
      .values([
        {
          id: "review-iso-earlier",
          projectId: PROJECT_ID,
          epicId: EPIC_ID,
          status: "completed",
          outcome: "answered",
          agentType: "review_code",
          provider: "claude-code",
          createdAt: "2026-08-25T10:20:00.000Z",
          endedAt: "2026-08-25T10:30:00.000Z",
        },
        {
          id: "review-sqlite-later",
          projectId: PROJECT_ID,
          epicId: EPIC_ID,
          status: "completed",
          outcome: "answered",
          agentType: "review_code",
          provider: "codex",
          createdAt: "2026-08-25 10:50:00",
          endedAt: "2026-08-25 11:00:00",
        },
      ])
      .run();
    db.insert(agentSessions)
      .values({
        id: "opinion-between",
        projectId: PROJECT_ID,
        epicId: EPIC_ID,
        status: "completed",
        outcome: "answered",
        agentType: "review_second_opinion",
        provider: "gemini-cli",
        createdAt: "2026-08-25T10:40:00.000Z",
        endedAt: "2026-08-25T10:45:00.000Z",
      })
      .run();

    expect(readSecondOpinionState(PROJECT_ID, EPIC_ID)).toEqual({
      status: "missing",
      sessionId: null,
    });
  });
});

describe("second-opinion provider selection", () => {
  it("selects an installed provider distinct from builder and reviewer", async () => {
    availabilityState.available.add("codex");
    availabilityState.available.add("gemini-cli");

    await expect(
      pickSecondOpinionProvider("gemini-cli", "claude-code")
    ).resolves.toBe("codex");
  });

  it("uses a non-MCP provider's exact fallback verdict when it is the segregated alternative", async () => {
    availabilityState.available.add("gemini-cli");

    await expect(
      pickSecondOpinionProvider("claude-code", "codex")
    ).resolves.toBe("gemini-cli");
  });
});

describe("second-opinion dispatch", () => {
  it("runs a Team-build-aware, segregated plan session with the final diff embedded", async () => {
    addBuilder("team-build", 0, "team_build", "gemini-cli");
    addOrdinaryReview("review-1", 2, "claude-code");
    availabilityState.available.add("codex");

    const result = await dispatchSecondOpinion({
      projectId: PROJECT_ID,
      epicId: EPIC_ID,
    });

    expect(result).toMatchObject({
      error: null,
      conflictSessionId: null,
    });
    expect(result.sessionId).toEqual(expect.any(String));
    expect(dispatchState.diffArgs).toEqual(["develop...HEAD", "-U3"]);

    const session = db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.id, result.sessionId!))
      .get();
    expect(session).toMatchObject({
      mode: "plan",
      provider: "codex",
      agentType: "review_second_opinion",
    });
    expect(session?.prompt).toContain(dispatchState.diff);

    expect(dispatchState.launch).not.toBeNull();
    await dispatchState.launch!();
    expect(dispatchState.starts).toHaveLength(1);
    expect(dispatchState.starts[0]).toMatchObject({
      sessionId: result.sessionId,
      provider: "codex",
      options: {
        mode: "plan",
        cwd: "/repo-worktree",
      },
    });
  });
});

describe("second-opinion prompt and notification", () => {
  it("orders a final-diff, read-only structured verdict", () => {
    const prompt = buildSecondOpinionPrompt(
      { name: "Arij", spec: "Keep merges safe", memory: null },
      { title: "Gate merge", description: "Independent check", type: "feature" },
      [{ title: "Safe merge", acceptanceCriteria: "- Never bypass a veto" }],
      "feature/gate",
      "develop",
      "diff --git a/lib/gate.ts b/lib/gate.ts\n+safe();"
    );

    expect(prompt).toContain("git diff develop...HEAD");
    expect(prompt).toContain("+safe();");
    expect(prompt).toContain("read-only");
    expect(prompt).toContain("mcp__arij__submit_findings");
    expect(prompt).toContain("exactly once");
    expect(prompt).toContain("The structured submission is authoritative");
    expect(prompt).toContain("missing Overall Verdict line is a failed gate");
  });

  it("makes the exact Overall Verdict authoritative without structured tools", () => {
    const prompt = buildSecondOpinionPrompt(
      { name: "Arij", spec: "Keep merges safe", memory: null },
      { title: "Gate merge", description: "Independent check", type: "feature" },
      [],
      "feature/gate",
      "develop",
      "diff --git a/lib/gate.ts b/lib/gate.ts\n+safe();",
      false
    );

    expect(prompt).not.toContain("Call `mcp__arij__submit_findings`");
    expect(prompt).toContain("no structured Arij findings channel");
    expect(prompt).toContain("make the exact Overall Verdict line below authoritative");
  });

  it("creates one deduplicated notification deep-linked to the evidence session", () => {
    addOrdinaryReview("opinion-no", 1);
    createAutoModeSecondOpinionParkedNotification({
      projectId: PROJECT_ID,
      epicId: EPIC_ID,
      sessionId: "opinion-no",
      reason: "changes requested",
    });
    createAutoModeSecondOpinionParkedNotification({
      projectId: PROJECT_ID,
      epicId: EPIC_ID,
      sessionId: "opinion-no",
      reason: "changes requested",
    });

    const rows = db.select().from(notifications).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sessionId: "opinion-no",
      agentType: "review_second_opinion",
      status: "failed",
      targetUrl: `/projects/${PROJECT_ID}/sessions/opinion-no`,
    });
  });
});
