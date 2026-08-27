import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { mockNextRequest, mockRouteContext } from "@/__tests__/helpers/db-mock";

const gitMocks = vi.hoisted(() => ({ mergeWorktree: vi.fn() }));

vi.mock("@/lib/db", async () => {
  const { createTestDb } = await import("@/lib/db/test-utils");
  const created = createTestDb();
  return { db: created.db, sqlite: created.sqlite, ensureDbReady: vi.fn() };
});

vi.mock("@/lib/git/manager", () => ({
  mergeWorktree: gitMocks.mergeWorktree,
}));
vi.mock("@/lib/events/emit", () => ({ emitTicketMoved: vi.fn() }));
vi.mock("@/lib/sync/export", () => ({ tryExportArjiJson: vi.fn() }));

const { db } = await import("@/lib/db");
const {
  agentSessions,
  epics,
  projects,
  reviewComments,
  ticketActivityLog,
  ticketComments,
  userStories,
} = await import("@/lib/db/schema");
const { POST: mergeEpic } = await import(
  "@/app/api/projects/[projectId]/epics/[epicId]/merge/route"
);

beforeEach(() => {
  db.delete(ticketActivityLog).run();
  db.delete(ticketComments).run();
  db.delete(reviewComments).run();
  db.delete(agentSessions).run();
  db.delete(userStories).run();
  db.delete(epics).run();
  db.delete(projects).run();
  gitMocks.mergeWorktree.mockReset();
  gitMocks.mergeWorktree.mockResolvedValue({
    merged: true,
    commitHash: "merged-commit",
  });
});

describe("manual epic merge story cascade", () => {
  it("closes reviewed stories, reports skipped stories, and attributes every move to the user", async () => {
    db.insert(projects)
      .values({
        id: "project-manual",
        name: "Manual merge",
        gitRepoPath: "/repos/manual",
        defaultBranch: "trunk",
      })
      .run();
    db.insert(epics)
      .values({
        id: "epic-manual",
        projectId: "project-manual",
        title: "Merge me",
        status: "review",
        branchName: "feature/manual",
      })
      .run();
    db.insert(userStories)
      .values([
        {
          id: "story-review-1",
          epicId: "epic-manual",
          title: "Reviewed one",
          status: "review",
        },
        {
          id: "story-review-2",
          epicId: "epic-manual",
          title: "Reviewed two",
          status: "review",
        },
        {
          id: "story-todo",
          epicId: "epic-manual",
          title: "Added later",
          status: "todo",
        },
      ])
      .run();
    db.insert(agentSessions)
      .values([
        {
          id: "build-manual",
          projectId: "project-manual",
          epicId: "epic-manual",
          status: "completed",
          agentType: "build",
          worktreePath: "/worktrees/manual",
        },
        {
          // Approving structured verdict, not just `answered`: a review that
          // filed nothing through a `submit_findings` channel it had is
          // unverifiable and the merge guard refuses it
          // (lib/pipeline/findings.ts). The cascade under test needs a review
          // that actually delivered.
          id: "review-manual",
          projectId: "project-manual",
          epicId: "epic-manual",
          status: "completed",
          agentType: "review_code",
          outcome: "answered",
          reviewVerdict: "approved",
          worktreePath: "/worktrees/manual",
        },
      ])
      .run();

    const response = await mergeEpic(
      mockNextRequest({
        url: "http://localhost/api/projects/project-manual/epics/epic-manual/merge",
        method: "POST",
      }),
      mockRouteContext({
        projectId: "project-manual",
        epicId: "epic-manual",
      })
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toMatchObject({
      merged: true,
      commitHash: "merged-commit",
      skippedStories: [
        { id: "story-todo", title: "Added later", status: "todo" },
      ],
    });
    expect(gitMocks.mergeWorktree).toHaveBeenCalledWith(
      "/repos/manual",
      "feature/manual",
      "/worktrees/manual",
      { defaultBranch: "trunk" }
    );

    expect(
      db.select().from(epics).where(eq(epics.id, "epic-manual")).get()?.status
    ).toBe("done");
    expect(
      db
        .select({ id: userStories.id, status: userStories.status })
        .from(userStories)
        .where(eq(userStories.epicId, "epic-manual"))
        .all()
    ).toEqual([
      { id: "story-review-1", status: "done" },
      { id: "story-review-2", status: "done" },
      { id: "story-todo", status: "todo" },
    ]);

    const activity = db
      .select()
      .from(ticketActivityLog)
      .where(eq(ticketActivityLog.epicId, "epic-manual"))
      .all();
    expect(activity).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fromStatus: "review",
          toStatus: "done",
          actor: "user",
          reason: "Branch merged successfully",
        }),
        expect.objectContaining({
          fromStatus: "review",
          toStatus: "done",
          actor: "user",
          reason: expect.stringContaining("Story story-review-1"),
        }),
        expect.objectContaining({
          fromStatus: "review",
          toStatus: "done",
          actor: "user",
          reason: expect.stringContaining("Story story-review-2"),
        }),
        expect.objectContaining({
          fromStatus: "done",
          toStatus: "done",
          actor: "user",
          reason: expect.stringContaining("story-todo:todo"),
        }),
      ])
    );
  });
});
