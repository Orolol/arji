/**
 * The last-moment build guard in `defaultDispatch` (lib/auto-mode/engine.ts).
 *
 * The board snapshot that produced a candidate is not fresh: `dispatchKind`
 * awaits each dispatch in turn, so the window between selection and launch is
 * seconds wide — long enough for a human to drag a ticket back to Backlog.
 * That gesture is how Backlog means "not yet" now that Full Auto no longer
 * builds it, so the guard has to enforce exactly the vocabulary the selector
 * matched on: `BUILDABLE_EPIC_STATUSES` / `BUILDABLE_STORY_STATUSES`. A
 * second, private copy of "buildable" here is the drift this epic removes.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

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
const { projects, epics, userStories } = await import("@/lib/db/schema");
const { defaultAutoModeDeps } = await import("@/lib/auto-mode/engine");

const PROJECT_ID = "proj-dispatch-guard";
const EPIC_ID = "epic-guard";
const STORY_ID = "story-guard";

/** What `checkGuards` reports: the DISPATCH TARGET's own status. */
function targetStatusIs(status: string): void {
  driverMocks.checkGuards.mockReturnValue({
    conflictSessionId: null,
    reviewTargetStatus: status,
  });
}

function setEpicStatus(status: string): void {
  db.update(epics).set({ status }).run();
}

function dispatchBuild(scope: "epic" | "story") {
  return defaultAutoModeDeps.dispatch({
    projectId: PROJECT_ID,
    stage: "build",
    scope,
    epicId: EPIC_ID,
    userStoryId: scope === "story" ? STORY_ID : null,
    buildNamedAgentId: null,
    reviewNamedAgentId: null,
    ownSessionIds: [],
  });
}

beforeEach(() => {
  db.delete(userStories).run();
  db.delete(epics).run();
  db.delete(projects).run();
  driverMocks.checkGuards.mockReset();
  driverMocks.launchStage.mockReset();
  driverMocks.launchStage.mockResolvedValue({
    sessionId: "build-session",
    settled: Promise.resolve({ success: true, outcome: "answered", error: null }),
  });

  db.insert(projects)
    .values({ id: PROJECT_ID, name: "Guard", gitRepoPath: "/repos/guard" })
    .run();
  db.insert(epics)
    .values({
      id: EPIC_ID,
      projectId: PROJECT_ID,
      title: "Epic",
      status: "todo",
      position: 0,
      createdAt: "2026-08-26T09:00:00.000Z",
      updatedAt: "2026-08-26T09:00:00.000Z",
    })
    .run();
  db.insert(userStories)
    .values({
      id: STORY_ID,
      epicId: EPIC_ID,
      title: "Story",
      status: "todo",
      position: 0,
      createdAt: "2026-08-26T09:00:00.000Z",
    })
    .run();
});

describe("epic-scoped build guard", () => {
  it("dispatches a ticket still in To Do", async () => {
    targetStatusIs("todo");

    const result = await dispatchBuild("epic");

    expect(result.sessionId).toBe("build-session");
    expect(result.skipReason).toBeUndefined();
  });

  it("dispatches a ticket in In Progress with no agent on it", async () => {
    targetStatusIs("in_progress");
    setEpicStatus("in_progress");

    const result = await dispatchBuild("epic");

    expect(result.sessionId).toBe("build-session");
  });

  it("refuses a ticket dragged back to Backlog after selection", async () => {
    // Selected while `todo`; the user pulls it out of the queue mid-sweep.
    targetStatusIs("backlog");
    setEpicStatus("backlog");

    const result = await dispatchBuild("epic");

    expect(result.sessionId).toBeNull();
    expect(result.error).toBeNull();
    expect(result.skipReason).toBe(
      "target is no longer buildable (now backlog)"
    );
    expect(driverMocks.launchStage).not.toHaveBeenCalled();
  });

  it("refuses a ticket a human just approved", async () => {
    targetStatusIs("done");
    setEpicStatus("done");

    const result = await dispatchBuild("epic");

    expect(result.skipReason).toBe("target is no longer buildable (now done)");
    expect(driverMocks.launchStage).not.toHaveBeenCalled();
  });
});

describe("story-scoped build guard", () => {
  it("dispatches a To Do story under a To Do epic", async () => {
    targetStatusIs("todo");

    const result = await dispatchBuild("story");

    expect(result.sessionId).toBe("build-session");
  });

  it("refuses a To Do story whose parent epic was dragged to Backlog", async () => {
    // `checkGuards` reports the STORY's status for story scope, so the story
    // check passes on `todo`; only the parent check can catch this.
    targetStatusIs("todo");
    setEpicStatus("backlog");

    const result = await dispatchBuild("story");

    expect(result.sessionId).toBeNull();
    expect(result.error).toBeNull();
    expect(result.skipReason).toBe("parent epic is backlog");
    expect(driverMocks.launchStage).not.toHaveBeenCalled();
  });

  it("refuses a story whose parent epic was released", async () => {
    targetStatusIs("todo");
    setEpicStatus("released");

    const result = await dispatchBuild("story");

    expect(result.skipReason).toBe("parent epic is released");
    expect(driverMocks.launchStage).not.toHaveBeenCalled();
  });

  it("refuses a story that itself left the queue", async () => {
    targetStatusIs("review");

    const result = await dispatchBuild("story");

    expect(result.skipReason).toBe(
      "target is no longer buildable (now review)"
    );
    expect(driverMocks.launchStage).not.toHaveBeenCalled();
  });

  it("reports an unknown parent rather than interpolating null", async () => {
    targetStatusIs("todo");
    db.delete(epics).run();

    const result = await dispatchBuild("story");

    expect(result.skipReason).toBe("parent epic is unknown");
  });
});
