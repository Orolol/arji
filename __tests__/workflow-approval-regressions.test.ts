/**
 * Merge/approval regressions against the real schema.
 *
 * The merge closes an epic (to_merge → done, source "merge") and is the one
 * approval the workflow has: its cascade closes reviewed stories, leaves
 * non-review stories untouched but reported, and bulk-resolves whatever
 * review comments were still open. Story approval is the story-sized human
 * verdict: it closes ONLY the story — never the epic, never its findings —
 * and when it was the last open story it records a decision line instead of
 * merging anything.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { mockNextRequest, mockRouteContext } from "@/__tests__/helpers/db-mock";

const gitMocks = vi.hoisted(() => ({ mergeWorktree: vi.fn() }));

vi.mock("@/lib/db", async () => {
  const { createTestDb } = await import("@/lib/db/test-utils");
  const created = createTestDb();
  return { db: created.db, sqlite: created.sqlite, ensureDbReady: vi.fn() };
});

vi.mock("@/lib/events/emit", () => ({ emitTicketMoved: vi.fn() }));
vi.mock("@/lib/sync/export", () => ({ tryExportArjiJson: vi.fn() }));
vi.mock("@/lib/git/manager", () => ({
  mergeWorktree: gitMocks.mergeWorktree,
}));

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
const { POST: approveStory } = await import(
  "@/app/api/projects/[projectId]/stories/[storyId]/approve/route"
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
    commitHash: "regression-commit",
  });
});

describe("workflow merge regressions", () => {
  it("merges an epic while leaving non-review stories unchanged and logged, and resolves its open findings", async () => {
    db.insert(projects)
      .values({ id: "p-epic", name: "Merge", gitRepoPath: "/repos/merge" })
      .run();
    db.insert(epics)
      .values({
        id: "e-epic",
        projectId: "p-epic",
        title: "Mixed story states",
        // The review verdict already promoted the ticket; the merge is the
        // approval that closes it.
        status: "to_merge",
        branchName: "feature/e-epic",
      })
      .run();
    db.insert(userStories)
      .values([
        {
          id: "story-reviewed",
          epicId: "e-epic",
          title: "Reviewed",
          status: "review",
        },
        {
          id: "story-added-late",
          epicId: "e-epic",
          title: "Added late",
          status: "todo",
        },
      ])
      .run();
    db.insert(agentSessions)
      .values({
        id: "epic-build-session",
        projectId: "p-epic",
        epicId: "e-epic",
        status: "completed",
        agentType: "build",
        worktreePath: "/worktrees/e-epic",
        mode: "code",
      })
      .run();
    // An open finding the reviewer left behind: the merge accepts it.
    db.insert(reviewComments)
      .values({
        id: "open-minor-finding",
        epicId: "e-epic",
        filePath: "app.ts",
        lineNumber: 1,
        body: "[minor] left open on purpose",
        author: "agent",
        status: "open",
      })
      .run();

    const response = await mergeEpic(
      mockNextRequest({ url: "http://localhost/merge", method: "POST" }),
      mockRouteContext({ projectId: "p-epic", epicId: "e-epic" })
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.merged).toBe(true);
    expect(body.data.skippedStories).toEqual([
      {
        id: "story-added-late",
        title: "Added late",
        status: "todo",
      },
    ]);
    expect(db.select().from(epics).where(eq(epics.id, "e-epic")).get()?.status).toBe(
      "done"
    );
    expect(
      db.select().from(userStories).where(eq(userStories.id, "story-reviewed")).get()
        ?.status
    ).toBe("done");
    expect(
      db
        .select()
        .from(userStories)
        .where(eq(userStories.id, "story-added-late"))
        .get()?.status
    ).toBe("todo");
    // The merge IS the approval: the open finding was resolved with it.
    expect(
      db
        .select()
        .from(reviewComments)
        .where(eq(reviewComments.id, "open-minor-finding"))
        .get()?.status
    ).toBe("resolved");
    expect(
      db
        .select()
        .from(ticketActivityLog)
        .where(eq(ticketActivityLog.epicId, "e-epic"))
        .all()
    ).toContainEqual(
      expect.objectContaining({
        fromStatus: "done",
        toStatus: "done",
        reason: expect.stringContaining("story-added-late:todo"),
      })
    );
  });

  it("approves one story without resolving epic-scoped findings or touching the epic", async () => {
    db.insert(projects).values({ id: "p-story", name: "Approval" }).run();
    db.insert(epics)
      .values({
        id: "e-story",
        projectId: "p-story",
        title: "Story approval",
        status: "review",
        branchName: "feature/e-story",
      })
      .run();
    db.insert(userStories)
      .values([
        {
          id: "story-done",
          epicId: "e-story",
          title: "Already approved",
          status: "done",
        },
        {
          id: "story-only",
          epicId: "e-story",
          title: "Built without a story review agent",
          status: "review",
        },
      ])
      .run();
    db.insert(reviewComments)
      .values({
        id: "open-finding",
        epicId: "e-story",
        filePath: "app.ts",
        lineNumber: 1,
        body: "Stays open until the epic merges",
        status: "open",
      })
      .run();

    const response = await approveStory(
      mockNextRequest({ url: "http://localhost/approve", method: "POST" }),
      mockRouteContext({ projectId: "p-story", storyId: "story-only" })
    );
    const body = await response.json();

    // The last open story closed, and NOTHING else moved: no merge, no epic
    // close — the epic reaches Done through its merge alone.
    expect(response.status).toBe(200);
    expect(body.data).toEqual({
      approved: true,
      epicComplete: true,
      merged: false,
    });
    expect(gitMocks.mergeWorktree).not.toHaveBeenCalled();
    expect(
      db.select().from(userStories).where(eq(userStories.id, "story-only")).get()?.status
    ).toBe("done");
    expect(db.select().from(epics).where(eq(epics.id, "e-story")).get()?.status).toBe(
      "review"
    );
    expect(
      db
        .select()
        .from(reviewComments)
        .where(eq(reviewComments.id, "open-finding"))
        .get()?.status
    ).toBe("open");
    // The trail says why the epic stayed put: it closes through its merge.
    expect(
      db
        .select()
        .from(ticketActivityLog)
        .where(eq(ticketActivityLog.epicId, "e-story"))
        .all()
    ).toContainEqual(
      expect.objectContaining({
        fromStatus: "review",
        toStatus: "review",
        actor: "user",
        reason: expect.stringContaining("closes through its merge"),
      })
    );
  });
});
