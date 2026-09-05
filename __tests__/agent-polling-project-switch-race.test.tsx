/**
 * `useAgentPolling` × switching projects while a poll is still in flight.
 *
 * Sibling of the Sessions page race (see
 * `sessions-page-project-switch-race.test.tsx`, whose header records what was
 * and was not reproduced in Chrome). This hook calls `fetchUnifiedSessions`
 * from the same shape of effect, and the cursor loop holds the same long
 * window open, so the same abort applies and the same wasted paging is what
 * it removes.
 *
 * Its consumer — the project desk — also remounts on a `[projectId]` change,
 * so the stale write these tests drive is a component-level contract rather
 * than an observed screen defect. It is worth pinning because of what the
 * write would be: `selectLatestFailures` is a "newest session per epic wins"
 * verdict over the whole list, so a stale answer does not add rows, it paints
 * failure badges for epics belonging to a board that is no longer shown.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useAgentPolling } from "@/hooks/useAgentPolling";

function failedSession(id: string, epicId: string) {
  return {
    id,
    kind: "agent_session",
    status: "failed",
    epicId,
    error: `${id} exploded`,
    agentType: "build",
    provider: "claude-code",
    createdAt: "2026-03-10T00:00:00.000Z",
    endedAt: "2026-03-10T00:01:00.000Z",
  };
}

interface ProjectFixture {
  activities: unknown[];
  sessions: unknown[];
  /** Held so a switch can happen with this project's poll in flight. */
  release?: Promise<void>;
}

function mockProjects(fixtures: Record<string, ProjectFixture>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown, init?: { signal?: AbortSignal }) => {
      const parsed = new URL(String(url), "http://localhost");
      const projectId = parsed.pathname.split("/")[3];
      const fixture = fixtures[projectId];
      if (!fixture) throw new Error(`stub has no fixture for ${projectId}`);

      const signal = init?.signal;
      if (signal?.aborted) throw abortError();
      if (fixture.release) {
        await new Promise<void>((resolve, reject) => {
          void fixture.release!.then(resolve);
          signal?.addEventListener("abort", () => reject(abortError()));
        });
      }

      const body = parsed.pathname.endsWith("/active")
        ? { data: fixture.activities }
        : { data: fixture.sessions, nextCursor: null };
      return { ok: true, json: async () => body };
    })
  );
}

function abortError(): Error {
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}

// The live activity deliberately sits on a DIFFERENT epic than the failed
// session: "latest session wins" clears the badge for any epic that currently
// has a running agent, so an activity on `epic-a` would suppress the very
// badge these tests are watching.
const A_ACTIVITY = {
  id: "act-a",
  epicId: "epic-a-live",
  type: "build",
  label: "Project A build",
  status: "running",
  mode: "code",
  provider: "claude-code",
  startedAt: "2026-03-10T00:00:00.000Z",
  source: "db",
  cancellable: true,
};

const B_ACTIVITY = {
  ...A_ACTIVITY,
  id: "act-b",
  epicId: "epic-b-live",
  label: "Project B build",
};

describe("useAgentPolling — switching projects mid-poll", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("does not land the previous project's sessions in the new project's badges", async () => {
    let releaseA: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseA = resolve;
    });

    mockProjects({
      "proj-a": {
        activities: [A_ACTIVITY],
        sessions: [failedSession("sess-a", "epic-a")],
        release: gate,
      },
      "proj-b": {
        activities: [B_ACTIVITY],
        sessions: [failedSession("sess-b", "epic-b")],
      },
    });

    const view = renderHook(({ projectId }) => useAgentPolling(projectId, 100_000), {
      initialProps: { projectId: "proj-a" },
    });

    // Project A's poll is held in flight; switch before it can answer.
    view.rerender({ projectId: "proj-b" });
    await waitFor(() =>
      expect(view.result.current.activities.map((a) => a.id)).toEqual(["act-b"])
    );
    expect(Object.keys(view.result.current.failedSessions)).toEqual(["epic-b"]);

    // Let the abandoned poll run as far as it can, flushing every React
    // update it schedules along the way.
    await act(async () => {
      releaseA();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    expect(view.result.current.activities.map((a) => a.id)).toEqual(["act-b"]);
    expect(Object.keys(view.result.current.failedSessions)).toEqual(["epic-b"]);
  });

  it("clears the previous project's badges instead of carrying them across", async () => {
    let releaseB: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseB = resolve;
    });

    mockProjects({
      "proj-a": {
        activities: [A_ACTIVITY],
        sessions: [failedSession("sess-a", "epic-a")],
      },
      "proj-b": {
        activities: [B_ACTIVITY],
        sessions: [failedSession("sess-b", "epic-b")],
        release: gate,
      },
    });

    const view = renderHook(({ projectId }) => useAgentPolling(projectId, 100_000), {
      initialProps: { projectId: "proj-a" },
    });
    await waitFor(() =>
      expect(Object.keys(view.result.current.failedSessions)).toEqual(["epic-a"])
    );

    view.rerender({ projectId: "proj-b" });

    // Project B has not answered yet. Empty is the honest state — project A's
    // running agent and failed epic belong to a board that is no longer shown.
    await waitFor(() => expect(view.result.current.activities).toEqual([]));
    expect(view.result.current.failedSessions).toEqual({});

    releaseB();
    await waitFor(() =>
      expect(Object.keys(view.result.current.failedSessions)).toEqual(["epic-b"])
    );
  });
});
