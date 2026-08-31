/**
 * Dismissing a "Your turn" signal.
 *
 * Two halves, deliberately separated:
 *  - `applyDeskDismissals` is pure, so the rule ("hidden until a NEWER signal
 *    of the same kind arrives") is tested on plain objects;
 *  - `POST /api/desk/dismiss` runs against the real migrated schema, which is
 *    what proves the composite-PK upsert and the 400s, and that dismissing
 *    writes NOTHING to the board.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/lib/db", async () => {
  const { createTestDb } = await import("@/lib/db/test-utils");
  const created = createTestDb();
  return { db: created.db, sqlite: created.sqlite, ensureDbReady: vi.fn() };
});

const { db } = await import("@/lib/db");
const { projects, epics, ticketActivityLog, deskDismissals } = await import(
  "@/lib/db/schema"
);
const { POST } = await import("@/app/api/desk/dismiss/route");
const { applyDeskDismissals } = await import("@/lib/control-desk/aggregate");
import type {
  DeskAwaitingReply,
  DeskConflict,
  DeskFailure,
} from "@/lib/control-desk/types";

/* ------------------------------------------------------------------ */
/* the pure rule                                                       */
/* ------------------------------------------------------------------ */

const ASKED = "2026-08-30T09:00:00.000Z";
const LATER = "2026-08-30T11:00:00.000Z";

function asks(o: Partial<DeskAwaitingReply> = {}): DeskAwaitingReply {
  return {
    epicId: "e1", projectId: "p1", readableId: "ARJ-1", title: "T",
    question: "?", author: "agent", askedAt: ASKED, unreadAi: false, ...o,
  };
}
function failure(o: Partial<DeskFailure> = {}): DeskFailure {
  return {
    epicId: "e2", projectId: "p1", readableId: "ARJ-2", title: "T",
    sessionId: "s1", error: "exit 1", agentType: "build", agentName: null,
    provider: null, namedAgentId: null, userStoryId: null, producedOutput: false,
    failedAt: ASKED, ...o,
  };
}
function conflict(o: Partial<DeskConflict> = {}): DeskConflict {
  return {
    epicId: "e3", projectId: "p1", readableId: "ARJ-3", title: "T",
    blocker: "merge_conflict", branchName: "feature/x", at: ASKED, ...o,
  };
}
const rows = () => ({
  awaitingReply: [asks()],
  failed: [failure()],
  conflicts: [conflict()],
});

