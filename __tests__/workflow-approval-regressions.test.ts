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
  reviewComments,
  ticketActivityLog,
  ticketComments,
  userStories,
} = await import("@/lib/db/schema");
const { POST: approveEpic } = await import(
  "@/app/api/projects/[projectId]/epics/[epicId]/approve/route"
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
});

describe("workflow approval regressions", () => {
  it("approves an epic while leaving non-review stories unchanged and logged", async () => {
    db.insert(projects).values({ id: "p-epic", name: "Approval" }).run();
    db.insert(epics)
      .values({
        id: "e-epic",
        projectId: "p-epic",
        title: "Mixed story states",
        status: "review",
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
        id: "epic-review-session",
        projectId: "p-epic",
        epicId: "e-epic",
        status: "completed",
        agentType: "review_code",
        mode: "plan",
      })
      .run();

    const response = await approveEpic(
      mockNextRequest({ url: "http://localhost/approve", method: "POST" }),
      mockRouteContext({ projectId: "p-epic", epicId: "e-epic" })
    );

    expect(response.status).toBe(200);
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

  it("treats story approval as the human review decision and holds only the parent guard", async () => {
    db.insert(projects).values({ id: "p-story", name: "Approval" }).run();
    db.insert(epics)
      .values({
        id: "e-story",
        projectId: "p-story",
        title: "Story approval",
        status: "review",
      })
      .run();
    db.insert(userStories)
      .values({
        id: "story-only",
        epicId: "e-story",
        title: "Built without a review agent",
        status: "review",
      })
      .run();
    db.insert(reviewComments)
      .values({
        id: "open-finding",
        epicId: "e-story",
        filePath: "app.ts",
        lineNumber: 1,
        body: "Resolved by explicit approval",
        status: "open",
      })
      .run();

    const response = await approveStory(
      mockNextRequest({ url: "http://localhost/approve", method: "POST" }),
      mockRouteContext({ projectId: "p-story", storyId: "story-only" })
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toMatchObject({
      approved: true,
      epicComplete: false,
      epicHoldReason: expect.stringContaining("no completed review"),
    });
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
    ).toBe("resolved");
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
        reason: expect.stringContaining("parent epic held"),
      })
    );
  });
});
