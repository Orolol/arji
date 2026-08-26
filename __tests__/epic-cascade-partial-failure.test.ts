/**
 * A cascade that dies half-way must still say what moved.
 *
 * Epic-scoped cascades silence their child rows so the feed shows one line
 * per ticket movement (see epic-cascade-activity.test.ts). The cost is that a
 * cascade refused AFTER some stories were written leaves those moves with no
 * row of their own — and the ticket sits with its stories ahead of it while
 * the trail says only "held in in_progress". These tests pin the summary
 * entry that names them.
 *
 * The refusals are forced through the transition service rather than through
 * board state on purpose: both paths pre-flight every guard before writing,
 * so reaching them for real needs a concurrent change between the pre-flight
 * and the write. That is exactly the case worth having a trail for.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

const serviceMocks = vi.hoisted(() => ({
  epicCascadeError: null as string | null,
  refusedStoryId: null as string | null,
}));

vi.mock("@/lib/db", async () => {
  const { createTestDb } = await import("@/lib/db/test-utils");
  const created = createTestDb();
  return { db: created.db, sqlite: created.sqlite, ensureDbReady: vi.fn() };
});

vi.mock("@/lib/events/emit", () => ({ emitTicketMoved: vi.fn() }));

vi.mock("@/lib/workflow/transition-service", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/workflow/transition-service")
  >("@/lib/workflow/transition-service");
  return {
    ...actual,
    applyEpicCascadeTransition: (
      opts: Parameters<typeof actual.applyEpicCascadeTransition>[0]
    ) =>
      serviceMocks.epicCascadeError
        ? { valid: false, error: serviceMocks.epicCascadeError }
        : actual.applyEpicCascadeTransition(opts),
    // Refuse one story's WRITE while its validation still passes — the
    // guard changing state between the two passes.
    applyStoryTransition: (
      opts: Parameters<typeof actual.applyStoryTransition>[0]
    ) =>
      !opts.validateOnly && opts.userStoryId === serviceMocks.refusedStoryId
        ? { valid: false, error: "story guard refused mid-cascade" }
        : actual.applyStoryTransition(opts),
  };
});

const { db } = await import("@/lib/db");
const { epics, projects, ticketActivityLog, userStories } = await import(
  "@/lib/db/schema"
);
const { transitionBuildCompleted, transitionReviewRejected } = await import(
  "@/lib/workflow/automatic-transitions"
);

let sequence = 0;

function seedEpic(status: string, storyStatuses: string[]) {
  sequence += 1;
  const projectId = `project-${sequence}`;
  const epicId = `epic-${sequence}`;
  db.insert(projects).values({ id: projectId, name: "Partial" }).run();
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

function reasons(epicId: string) {
  return db
    .select()
    .from(ticketActivityLog)
    .where(eq(ticketActivityLog.epicId, epicId))
    .all()
    .map((row) => row.reason ?? "");
}

beforeEach(() => {
  serviceMocks.epicCascadeError = null;
  serviceMocks.refusedStoryId = null;
  db.delete(ticketActivityLog).run();
  db.delete(userStories).run();
  db.delete(epics).run();
  db.delete(projects).run();
});

describe("a half-applied cascade names the stories that moved", () => {
  it("names them when the epic promotion is refused after the stories moved", () => {
    const { projectId, epicId, storyIds } = seedEpic("in_progress", [
      "in_progress",
      "in_progress",
      "in_progress",
    ]);
    serviceMocks.epicCascadeError = "another session owns this ticket";

    const result = transitionBuildCompleted({
      projectId,
      epicId,
      scope: "epic",
      sessionId: "build-session",
    });

    expect(result).toMatchObject({ valid: false });
    // The stories really are ahead of the epic now — the trail has to say so.
    expect(
      db.select().from(userStories).where(eq(userStories.id, storyIds[0])).get()
        ?.status
    ).toBe("review");
    const held = reasons(epicId).find((reason) =>
      reason.includes("review promotion was refused")
    );
    expect(held).toBeDefined();
    expect(held).toContain("3 stories");
    for (const storyId of storyIds) expect(held).toContain(storyId);
  });

  it("names them when a later story write is refused mid-cascade", () => {
    const { projectId, epicId, storyIds } = seedEpic("in_progress", [
      "in_progress",
      "in_progress",
    ]);
    serviceMocks.refusedStoryId = storyIds[1];

    const result = transitionBuildCompleted({
      projectId,
      epicId,
      scope: "epic",
      sessionId: "build-session",
    });

    expect(result).toMatchObject({ valid: false });
    const held = reasons(epicId).find((reason) =>
      reason.includes("review promotion was refused")
    );
    expect(held).toContain("1 story");
    expect(held).toContain(storyIds[0]);
  });

  it("names them when a review rejection stops part-way through its stories", () => {
    const { projectId, epicId, storyIds } = seedEpic("review", [
      "review",
      "review",
      "review",
    ]);
    serviceMocks.refusedStoryId = storyIds[1];

    expect(() =>
      transitionReviewRejected({
        projectId,
        epicId,
        scope: "epic",
        sessionId: "review-session",
        reason: "Review requested changes",
      })
    ).toThrow();

    const partial = reasons(epicId).find((reason) =>
      reason.includes("story guard refused mid-cascade")
    );
    expect(partial).toBeDefined();
    expect(partial).toContain(storyIds[0]);
  });
});
