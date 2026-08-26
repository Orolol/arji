/**
 * Regression: clicking "Retry" on a failed epic card silently restarted the
 * work on Claude Code with a cold prompt.
 *
 * The handler posted to the batch build route with the board toolbar's
 * `namedAgentId` — null unless the user had picked an agent during this
 * visit — so the server fell through to the seeded default agent, and the
 * batch route has no resume parameter to begin with. A retry must instead
 * reuse the agent that failed and continue its session.
 */

import { describe, it, expect } from "vitest";
import { buildRetryDispatch } from "@/lib/agent-sessions/retry-dispatch";
import {
  selectLatestFailures,
  type FailedSessionInfo,
  type FailureCandidateSession,
} from "@/lib/agent-sessions/latest-failure";

function failure(overrides: Partial<FailedSessionInfo> = {}): FailedSessionInfo {
  return {
    sessionId: "sess-failed",
    error: "boom",
    agentType: "build",
    provider: "oh-my-pi",
    namedAgentId: "agent-omp",
    ...overrides,
  };
}

function session(
  overrides: Partial<FailureCandidateSession>
): FailureCandidateSession {
  return {
    id: "sess-1",
    kind: "agent_session",
    status: "failed",
    epicId: "e1",
    error: "boom",
    agentType: "build",
    provider: "oh-my-pi",
    namedAgentId: "agent-omp",
    createdAt: "2026-08-21 10:00:00",
    endedAt: "2026-08-21 10:00:30",
    ...overrides,
  };
}

describe("retry dispatch — reuse the failed agent, in resume mode", () => {
  it("retries on the agent that failed, not the toolbar's (empty) selection", () => {
    const { body } = buildRetryDispatch("proj-1", "e1", failure(), null);
    expect(body.namedAgentId).toBe("agent-omp");
  });

  it("does not let the toolbar selection override the agent that failed", () => {
    const { body } = buildRetryDispatch(
      "proj-1",
      "e1",
      failure(),
      "agent-claude-code"
    );
    expect(body.namedAgentId).toBe("agent-omp");
  });

  it("asks the route to resume the failed session", () => {
    const { body } = buildRetryDispatch("proj-1", "e1", failure(), null);
    expect(body.resumeSessionId).toBe("sess-failed");
  });

  it("targets the single-epic route, the only one that accepts a resume", () => {
    const { url } = buildRetryDispatch("proj-1", "e1", failure(), null);
    expect(url).toBe("/api/projects/proj-1/epics/e1/build");
  });

  it("falls back to the toolbar selection when the failure names no agent", () => {
    const { body } = buildRetryDispatch(
      "proj-1",
      "e1",
      failure({ namedAgentId: null }),
      "agent-picked"
    );
    expect(body.namedAgentId).toBe("agent-picked");
    // Another agent runs, so the stored CLI session id means nothing to it.
    expect(body.resumeSessionId).toBeUndefined();
  });

  it("does not resume a provider whose CLI cannot continue a session", () => {
    const { body } = buildRetryDispatch(
      "proj-1",
      "e1",
      failure({ provider: "codex" }),
      null
    );
    expect(body.namedAgentId).toBe("agent-omp");
    expect(body.resumeSessionId).toBeUndefined();
  });

  it("does not graft the build retry onto a failed review thread", () => {
    const { body } = buildRetryDispatch(
      "proj-1",
      "e1",
      failure({ agentType: "review_code" }),
      null
    );
    expect(body.namedAgentId).toBe("agent-omp");
    expect(body.resumeSessionId).toBeUndefined();
  });

  it("still dispatches a plain build when the card carries no failure", () => {
    const { body } = buildRetryDispatch("proj-1", "e1", undefined, null);
    expect(body).toEqual({});
  });
});

describe("selectLatestFailures — carries what the retry needs", () => {
  it("exposes the failed session's provider and named agent", () => {
    const failed = selectLatestFailures([session({ id: "f1" })], new Set());
    expect(failed.e1).toMatchObject({
      sessionId: "f1",
      provider: "oh-my-pi",
      namedAgentId: "agent-omp",
    });
  });

  it("reports the newest failure's agent, not an older one's", () => {
    const failed = selectLatestFailures(
      [
        session({
          id: "old",
          provider: "claude-code",
          namedAgentId: "agent-claude",
          createdAt: "2026-08-21 09:00:00",
        }),
        session({
          id: "latest",
          provider: "agy",
          namedAgentId: "agent-agy",
          createdAt: "2026-08-21 10:00:00",
        }),
      ],
      new Set()
    );
    expect(failed.e1).toMatchObject({
      sessionId: "latest",
      provider: "agy",
      namedAgentId: "agent-agy",
    });
  });

  it("leaves provider and named agent null on legacy rows that lack them", () => {
    const failed = selectLatestFailures(
      [session({ id: "f1", provider: null, namedAgentId: null })],
      new Set()
    );
    expect(failed.e1).toMatchObject({ provider: null, namedAgentId: null });
  });
});
