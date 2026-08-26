/**
 * Regression contract for B-arij: one activity line per ticket movement.
 *
 * Moving an epic cascades the same status change onto its stories. Every
 * child write appended its own `ticket_activity_log` row, so a five-story
 * epic produced six identical "Agent moved In Progress → Review" lines in
 * the ticket feed — the movement, then one echo per story.
 *
 * The contract these tests pin: an epic-scoped cascade records exactly ONE
 * entry, the epic's own; a genuinely story-scoped move still records its
 * own line; and a cascade never leaves the trail empty, not even when the
 * epic's status write is a no-op.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { mockNextRequest, mockRouteContext } from "@/__tests__/helpers/db-mock";

vi.mock("@/lib/db", async () => {
  const { createTestDb } = await import("@/lib/db/test-utils");
  const created = createTestDb();
  return { db: created.db, sqlite: created.sqlite, ensureDbReady: vi.fn() };
});

vi.mock("@/lib/events/emit", () => ({ emitTicketMoved: vi.fn() }));
vi.mock("@/lib/sync/export", () => ({ tryExportArjiJson: vi.fn() }));
vi.mock("simple-git", () => ({
  default: vi.fn(() => ({ merge: vi.fn().mockResolvedValue(undefined) })),
}));

const { db } = await import("@/lib/db");
const {
  agentSessions,
  epics,
  projects,
  ticketActivityLog,
  ticketComments,
  reviewComments,
  userStories,
} = await import("@/lib/db/schema");
const {
  transitionBuildCompleted,
  transitionBuildStarted,
  transitionReviewRejected,
} = await import("@/lib/workflow/automatic-transitions");
const { POST: approveEpic } = await import(
  "@/app/api/projects/[projectId]/epics/[epicId]/approve/route"
);

let sequence = 0;

function seedEpic(status: string, storyStatuses: string[]) {
  sequence += 1;
  const projectId = `project-${sequence}`;
  const epicId = `epic-${sequence}`;
  db.insert(projects).values({ id: projectId, name: "Cascade" }).run();
  db.insert(epics)
    .values({ id: epicId, projectId, title: "Ticket", status })
    .run();
  const storyIds = storyStatuses.map((storyStatus, index) => {
    const id = `story-${sequence}-${index + 1}`;
    db.insert(userStories)
      .values({ id, epicId, title: `Story ${index + 1}`, status: storyStatus })
      .run();
    return id;
  });
  return { projectId, epicId, storyIds };
}

function activity(epicId: string) {
  return db
    .select()
    .from(ticketActivityLog)
    .where(eq(ticketActivityLog.epicId, epicId))
    .all();
}

beforeEach(() => {
  db.delete(ticketActivityLog).run();
  db.delete(ticketComments).run();
  db.delete(reviewComments).run();
  db.delete(agentSessions).run();
  db.delete(userStories).run();
  db.delete(epics).run();
  db.delete(projects).run();
});

describe("an epic movement writes one activity line, not one per story", () => {
  it("logs a single entry when a build starts on a five-story epic", () => {
    const { projectId, epicId } = seedEpic("todo", [
      "todo",
      "todo",
      "todo",
      "todo",
      "todo",
    ]);

    transitionBuildStarted({
      projectId,
      epicId,
      scope: "epic",
      sessionId: "build-session",
    });

    expect(activity(epicId)).toEqual([
      expect.objectContaining({
        fromStatus: "todo",
        toStatus: "in_progress",
        actor: "agent",
        reason: "Build agent started",
      }),
    ]);
  });

  it("logs a single entry when the build promotes the epic to review", () => {
    const { projectId, epicId } = seedEpic("in_progress", [
      "in_progress",
      "in_progress",
      "in_progress",
      "in_progress",
      "in_progress",
    ]);

    const result = transitionBuildCompleted({
      projectId,
      epicId,
      scope: "epic",
      sessionId: "build-session",
    });

    expect(result).toMatchObject({ valid: true, epicPromoted: true });
    expect(activity(epicId)).toEqual([
      expect.objectContaining({
        fromStatus: "in_progress",
        toStatus: "review",
        actor: "agent",
        reason: "Build completed successfully",
      }),
    ]);
  });

  it("logs a single entry when a negative review sends the epic back", () => {
    const { projectId, epicId } = seedEpic("review", [
      "review",
      "review",
      "review",
    ]);

    transitionReviewRejected({
      projectId,
      epicId,
      scope: "epic",
      sessionId: "review-session",
      reason: "Review requested changes",
    });

    expect(activity(epicId)).toEqual([
      expect.objectContaining({
        fromStatus: "review",
        toStatus: "in_progress",
        actor: "agent",
        reason: "Review requested changes",
      }),
    ]);
  });

  it("still records the movement when the epic's own status write is a no-op", () => {
    // The owning session promoted the epic itself through MCP, so completion
    // only has the stories left to move. Folding the story rows away must not
    // erase the movement from the trail entirely.
    const { projectId, epicId } = seedEpic("review", [
      "in_progress",
      "in_progress",
    ]);

    transitionBuildCompleted({
      projectId,
      epicId,
      scope: "epic",
      sessionId: "build-session",
    });

    expect(activity(epicId)).toEqual([
      expect.objectContaining({
        fromStatus: "review",
        toStatus: "review",
        actor: "agent",
        reason: "Build completed successfully",
      }),
    ]);
  });

  it("logs a single entry when an epic approval closes its stories", async () => {
    db.insert(projects).values({ id: "p-approve", name: "Cascade" }).run();
    db.insert(epics)
      .values({
        id: "e-approve",
        projectId: "p-approve",
        title: "Approved epic",
        status: "review",
      })
      .run();
    db.insert(userStories)
      .values(
        ["s-1", "s-2", "s-3"].map((id, index) => ({
          id,
          epicId: "e-approve",
          title: `Story ${index + 1}`,
          status: "review",
        }))
      )
      .run();
    db.insert(agentSessions)
      .values({
        id: "epic-review-session",
        projectId: "p-approve",
        epicId: "e-approve",
        status: "completed",
        agentType: "review_code",
        mode: "plan",
      })
      .run();

    const response = await approveEpic(
      mockNextRequest({ url: "http://localhost/approve", method: "POST" }),
      mockRouteContext({ projectId: "p-approve", epicId: "e-approve" })
    );

    expect(response.status).toBe(200);
    expect(activity("e-approve")).toEqual([
      expect.objectContaining({
        fromStatus: "review",
        toStatus: "done",
        actor: "user",
      }),
    ]);
  });
});

describe("story-scoped movements keep their own line", () => {
  it("records the story that moved when a story build completes", () => {
    const { projectId, epicId, storyIds } = seedEpic("in_progress", [
      "in_progress",
      "todo",
    ]);

    transitionBuildCompleted({
      projectId,
      epicId,
      scope: "story",
      userStoryId: storyIds[0],
      sessionId: "story-build-session",
    });

    expect(activity(epicId)).toContainEqual(
      expect.objectContaining({
        fromStatus: "in_progress",
        toStatus: "review",
        reason: `Story ${storyIds[0]} — Build completed successfully`,
      })
    );
  });
});
