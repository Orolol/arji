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

  it("allows review -> to_merge (passing review)", () => {
    expect(isAllowedTransition("review", "to_merge")).toBe(true);
  });

  it("allows to_merge -> done (the merge)", () => {
    expect(isAllowedTransition("to_merge", "done")).toBe(true);
  });

  it("allows to_merge -> review and to_merge -> in_progress (send back)", () => {
    expect(isAllowedTransition("to_merge", "review")).toBe(true);
    expect(isAllowedTransition("to_merge", "in_progress")).toBe(true);
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

  it("rejects review -> done (the merge boundary sits between)", () => {
    expect(isAllowedTransition("review", "done")).toBe(false);
  });

  it("rejects in_progress -> to_merge (skip review)", () => {
    expect(isAllowedTransition("in_progress", "to_merge")).toBe(false);
  });

  it("same status is always valid", () => {
    expect(isAllowedTransition("backlog", "backlog")).toBe(true);
    expect(isAllowedTransition("done", "done")).toBe(true);
  });

  // Stories have their own graph: no branch of their own means no merge
  // boundary. A reviewed story closes by approval or its epic's merge.
  it("story graph: review -> done, and no to_merge at all", () => {
    expect(isAllowedTransition("review", "done", "story")).toBe(true);
    expect(isAllowedTransition("review", "to_merge", "story")).toBe(false);
    expect(isAllowedTransition("to_merge", "done", "story")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Guard: cannot move to To Merge without completed review
// ---------------------------------------------------------------------------

describe("validateTransition — To Merge requires completed review", () => {
  it("rejects review -> to_merge without completed review", () => {
    const result = validateTransition(
      ctx("review", "to_merge", { hasCompletedReview: false })
    );
    expect(result.valid).toBe(false);
    expect(result.error).toContain("no completed review");
  });

  it("allows a human drag to to_merge with a completed review", () => {
    const result = validateTransition(
      ctx("review", "to_merge", { hasCompletedReview: true, source: "drag" })
    );
    expect(result.valid).toBe(true);
  });

  it("names the broken channel when every completed review is unverifiable", () => {
    // Ordered before the generic refusal so the operator gets the actionable
    // sentence (see review-unverifiable-gate.test.ts for the full contract).
    const result = validateTransition(
      ctx("review", "to_merge", {
        hasCompletedReview: false,
        hasUnverifiableReview: true,
      })
    );
    expect(result.valid).toBe(false);
    expect(result.error).toContain("submit_findings");
  });
});

// ---------------------------------------------------------------------------
// Guard: agents reach To Merge only through a review verdict
// ---------------------------------------------------------------------------

describe("validateTransition — agents reach To Merge only through review", () => {
  it("rejects an agent poking update_ticket_status (source api)", () => {
    const result = validateTransition(
      ctx("review", "to_merge", {
        hasCompletedReview: true,
        actor: "agent",
        source: "api",
      })
    );
    expect(result.valid).toBe(false);
    expect(result.error).toContain("only a passing review verdict");
  });

  it("allows the review drivers (source review)", () => {
    const result = validateTransition(
      ctx("review", "to_merge", {
        hasCompletedReview: true,
        actor: "agent",
        source: "review",
      })
    );
    expect(result.valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Guard: to_merge → done requires the merge — the merge IS the approval
// ---------------------------------------------------------------------------

describe("validateTransition — Done requires the merge", () => {
  it("rejects to_merge -> done via drag (no merge)", () => {
    const result = validateTransition(
      ctx("to_merge", "done", {
        hasCompletedReview: true,
        source: "drag",
      })
    );
    expect(result.valid).toBe(false);
    expect(result.error).toContain("successful merge");
  });

  it("rejects to_merge -> done via API (no merge)", () => {
    const result = validateTransition(
      ctx("to_merge", "done", {
        hasCompletedReview: true,
        source: "api",
      })
    );
    expect(result.valid).toBe(false);
    expect(result.error).toContain("successful merge");
  });

  it("rejects to_merge -> done without source (no merge)", () => {
    const result = validateTransition(
      ctx("to_merge", "done", {
        hasCompletedReview: true,
      })
    );
    expect(result.valid).toBe(false);
    expect(result.error).toContain("successful merge");
  });

  it("rejects to_merge -> done via approve source (no manual approve step)", () => {
    const result = validateTransition(
      ctx("to_merge", "done", {
        hasCompletedReview: true,
        source: "approve",
      })
    );
    expect(result.valid).toBe(false);
    expect(result.error).toContain("successful merge");
  });

  it("allows to_merge -> done via merge source", () => {
    const result = validateTransition(
      ctx("to_merge", "done", {
        hasCompletedReview: true,
        source: "merge",
      })
    );
    expect(result.valid).toBe(true);
  });

  // Stories are the one exception: no branch of their own, so an explicit
  // human approval or the parent epic's merge cascade closes them.
  it("allows story review -> done via approve or merge, never via drag", () => {
    const story = { targetKind: "story" as const, hasCompletedReview: true };
    expect(
      validateTransition(ctx("review", "done", { ...story, source: "approve" }))
        .valid
    ).toBe(true);
    expect(
      validateTransition(ctx("review", "done", { ...story, source: "merge" }))
        .valid
    ).toBe(true);
    const dragged = validateTransition(
      ctx("review", "done", { ...story, source: "drag" })
    );
    expect(dragged.valid).toBe(false);
    expect(dragged.error).toContain("approving it or by merging");
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

  it("refuses the owning session moving its own ticket anywhere but review", () => {
    // The exemption is the promotion the terminal handler makes anyway;
    // a demote by the live owner would strand the run's terminal handler.
    for (const toStatus of ["todo", "backlog"]) {
      const result = validateTransition(
        ctx("in_progress", toStatus as KanbanStatus, {
          hasRunningSession: true,
          ownsInProgress: true,
        })
      );
      expect(result.valid).toBe(false);
      expect(result.error).toContain("only move its in-progress ticket to review");
    }
  });

  it("blames the other session in the lock refusal (not the acting one)", () => {
    const result = validateTransition(
      ctx("in_progress", "review", {
        hasRunningSession: true,
        actor: "agent",
      })
    );
    expect(result.valid).toBe(false);
    expect(result.error).toContain("another agent session");
    expect(result.error).toContain("queued or running");
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

  it("never lets the exemption bypass the merge-source guard on Done", () => {
    const result = validateTransition(
      ctx("to_merge", "done", {
        hasRunningSession: true,
        ownsInProgress: true,
        hasCompletedReview: true,
        actor: "agent",
        source: "api",
      })
    );
    expect(result.valid).toBe(false);
    expect(result.error).toContain("successful merge");
  });

  it("never lets the exemption bypass the completed-review guard", () => {
    const result = validateTransition(
      ctx("review", "to_merge", {
        hasRunningSession: true,
        ownsInProgress: true,
        hasCompletedReview: false,
        actor: "agent",
        source: "review",
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
    expect(isAllowedTransition("to_merge", "released")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Both UI and API transitions use the same validation
// ---------------------------------------------------------------------------

describe("validateTransition — actor types", () => {
  it("applies same rules for user actor", () => {
    const result = validateTransition(
      ctx("to_merge", "done", { actor: "user", hasCompletedReview: true })
    );
    expect(result.valid).toBe(false);
  });

  it("applies same rules for agent actor", () => {
    const result = validateTransition(
      ctx("to_merge", "done", { actor: "agent", hasCompletedReview: true })
    );
    expect(result.valid).toBe(false);
  });

  it("applies same rules for system actor", () => {
    const result = validateTransition(
      ctx("to_merge", "done", { actor: "system", hasCompletedReview: true })
    );
    expect(result.valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Refinement guardrail — source: "refinement" is pinned to Backlog / To do
// ---------------------------------------------------------------------------

describe("refinement source guardrail", () => {
  it("allows backlog -> todo", () => {
    const result = validateTransition(
      ctx("backlog", "todo", { actor: "agent", source: "refinement" })
    );
    expect(result.valid).toBe(true);
  });

  it("allows the demotion todo -> backlog", () => {
    const result = validateTransition(
      ctx("todo", "backlog", { actor: "agent", source: "refinement" })
    );
    expect(result.valid).toBe(true);
  });

  it.each([
    ["backlog", "in_progress"],
    ["todo", "in_progress"],
    ["in_progress", "review"],
    ["in_progress", "todo"],
    ["review", "in_progress"],
    ["review", "to_merge"],
  ] as Array<[KanbanStatus, KanbanStatus]>)(
    "refuses %s -> %s",
    (from, to) => {
      const result = validateTransition(
        ctx(from, to, { actor: "agent", source: "refinement" })
      );
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Refinement may only move tickets");
    }
  );

  it("does not constrain other sources", () => {
    const result = validateTransition(
      ctx("backlog", "in_progress", { actor: "user", source: "drag" })
    );
    expect(result.valid).toBe(true);
  });

  it("refuses the escape hatch even for a system actor", () => {
    const result = validateTransition(
      ctx("todo", "in_progress", { actor: "system", source: "refinement" })
    );
    expect(result.valid).toBe(false);
  });
});
