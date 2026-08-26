/**
 * The shared session-continuity capability lists.
 *
 * These used to be copy-pasted inline in six dispatch routes, which is how
 * Pi ended up declared resumable while every route still hardcoded
 * Claude/Gemini/Codex. These tests pin the three questions apart.
 *
 * Since the 2026-08 MCP cleanup the registered providers are exactly
 * claude-code, codex and oh-my-pi.
 */
import { describe, expect, it } from "vitest";
import {
  isResumableProvider,
  providerAcceptsAssignedSessionId,
  providerReportsOwnSessionId,
} from "@/lib/agent-sessions/resume-capability";
import { PROVIDER_OPTIONS } from "@/lib/agent-config/constants";

describe("isResumableProvider", () => {
  it("accepts every provider whose CLI can continue a session", () => {
    for (const provider of ["claude-code", "oh-my-pi"]) {
      expect(isResumableProvider(provider), provider).toBe(true);
    }
  });

  it("rejects providers with no usable resume handle", () => {
    expect(isResumableProvider("codex")).toBe(false);
    // Legacy DB rows may still say "pi" (removed provider); they must never
    // be offered for resume.
    expect(isResumableProvider("pi")).toBe(false);
  });

  it("rejects unknown values", () => {
    expect(isResumableProvider("nonexistent")).toBe(false);
    expect(isResumableProvider("")).toBe(false);
  });

  it("classifies every known provider one way or the other", () => {
    for (const provider of PROVIDER_OPTIONS) {
      expect(typeof isResumableProvider(provider), provider).toBe("boolean");
    }
  });
});

describe("providerReportsOwnSessionId", () => {
  it("is true only for oh-my-pi, which prints pi's session header", () => {
    expect(providerReportsOwnSessionId("oh-my-pi")).toBe(true);
  });

  it("is false for providers dispatch has to name itself", () => {
    for (const provider of ["claude-code", "codex"]) {
      expect(providerReportsOwnSessionId(provider), provider).toBe(false);
    }
  });
});

describe("providerAcceptsAssignedSessionId", () => {
  it("covers the providers routes pre-assign a UUID for", () => {
    expect(providerAcceptsAssignedSessionId("claude-code")).toBe(true);
    expect(providerAcceptsAssignedSessionId("codex")).toBe(true);
  });

  /**
   * The two questions must stay distinct: oh-my-pi can resume, but assigning
   * it an id would persist one the CLI never used and replay it into the
   * resume flag on a later run.
   */
  it("never pre-assigns an id to a provider that reports its own", () => {
    for (const provider of PROVIDER_OPTIONS) {
      if (providerReportsOwnSessionId(provider)) {
        expect(providerAcceptsAssignedSessionId(provider), provider).toBe(false);
      }
    }
    expect(providerAcceptsAssignedSessionId("oh-my-pi")).toBe(false);
  });
});