describe("applyDeskDismissals", () => {
  it("is a no-op when nothing is dismissed", () => {
    expect(applyDeskDismissals(rows(), [])).toEqual(rows());
  });

  it.each([
    ["asks", "e1", "awaitingReply"],
    ["failed", "e2", "failed"],
    ["conflict", "e3", "conflicts"],
  ] as const)("hides a dismissed %s row", (kind, epicId, field) => {
    const out = applyDeskDismissals(rows(), [{ epicId, kind, signalAt: ASKED }]);
    expect(out[field]).toHaveLength(0);
    // The other two families are untouched.
    const others = (["awaitingReply", "failed", "conflicts"] as const).filter(
      (f) => f !== field,
    );
    for (const other of others) expect(out[other]).toHaveLength(1);
  });

  it("brings the row back when the signal is NEWER than the dismissal", () => {
    const out = applyDeskDismissals(
      { ...rows(), awaitingReply: [asks({ askedAt: LATER })] },
      [{ epicId: "e1", kind: "asks", signalAt: ASKED }],
    );
    expect(out.awaitingReply).toHaveLength(1);
  });

  it("keeps hiding a signal older than the dismissal", () => {
    const out = applyDeskDismissals(
      { ...rows(), awaitingReply: [asks({ askedAt: ASKED })] },
      [{ epicId: "e1", kind: "asks", signalAt: LATER }],
    );
    expect(out.awaitingReply).toHaveLength(0);
  });

  it("does not let one kind's dismissal hide another kind on the same epic", () => {
    const out = applyDeskDismissals(
      { awaitingReply: [asks({ epicId: "same" })], failed: [failure({ epicId: "same" })], conflicts: [] },
      [{ epicId: "same", kind: "asks", signalAt: ASKED }],
    );
    expect(out.awaitingReply).toHaveLength(0);
    expect(out.failed).toHaveLength(1);
  });

  it("compares instants, not strings, across timestamp formats", () => {
    // Same moment, different spelling: must still count as dismissed.
    const out = applyDeskDismissals(
      { ...rows(), awaitingReply: [asks({ askedAt: "2026-08-30T09:00:00.000Z" })] },
      [{ epicId: "e1", kind: "asks", signalAt: "2026-08-30T09:00:00Z" }],
    );
    expect(out.awaitingReply).toHaveLength(0);
  });

  it("keeps a null-timestamped signal dismissed rather than flickering it back", () => {
    const out = applyDeskDismissals(
      { ...rows(), awaitingReply: [asks({ askedAt: null })] },
      [{ epicId: "e1", kind: "asks", signalAt: null }],
    );
    expect(out.awaitingReply).toHaveLength(0);
  });

  it("shows a timestamped signal over a null dismissal", () => {
    const out = applyDeskDismissals(
      { ...rows(), awaitingReply: [asks({ askedAt: ASKED })] },
      [{ epicId: "e1", kind: "asks", signalAt: null }],
    );
    expect(out.awaitingReply).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ */
/* the route                                                           */
/* ------------------------------------------------------------------ */

function post(body: unknown) {
  return POST(
    new Request("http://localhost/api/desk/dismiss", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }) as never,
  );
}

describe("POST /api/desk/dismiss", () => {
  beforeEach(() => {
    db.delete(deskDismissals).run();
    db.delete(ticketActivityLog).run();
    db.delete(epics).run();
    db.delete(projects).run();
    db.insert(projects).values({ id: "p1", name: "Arij", gitRepoPath: "/tmp/p1" }).run();
    db.insert(epics)
      .values({ id: "e1", projectId: "p1", title: "T", status: "in_progress", position: 0 })
      .run();
  });

  it("stores the dismissed signal's own timestamp", async () => {
    const res = await post({ epicId: "e1", kind: "asks", signalAt: ASKED });
    expect(res.status).toBe(200);

    const stored = db.select().from(deskDismissals).all();
    expect(stored).toHaveLength(1);
    expect(stored[0].epicId).toBe("e1");
    expect(stored[0].kind).toBe("asks");
    expect(stored[0].signalAt).toBe(ASKED);
    expect(stored[0].dismissedAt).toBeTruthy();
  });

  it("re-arms rather than duplicating on the same (epic, kind)", async () => {
    await post({ epicId: "e1", kind: "asks", signalAt: ASKED });
    await post({ epicId: "e1", kind: "asks", signalAt: LATER });
    const stored = db.select().from(deskDismissals).all();
    expect(stored).toHaveLength(1);
    expect(stored[0].signalAt).toBe(LATER);
  });

  it("keeps the three families independent", async () => {
    await post({ epicId: "e1", kind: "asks", signalAt: ASKED });
    await post({ epicId: "e1", kind: "failed", signalAt: ASKED });
    await post({ epicId: "e1", kind: "conflict", signalAt: ASKED });
    expect(db.select().from(deskDismissals).all()).toHaveLength(3);
  });

  it("accepts a null signalAt", async () => {
    const res = await post({ epicId: "e1", kind: "asks", signalAt: null });
    expect(res.status).toBe(200);
    expect(db.select().from(deskDismissals).all()[0].signalAt).toBeNull();
  });

  it.each([
    ["an unknown kind", { epicId: "e1", kind: "nope", signalAt: ASKED }],
    ["a missing epicId", { kind: "asks", signalAt: ASKED }],
    ["an empty epicId", { epicId: "", kind: "asks", signalAt: ASKED }],
    ["a malformed signalAt", { epicId: "e1", kind: "asks", signalAt: "not-a-date" }],
    ["a non-string signalAt", { epicId: "e1", kind: "asks", signalAt: 42 }],
    ["a missing kind", { epicId: "e1", signalAt: ASKED }],
  ])("rejects %s with 400 and a machine-readable payload, never a 500", async (_label, body) => {
    const res = await post(body);
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string; details?: Record<string, string[]> };
    expect(json.error).toBe("Validation failed");
    expect(json.details).toBeTruthy();
    expect(db.select().from(deskDismissals).all()).toHaveLength(0);
  });

  it("rejects a non-JSON body with 400", async () => {
    const res = await POST(
      new Request("http://localhost/api/desk/dismiss", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{not json",
      }) as never,
    );
    expect(res.status).toBe(400);
  });

  it("changes NO ticket status and writes NO activity entry", async () => {
    await post({ epicId: "e1", kind: "asks", signalAt: ASKED });

    const epic = db.select().from(epics).all()[0];
    expect(epic.status).toBe("in_progress");
    expect(db.select().from(ticketActivityLog).all()).toHaveLength(0);
  });
});
