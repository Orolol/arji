/**
 * Learned project memory — auto-distillation trigger guards (pure matrix in
 * lib/workflow/memory-distill.ts) and the 'memory_auto_distill' setting
 * parser. The end-to-end trigger (hook -> dispatch -> doc replacement) is
 * covered by memory-distill-dispatch.test.ts; this file pins the decision
 * table exhaustively:
 *
 *   - OFF BY DEFAULT (setting absent/false denies everything),
 *   - never distill a distill session,
 *   - never on failures/cancellations,
 *   - build-type source sessions only,
 *   - asked_question holds are not distilled,
 *   - no duplicate while a distill is already pending.
 */
import { describe, it, expect } from "vitest";
import {
  AUTO_DISTILL_SOURCE_AGENT_TYPES,
  evaluateAutoDistillGuards,
  evaluateDistillSourceEligibility,
  type AutoDistillCandidateSession,
} from "@/lib/workflow/memory-distill";
import { parseMemoryAutoDistillSetting } from "@/lib/documents/memory-constants";

function session(
  overrides: Partial<AutoDistillCandidateSession> = {}
): AutoDistillCandidateSession {
  return {
    id: "sess-1",
    projectId: "proj-1",
    agentType: "build",
    status: "completed",
    outcome: "answered",
    batchRunId: null,
    ...overrides,
  };
}

function evaluate(input: {
  enabled?: boolean;
  session?: AutoDistillCandidateSession | null;
  hasPendingDistill?: boolean;
  dreamWillFollow?: boolean;
}) {
  return evaluateAutoDistillGuards({
    enabled: input.enabled ?? true,
    session: input.session === undefined ? session() : input.session,
    hasPendingDistill: input.hasPendingDistill ?? false,
    dreamWillFollow: input.dreamWillFollow ?? false,
  });
}

