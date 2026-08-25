import { describe, it, expect } from "vitest";
import {
  isAllowedTransition,
  validateTransition,
  type TransitionContext,
} from "@/lib/workflow/engine";
import type { KanbanStatus } from "@/lib/types/kanban";

// ---------------------------------------------------------------------------
// Helper to create a minimal TransitionContext
// ---------------------------------------------------------------------------

function ctx(
  from: KanbanStatus,
  to: KanbanStatus,
  overrides: Partial<TransitionContext> = {}
): TransitionContext {
  return {
    epicId: "epic-1",
    fromStatus: from,
    toStatus: to,
    hasOpenReviewComments: false,
    hasCompletedReview: false,
    hasRunningSession: false,
    actor: "user",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Structural transitions (isAllowedTransition)
// ---------------------------------------------------------------------------

describe("isAllowedTransition", () => {
  it("allows backlog -> todo", () => {
    expect(isAllowedTransition("backlog", "todo")).toBe(true);
  });

  it("allows backlog -> in_progress", () => {
    expect(isAllowedTransition("backlog", "in_progress")).toBe(true);
  });

  it("allows todo -> in_progress", () => {
    expect(isAllowedTransition("todo", "in_progress")).toBe(true);
  });

  it("allows in_progress -> review", () => {
    expect(isAllowedTransition("in_progress", "review")).toBe(true);
  });

  it("allows review -> done", () => {
    expect(isAllowedTransition("review", "done")).toBe(true);
  });

  it("allows review -> in_progress (send back)", () => {
    expect(isAllowedTransition("review", "in_progress")).toBe(true);
  });

  it("allows done -> review (reopen)", () => {
    expect(isAllowedTransition("done", "review")).toBe(true);
  });

  it("allows done -> in_progress (reopen)", () => {
    expect(isAllowedTransition("done", "in_progress")).toBe(true);
  });

  it("rejects backlog -> done (skip)", () => {
    expect(isAllowedTransition("backlog", "done")).toBe(false);
  });

  it("rejects backlog -> review (skip)", () => {
    expect(isAllowedTransition("backlog", "review")).toBe(false);
  });

  it("rejects todo -> done (skip)", () => {
    expect(isAllowedTransition("todo", "done")).toBe(false);
  });

  it("rejects todo -> review (skip)", () => {
    expect(isAllowedTransition("todo", "review")).toBe(false);
  });

  it("rejects in_progress -> done (skip review)", () => {
    expect(isAllowedTransition("in_progress", "done")).toBe(false);
  });

  it("same status is always valid", () => {
    expect(isAllowedTransition("backlog", "backlog")).toBe(true);
    expect(isAllowedTransition("done", "done")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Guard: cannot move to Done without completed review
// ---------------------------------------------------------------------------

describe("validateTransition — Done requires completed review", () => {
  it("rejects review -> done without completed review", () => {
    const result = validateTransition(
      ctx("review", "done", { hasCompletedReview: false })
    );
    expect(result.valid).toBe(false);
    expect(result.error).toContain("no completed review");
  });

  it("allows review -> done with completed review, no open comments, via approve", () => {
    const result = validateTransition(
      ctx("review", "done", { hasCompletedReview: true, source: "approve" })
    );
    expect(result.valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Guard: cannot move to Done with unresolved review comments
// ---------------------------------------------------------------------------

describe("validateTransition — Done requires resolved comments", () => {
  it("rejects review -> done with open review comments", () => {
    const result = validateTransition(
      ctx("review", "done", {
        hasCompletedReview: true,
        hasOpenReviewComments: true,
      })
    );
    expect(result.valid).toBe(false);
    expect(result.error).toContain("unresolved review comments");
  });

  it("allows review -> done when all comments resolved via approve", () => {
    const result = validateTransition(
      ctx("review", "done", {
        hasCompletedReview: true,
        hasOpenReviewComments: false,
        source: "approve",
      })
    );
    expect(result.valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Guard: review → done requires approve or merge source
// ---------------------------------------------------------------------------

describe("validateTransition — review to done requires approval", () => {
  it("rejects review -> done via drag (no approval)", () => {
    const result = validateTransition(
      ctx("review", "done", {
        hasCompletedReview: true,
        source: "drag",
      })
    );
    expect(result.valid).toBe(false);
    expect(result.error).toContain("manual approval is required");
  });

  it("rejects review -> done via API (no approval)", () => {
    const result = validateTransition(
      ctx("review", "done", {
        hasCompletedReview: true,
        source: "api",
      })
    );
    expect(result.valid).toBe(false);
    expect(result.error).toContain("manual approval is required");
  });

  it("rejects review -> done without source (no approval)", () => {
    const result = validateTransition(
      ctx("review", "done", {
        hasCompletedReview: true,
      })
    );
    expect(result.valid).toBe(false);
    expect(result.error).toContain("manual approval is required");
  });

  it("allows review -> done via approve source", () => {
    const result = validateTransition(
      ctx("review", "done", {
        hasCompletedReview: true,
        source: "approve",
      })
    );
    expect(result.valid).toBe(true);
  });

  it("allows review -> done via merge source", () => {
    const result = validateTransition(
      ctx("review", "done", {
        hasCompletedReview: true,
        source: "merge",
      })
    );
    expect(result.valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Same-column reorder is always valid
// ---------------------------------------------------------------------------

describe("validateTransition — same status reorder", () => {
  it("allows reorder within the same column", () => {
    const result = validateTransition(ctx("in_progress", "in_progress"));
    expect(result.valid).toBe(true);
  });
});

describe("validateTransition — active build ownership", () => {
  it("refuses to move an in-progress ticket while a session is active", () => {
    const result = validateTransition(
      ctx("in_progress", "review", { hasRunningSession: true })
    );
    expect(result.valid).toBe(false);
    expect(result.error).toContain("queued or running");
  });

  it("allows the terminal handler to promote after the session settles", () => {
    expect(
      validateTransition(
        ctx("in_progress", "review", { hasRunningSession: false })
      ).valid
    ).toBe(true);
  });

  // The session that owns the ticket is the session the lock protects: it
  // may move its own ticket out of in_progress while it is still live.
  it("allows the owning session to move its own ticket to review", () => {
    const result = validateTransition(
      ctx("in_progress", "review", {
        hasRunningSession: true,
        ownsInProgress: true,
        actor: "agent",
      })
    );
    expect(result.valid).toBe(true);
  });

  it("allows the owning session to move its own ticket to other reachable columns", () => {
    expect(
      validateTransition(
        ctx("in_progress", "todo", { hasRunningSession: true, ownsInProgress: true })
      ).valid
    ).toBe(true);
    expect(
      validateTransition(
        ctx("in_progress", "backlog", { hasRunningSession: true, ownsInProgress: true })
      ).valid
    ).toBe(true);
  });

  it("keeps the lock for a non-owning session (explicit false)", () => {
    const result = validateTransition(
      ctx("in_progress", "review", {
        hasRunningSession: true,
        ownsInProgress: false,
        actor: "agent",
      })
    );
    expect(result.valid).toBe(false);
    expect(result.error).toContain("queued or running");
  });

  it("keeps the lock when no ownership signal is present at all", () => {
    const result = validateTransition(
      ctx("in_progress", "review", { hasRunningSession: true, actor: "agent" })
    );
    expect(result.valid).toBe(false);
    expect(result.error).toContain("queued or running");
  });

  it("never lets the exemption bypass the review→done approval guard", () => {
    const result = validateTransition(
      ctx("review", "done", {
        hasRunningSession: true,
        ownsInProgress: true,
        hasCompletedReview: true,
        actor: "agent",
        source: "api",
      })
    );
    expect(result.valid).toBe(false);
    expect(result.error).toContain("manual approval is required");
  });

  it("never lets the exemption bypass the completed-review guard", () => {
    const result = validateTransition(
      ctx("review", "done", {
        hasRunningSession: true,
        ownsInProgress: true,
        hasCompletedReview: false,
        actor: "agent",
        source: "approve",
      })
    );
    expect(result.valid).toBe(false);
    expect(result.error).toContain("no completed review");
  });

  it("never lets the exemption open structurally invalid edges", () => {
    const result = validateTransition(
      ctx("in_progress", "done", { hasRunningSession: true, ownsInProgress: true })
    );
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Invalid transition");
  });
});

// ---------------------------------------------------------------------------
// Invalid structural transitions produce clear error
// ---------------------------------------------------------------------------

describe("validateTransition — invalid structure", () => {
  it("rejects backlog -> done with descriptive error", () => {
    const result = validateTransition(ctx("backlog", "done"));
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Invalid transition");
    expect(result.error).toContain("backlog");
    expect(result.error).toContain("done");
  });

  it("rejects in_progress -> done with descriptive error", () => {
    const result = validateTransition(ctx("in_progress", "done"));
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Invalid transition");
  });
});

// ---------------------------------------------------------------------------
// Guard: released state transitions
// ---------------------------------------------------------------------------

describe("validateTransition — released state", () => {
  it("allows done -> released with system actor and release source", () => {
    const result = validateTransition(
      ctx("done", "released", { actor: "system", source: "release" })
    );
    expect(result.valid).toBe(true);
  });

  it("rejects done -> released with user actor", () => {
    const result = validateTransition(
      ctx("done", "released", { actor: "user", source: "release" })
    );
    expect(result.valid).toBe(false);
    expect(result.error).toContain("only the system");
  });

  it("rejects done -> released with agent actor", () => {
    const result = validateTransition(
      ctx("done", "released", { actor: "agent", source: "release" })
    );
    expect(result.valid).toBe(false);
    expect(result.error).toContain("only the system");
  });

  it("rejects drag to released", () => {
    const result = validateTransition(
      ctx("done", "released", { actor: "system", source: "drag" })
    );
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Cannot drag");
  });

  it("rejects transition away from released", () => {
    const result = validateTransition(
      ctx("released", "done", { actor: "system" })
    );
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Invalid transition");
  });

  it("rejects any non-done -> released transition", () => {
    const result = validateTransition(
      ctx("review", "released", { actor: "system", source: "release" })
    );
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Invalid transition");
  });

  it("allows same-column reorder in released", () => {
    const result = validateTransition(ctx("released", "released"));
    expect(result.valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Structural: done -> released is allowed
// ---------------------------------------------------------------------------

describe("isAllowedTransition — released", () => {
  it("allows done -> released", () => {
    expect(isAllowedTransition("done", "released")).toBe(true);
  });

  it("rejects released -> any", () => {
    expect(isAllowedTransition("released", "done")).toBe(false);
    expect(isAllowedTransition("released", "backlog")).toBe(false);
    expect(isAllowedTransition("released", "review")).toBe(false);
  });

  it("rejects non-done -> released", () => {
    expect(isAllowedTransition("backlog", "released")).toBe(false);
    expect(isAllowedTransition("todo", "released")).toBe(false);
    expect(isAllowedTransition("in_progress", "released")).toBe(false);
    expect(isAllowedTransition("review", "released")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Both UI and API transitions use the same validation
// ---------------------------------------------------------------------------

describe("validateTransition — actor types", () => {
  it("applies same rules for user actor", () => {
    const result = validateTransition(
      ctx("review", "done", { actor: "user", hasCompletedReview: false })
    );
    expect(result.valid).toBe(false);
  });

  it("applies same rules for agent actor", () => {
    const result = validateTransition(
      ctx("review", "done", { actor: "agent", hasCompletedReview: false })
    );
    expect(result.valid).toBe(false);
  });

  it("applies same rules for system actor", () => {
    const result = validateTransition(
      ctx("review", "done", { actor: "system", hasCompletedReview: false })
    );
    expect(result.valid).toBe(false);
  });
});
