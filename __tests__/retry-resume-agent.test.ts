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
    userStoryId: null,
    producedOutput: true,
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
    userStoryId: null,
    lastNonEmptyText: "done",
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

  /**
   * Parameterised over the toolbar because passing only `null` hides the
   * defect: the resume gate used to infer "same agent" from id equality, and
   * a toolbar selection that happens to equal the failed reviewer's agent
   * satisfies that equality without the retry being a continuation at all.
   */
  it.each([
    ["no toolbar selection", null],
    ["a different toolbar selection", "agent-other"],
    ["a toolbar selection equal to the reviewer's agent", "agent-omp"],
  ])(
    "does not graft the build retry onto a failed review thread — %s",
    (_label, toolbar) => {
      const { body } = buildRetryDispatch(
        "proj-1",
        "e1",
        failure({ agentType: "review_code" }),
        toolbar
      );
      expect(body.resumeSessionId).toBeUndefined();
    }
  );

  it.each([
    ["no toolbar selection", null],
    ["a toolbar selection equal to the grader's agent", "agent-omp"],
  ])(
    "does not graft the build retry onto a failed grading thread — %s",
    (_label, toolbar) => {
      const { body } = buildRetryDispatch(
        "proj-1",
        "e1",
        failure({ agentType: "grading" }),
        toolbar
      );
      expect(body.resumeSessionId).toBeUndefined();
    }
  );

  it("still honours an explicit toolbar pick that collides with the reviewer", () => {
    const { body } = buildRetryDispatch(
      "proj-1",
      "e1",
      failure({ agentType: "review_code" }),
      "agent-omp"
    );
    // The user asked for this agent, so it runs the build — it just does not
    // inherit the review conversation.
    expect(body.namedAgentId).toBe("agent-omp");
  });
});

/**
 * selectLatestFailures badges an epic from ANY session carrying its epicId —
 * reviews and story builds included. The retry only ever dispatches an
 * epic-wide build, so most of what can land on the badge says nothing about
 * how to run that build.
 */
describe("retry dispatch — only an epic build informs an epic build", () => {
  it("does not run the build on the reviewer's agent after a failed review", () => {
    const { body } = buildRetryDispatch(
      "proj-1",
      "e1",
      failure({ agentType: "review_code", namedAgentId: "agent-reviewer" }),
      null
    );
    // No build agent is known, so the server's build-role chain decides.
    expect(body.namedAgentId).toBeUndefined();
  });

  it("lets the toolbar choice win over a failed reviewer's agent", () => {
    const { body } = buildRetryDispatch(
      "proj-1",
      "e1",
      failure({ agentType: "review_code", namedAgentId: "agent-reviewer" }),
      "agent-picked"
    );
    expect(body.namedAgentId).toBe("agent-picked");
  });

  it("does not run the build on a failed grading pass's agent", () => {
    const { body } = buildRetryDispatch(
      "proj-1",
      "e1",
      failure({ agentType: "grading", namedAgentId: "agent-grader" }),
      null
    );
    expect(body.namedAgentId).toBeUndefined();
  });

  it("keeps a story build's agent — same role, same epic — but not its thread", () => {
    const { body } = buildRetryDispatch(
      "proj-1",
      "e1",
      failure({ agentType: "ticket_build", userStoryId: "story-7" }),
      null
    );
    expect(body.namedAgentId).toBe("agent-omp");
    // An epic-wide prompt must not be appended to a one-story conversation;
    // the epic route cannot pass userStoryId, so the server cannot catch it.
    expect(body.resumeSessionId).toBeUndefined();
  });

  it("refuses a story thread even when the toolbar names the same agent", () => {
    const { body } = buildRetryDispatch(
      "proj-1",
      "e1",
      failure({ agentType: "ticket_build", userStoryId: "story-7" }),
      "agent-omp"
    );
    expect(body.resumeSessionId).toBeUndefined();
  });

  it("still resumes an epic-scoped build", () => {
    const { body } = buildRetryDispatch(
      "proj-1",
      "e1",
      failure({ agentType: "build", userStoryId: null }),
      null
    );
    expect(body.resumeSessionId).toBe("sess-failed");
  });

  it("does not resume a run that never produced any output", () => {
    const { body } = buildRetryDispatch(
      "proj-1",
      "e1",
      failure({ producedOutput: false }),
      null
    );
    // claude-code's session id is minted before the process starts, so a
    // launch-time death still stores one for a conversation that never
    // existed. Retrying cold works; --resume on that id does not.
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

  it("carries the story scope, so an epic retry can refuse to resume it", () => {
    const failed = selectLatestFailures(
      [session({ id: "f1", agentType: "ticket_build", userStoryId: "story-7" })],
      new Set()
    );
    expect(failed.e1).toMatchObject({ userStoryId: "story-7" });
  });

  it("reports whether the run ever produced output", () => {
    const spoke = selectLatestFailures([session({ id: "f1" })], new Set());
    expect(spoke.e1.producedOutput).toBe(true);

    const mute = selectLatestFailures(
      [session({ id: "f1", lastNonEmptyText: null })],
      new Set()
    );
    expect(mute.e1.producedOutput).toBe(false);
  });

  it("treats whitespace-only output as no output", () => {
    const failed = selectLatestFailures(
      [session({ id: "f1", lastNonEmptyText: "   \n  " })],
      new Set()
    );
    expect(failed.e1.producedOutput).toBe(false);
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