describe("evaluateAutoDistillGuards", () => {
  it("denies everything when the setting is off (the default)", () => {
    const decision = evaluate({ enabled: false });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("off");
  });

  it("denies unknown sessions", () => {
    expect(evaluate({ session: null }).allowed).toBe(false);
  });

  it("denies non-completed statuses (failed, cancelled, running, queued)", () => {
    for (const status of ["failed", "cancelled", "running", "queued"]) {
      const decision = evaluate({ session: session({ status }) });
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toContain(status);
    }
  });

  it("never distills a distill session, even when it completed", () => {
    const decision = evaluate({
      session: session({ agentType: "memory_distill" }),
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("never distill a distill");
  });

  it("denies non-build agent types", () => {
    for (const agentType of [
      "review_code",
      "review_security",
      "merge",
      "tech_check",
      "e2e_test",
      "release_notes",
      null,
    ]) {
      expect(evaluate({ session: session({ agentType }) }).allowed).toBe(false);
    }
  });

  it("denies sessions that ended by asking a question", () => {
    const decision = evaluate({
      session: session({ outcome: "asked_question" }),
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("question");
  });

  it("denies when a distill is already pending for the project", () => {
    const decision = evaluate({ hasPendingDistill: true });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("already pending");
  });

  it("denies sessions without a project", () => {
    expect(evaluate({ session: session({ projectId: null }) }).allowed).toBe(
      false
    );
  });

  it("allows completed build-type sessions when enabled and nothing pending", () => {
    expect(AUTO_DISTILL_SOURCE_AGENT_TYPES).toEqual([
      "build",
      "ticket_build",
      "team_build",
    ]);
    for (const agentType of AUTO_DISTILL_SOURCE_AGENT_TYPES) {
      const decision = evaluate({ session: session({ agentType }) });
      expect(decision).toEqual({ allowed: true, reason: "eligible" });
    }
  });

  it("allows silent completions (only asked_question is held back)", () => {
    expect(evaluate({ session: session({ outcome: "silent" }) }).allowed).toBe(
      true
    );
    // Legacy rows without a verdict are still eligible.
    expect(evaluate({ session: session({ outcome: null }) }).allowed).toBe(
      true
    );
  });
});

/**
 * The manual endpoint used to take any session id belonging to the project,
 * so a direct POST could distill a dream or a run that never finished. The
 * rule lives here, next to the auto matrix, because both paths must ask the
 * same question — and it is deliberately LOOSER than the auto matrix, since
 * the manual button is offered on reviews and QA runs too.
 */
describe("evaluateDistillSourceEligibility", () => {
  it("rejects a missing source (the caller's 404 case)", () => {
    const result = evaluateDistillSourceEligibility(null);
    expect(result.eligible).toBe(false);
    expect(result.reason).toContain("not found");
  });

  it.each(["dreaming", "memory_distill"])(
    "rejects the %s memory writer, however it ended",
    (agentType) => {
      const result = evaluateDistillSourceEligibility({
        agentType,
        status: "completed",
      });
      expect(result.eligible).toBe(false);
      expect(result.reason).toContain("cannot itself be distilled");
    }
  );

  it.each(["queued", "running", "failed", "cancelled", null])(
    "rejects a source whose status is %s",
    (status) => {
      const result = evaluateDistillSourceEligibility({
        agentType: "build",
        status,
      });
      expect(result.eligible).toBe(false);
      expect(result.reason).toContain("completed");
    }
  );

  it.each(["build", "ticket_build", "team_build", "review_code", "tech_check", null])(
    "accepts a completed %s session",
    (agentType) => {
      expect(
        evaluateDistillSourceEligibility({ agentType, status: "completed" })
      ).toEqual({ eligible: true, reason: "" });
    }
  );
});

/**
 * Both memory writers take the same exclusive lock, and the night-run dream is
 * attempted EXACTLY ONCE at the run's terminal choke point. An auto-distill
 * still holding the lock at that instant does not delay the dream — it cancels
 * it, for good. So the distill stands down instead.
 */
describe("night-run dream vs auto-distill", () => {
  it("denies the distill when a night-run dream will cover the run", () => {
    const decision = evaluate({
      session: session({ batchRunId: "night_abc" }),
      dreamWillFollow: true,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("night-run dream");
  });

  it("allows the distill when no dream will follow", () => {
    expect(
      evaluate({
        session: session({ batchRunId: "night_abc" }),
        dreamWillFollow: false,
      }).allowed
    ).toBe(true);
  });

  it("stands down BEFORE the pending-writer check, so the reason is the real one", () => {
    const decision = evaluate({
      session: session({ batchRunId: "night_abc" }),
      dreamWillFollow: true,
      hasPendingDistill: true,
    });
    expect(decision.reason).toContain("night-run dream");
  });
});

describe("parseMemoryAutoDistillSetting", () => {
  it("is off for absent/garbage values (default off)", () => {
    expect(parseMemoryAutoDistillSetting(null)).toBe(false);
    expect(parseMemoryAutoDistillSetting(undefined)).toBe(false);
    expect(parseMemoryAutoDistillSetting("")).toBe(false);
    expect(parseMemoryAutoDistillSetting("nope")).toBe(false);
    expect(parseMemoryAutoDistillSetting(1)).toBe(false);
    expect(parseMemoryAutoDistillSetting({})).toBe(false);
  });

  it("is off for explicit false in every stored shape", () => {
    expect(parseMemoryAutoDistillSetting(false)).toBe(false);
    expect(parseMemoryAutoDistillSetting("false")).toBe(false);
    expect(parseMemoryAutoDistillSetting('"false"')).toBe(false);
  });

  it("is on for true in every stored shape", () => {
    expect(parseMemoryAutoDistillSetting(true)).toBe(true);
    // Settings PATCH stores JSON.stringify(true) === "true".
    expect(parseMemoryAutoDistillSetting("true")).toBe(true);
    // Double-encoded string value.
    expect(parseMemoryAutoDistillSetting('"true"')).toBe(true);
    expect(parseMemoryAutoDistillSetting(" TRUE ")).toBe(true);
  });
});
