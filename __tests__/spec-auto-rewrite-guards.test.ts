/**
 * Spec auto-rewrite ("spec vivante") — pure guard matrix
 * (lib/workflow/spec-auto-rewrite.ts) and the 'spec_auto_rewrite' setting
 * parser. The end-to-end trigger (release -> dispatch -> spec replacement)
 * is covered by spec-auto-rewrite-dispatch.test.ts; this file pins the
 * decision table exhaustively:
 *
 *   - OFF BY DEFAULT (setting absent/false denies everything),
 *   - never without a real release row,
 *   - no dispatch while ANY spec_generation session (auto OR manual) is
 *     queued/running for the project.
 */
import { describe, it, expect } from "vitest";
import {
  SPEC_REWRITE_AGENT_TYPE,
  evaluateSpecAutoRewriteGuards,
} from "@/lib/workflow/spec-auto-rewrite";
import { parseSpecAutoRewriteSetting } from "@/lib/workflow/spec-rewrite-constants";

function evaluate(input: {
  enabled?: boolean;
  hasRelease?: boolean;
  hasPendingSpecSession?: boolean;
}) {
  return evaluateSpecAutoRewriteGuards({
    enabled: input.enabled ?? true,
    hasRelease: input.hasRelease ?? true,
    hasPendingSpecSession: input.hasPendingSpecSession ?? false,
  });
}

describe("evaluateSpecAutoRewriteGuards", () => {
  it("denies everything when the setting is off (the default)", () => {
    expect(evaluate({ enabled: false }).allowed).toBe(false);
    expect(evaluate({ enabled: false }).reason).toContain("setting is off");
  });

  it("denies when the release row cannot be found", () => {
    const decision = evaluate({ hasRelease: false });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("release");
  });

  it("denies while a spec_generation session is already pending", () => {
    const decision = evaluate({ hasPendingSpecSession: true });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("already queued/running");
  });

  it("allows an enabled trigger with a release and nothing pending", () => {
    expect(evaluate({})).toEqual({ allowed: true, reason: "ok" });
  });

  it("shares one agent type with the manual spec update flow", () => {
    // The mutual-exclusion guarantee relies on BOTH writers using
    // 'spec_generation': the manual flow's guard then sees auto sessions
    // and this guard sees manual ones.
    expect(SPEC_REWRITE_AGENT_TYPE).toBe("spec_generation");
  });
});

describe("parseSpecAutoRewriteSetting", () => {
  it("parses JSON booleans and raw strings, defaulting off", () => {
    expect(parseSpecAutoRewriteSetting(true)).toBe(true);
    expect(parseSpecAutoRewriteSetting("true")).toBe(true);
    expect(parseSpecAutoRewriteSetting('"true"')).toBe(true);
    expect(parseSpecAutoRewriteSetting("TRUE")).toBe(true);
    expect(parseSpecAutoRewriteSetting(false)).toBe(false);
    expect(parseSpecAutoRewriteSetting("false")).toBe(false);
    expect(parseSpecAutoRewriteSetting(undefined)).toBe(false);
    expect(parseSpecAutoRewriteSetting(null)).toBe(false);
    expect(parseSpecAutoRewriteSetting(1)).toBe(false);
    expect(parseSpecAutoRewriteSetting("garbage")).toBe(false);
  });
});
