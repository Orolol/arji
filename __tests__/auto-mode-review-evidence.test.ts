/**
 * Full Auto forwards its own mechanical evidence to the reviewer.
 *
 * The mode now runs the deterministic checks at the same point in the
 * lifecycle the pipeline does, so its review stage must get the same
 * one-line-per-command PASS summary the pipeline's reviewer gets — otherwise
 * the reviewer re-derives from scratch what Arij already proved. Only a
 * report that still vouches for the branch is forwarded, using the same
 * freshness rule the merge gate uses.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { PipelineStageRequest } from "@/lib/pipeline/runner";

const driverMocks = vi.hoisted(() => ({
  checkGuards: vi.fn(),
  launchStage: vi.fn(),
}));

vi.mock("@/lib/db", async () => {
  const { createTestDb } = await import("@/lib/db/test-utils");
  const created = createTestDb();
  return { db: created.db, sqlite: created.sqlite, ensureDbReady: vi.fn() };
});

vi.mock("@/lib/pipeline/stages", () => ({
  createPipelineStageDriver: vi.fn(() => ({
    checkGuards: driverMocks.checkGuards,
    launchStage: driverMocks.launchStage,
    runDeterministicVerification: vi.fn(),
  })),
}));

const { db } = await import("@/lib/db");
const { projects, epics, agentSessions, verifyReports } = await import(
  "@/lib/db/schema"
);
const { defaultAutoModeDeps } = await import("@/lib/auto-mode/engine");

const PROJECT_ID = "proj-evidence";
const EPIC_ID = "epic-evidence";

const COMMANDS = [
  {
    name: "test",
    command: "npm test",
    exitCode: 0,
    durationMs: 1_200,
    tail: "ok",
  },
];

function insertReport(input: {
  id: string;
  status: "pass" | "fail";
  finishedAt: string;
}): void {
  db.insert(verifyReports)
    .values({
      id: input.id,
      projectId: PROJECT_ID,
      epicId: EPIC_ID,
      agentSessionId: null,
      status: input.status,
      startedAt: "2026-08-25T10:00:00.000Z",
      finishedAt: input.finishedAt,
      commands: JSON.stringify(COMMANDS),
    })
    .run();
}

function dispatchReview() {
  return defaultAutoModeDeps.dispatch({
    projectId: PROJECT_ID,
    stage: "review",
    scope: "epic",
    epicId: EPIC_ID,
    userStoryId: null,
    buildNamedAgentId: null,
    reviewNamedAgentId: null,
    ownSessionIds: [],
  });
}

function launchedRequest(): PipelineStageRequest {
  return driverMocks.launchStage.mock.calls[0][0] as PipelineStageRequest;
}

beforeEach(() => {
  db.delete(verifyReports).run();
  db.delete(agentSessions).run();
  db.delete(epics).run();
  db.delete(projects).run();
  driverMocks.checkGuards.mockReset();
  driverMocks.checkGuards.mockReturnValue({
    conflictSessionId: null,
    reviewTargetStatus: "review",
  });
  driverMocks.launchStage.mockReset();
  driverMocks.launchStage.mockResolvedValue({
    sessionId: "review-session",
    settled: Promise.resolve({ success: true, outcome: "answered", error: null }),
  });

  db.insert(projects)
    .values({ id: PROJECT_ID, name: "Evidence", gitRepoPath: "/repos/evidence" })
    .run();
  db.insert(epics)
    .values({
      id: EPIC_ID,
      projectId: PROJECT_ID,
      title: "Epic",
      status: "review",
      position: 0,
      createdAt: "2026-08-25T09:00:00.000Z",
      updatedAt: "2026-08-25T09:00:00.000Z",
    })
    .run();
  db.insert(agentSessions)
    .values({
      id: "s-build",
      projectId: PROJECT_ID,
      epicId: EPIC_ID,
      status: "completed",
      agentType: "build",
      createdAt: "2026-08-25T09:30:00.000Z",
      endedAt: "2026-08-25T09:40:00.000Z",
    })
    .run();
});

describe("Full Auto review dispatch — verification evidence", () => {
  it("forwards a fresh passing report to the reviewer", async () => {
    insertReport({
      id: "fresh-pass",
      status: "pass",
      finishedAt: "2026-08-25T09:45:00.000Z",
    });

    await dispatchReview();

    expect(launchedRequest().verificationReport).toMatchObject({
      id: "fresh-pass",
      status: "pass",
      commands: COMMANDS,
    });
  });

  it("forwards nothing when the report predates the last code session", async () => {
    insertReport({
      id: "stale-pass",
      status: "pass",
      finishedAt: "2026-08-25T09:35:00.000Z",
    });

    await dispatchReview();

    // A report describing a tree the build has since changed is not
    // evidence — the same rule the merge gate applies.
    expect(launchedRequest().verificationReport).toBeUndefined();
  });

  it("forwards nothing when the checks failed", async () => {
    insertReport({
      id: "failing",
      status: "fail",
      finishedAt: "2026-08-25T09:45:00.000Z",
    });

    await dispatchReview();

    expect(launchedRequest().verificationReport).toBeUndefined();
  });

  it("forwards nothing when verification never ran", async () => {
    await dispatchReview();

    expect(launchedRequest().verificationReport).toBeUndefined();
  });

  it("never reads evidence for a build stage", async () => {
    insertReport({
      id: "fresh-pass",
      status: "pass",
      finishedAt: "2026-08-25T09:45:00.000Z",
    });
    driverMocks.checkGuards.mockReturnValue({
      conflictSessionId: null,
      reviewTargetStatus: "in_progress",
    });

    await defaultAutoModeDeps.dispatch({
      projectId: PROJECT_ID,
      stage: "build",
      scope: "epic",
      epicId: EPIC_ID,
      userStoryId: null,
      buildNamedAgentId: null,
      reviewNamedAgentId: null,
      ownSessionIds: [],
    });

    // The report is for the reviewer's prompt; a build has nothing to do
    // with it, and the code it is about to write invalidates it anyway.
    expect(launchedRequest().verificationReport).toBeUndefined();
  });
});
