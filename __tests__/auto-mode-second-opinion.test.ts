import { beforeEach, describe, expect, it, vi } from "vitest";

const availabilityState = vi.hoisted(() => ({
  available: new Set<string>(),
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

const { db } = await import("@/lib/db");
const {
  agentSessions,
  epics,
  notifications,
  projects,
  reviewComments,
  ticketComments,
} = await import("@/lib/db/schema");
const { pickSecondOpinionProvider, readSecondOpinionState } = await import(
  "@/lib/auto-mode/second-opinion"
);
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
    .values({ id: PROJECT_ID, name: "Second", gitRepoPath: "/repo" })
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

function addOrdinaryReview(id: string, minute: number): void {
  db.insert(agentSessions)
    .values({
      id,
      projectId: PROJECT_ID,
      epicId: EPIC_ID,
      status: "completed",
      outcome: "answered",
      agentType: "review_code",
      provider: "codex",
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
}

beforeEach(() => {
  availabilityState.available.clear();
  db.delete(notifications).run();
  db.delete(reviewComments).run();
  db.delete(ticketComments).run();
  db.delete(agentSessions).run();
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

  it("never treats prose without submit_findings as approval", () => {
    addOrdinaryReview("review-1", 1);
    addSecondOpinion({ id: "opinion-1", minute: 3 });

    expect(readSecondOpinionState(PROJECT_ID, EPIC_ID)).toEqual({
      status: "rejected",
      sessionId: "opinion-1",
      reason: "no structured submit_findings verdict was recorded",
    });
  });

  it("requires a new second opinion after a newer ordinary review", () => {
    addSecondOpinion({ id: "opinion-old", minute: 1, verdict: "approved" });
    addOrdinaryReview("review-new", 3);

    expect(readSecondOpinionState(PROJECT_ID, EPIC_ID)).toEqual({
      status: "missing",
      sessionId: null,
    });
  });
});

describe("second-opinion provider selection", () => {
  it("selects only an MCP-capable provider distinct from builder and reviewer", async () => {
    availabilityState.available.add("codex");
    availabilityState.available.add("gemini-cli");

    await expect(
      pickSecondOpinionProvider("gemini-cli", "claude-code")
    ).resolves.toBe("codex");
  });

  it("does not select an installed provider that cannot submit findings", async () => {
    availabilityState.available.add("gemini-cli");

    await expect(
      pickSecondOpinionProvider("claude-code", "codex")
    ).resolves.toBeNull();
  });
});

describe("second-opinion prompt and notification", () => {
  it("orders a final-diff, read-only structured verdict", () => {
    const prompt = buildSecondOpinionPrompt(
      { name: "Arij", spec: "Keep merges safe", memory: null },
      { title: "Gate merge", description: "Independent check", type: "feature" },
      [{ title: "Safe merge", acceptanceCriteria: "- Never bypass a veto" }],
      "feature/gate",
      "develop"
    );

    expect(prompt).toContain("git diff develop...HEAD");
    expect(prompt).toContain("read-only");
    expect(prompt).toContain("mcp__arij__submit_findings");
    expect(prompt).toContain("exactly once");
    expect(prompt).toContain("A missing structured verdict is a failed gate");
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
