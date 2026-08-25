import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The verify gate must be TOTAL: whatever happens while it establishes
 * whether it even applies, it resolves — it never rejects.
 *
 * This matters because the pipeline runner's gate-crash path both fails the
 * run and parks the ticket out of `review`, with a reason that speaks of a
 * regression test. Applicability is decided before the gate knows the ticket
 * is a bug at all, so a thrown read there would pull a FEATURE epic out of
 * review and blame a check that never governs it. The database is mocked to
 * fail on every access, which is the only way to reach that branch — the
 * real `db` export is a lazy Proxy that `vi.spyOn` cannot intercept.
 */
vi.mock("@/lib/db", () => {
  const boom = () => {
    throw new Error("database is locked");
  };
  return { db: { select: boom, insert: boom, delete: boom, update: boom } };
});

import { createVerifyGate } from "@/lib/pipeline/verify";

describe("createVerifyGate totality", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("resolves to 'did not run' instead of throwing when the database fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const gate = createVerifyGate({
      projectId: "proj-1",
      epicId: "epic-1",
      userStoryId: null,
      scope: "epic",
    });

    await expect(gate("sess-1")).resolves.toEqual({
      ran: false,
      passed: null,
      result: null,
    });
    expect(warn).toHaveBeenCalledWith(
      "[pipeline verify] Could not establish gate applicability:",
      "database is locked"
    );
  });
});
