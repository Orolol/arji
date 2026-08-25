import { beforeEach, describe, expect, it, vi } from "vitest";
import { dbMockState, resetDbMockState } from "@/__tests__/helpers/db-mock";
import type { Routine } from "@/lib/db/schema";

vi.mock("@/lib/db", async () => {
  const { dbModuleMock } = await import("@/__tests__/helpers/db-mock");
  return dbModuleMock();
});

import {
  isCiAutofixEnabled,
  nextCiObservation,
  runCiWatchRoutine,
  type CiWatchDeps,
  type CiWatchEpic,
} from "@/lib/routines/ci-watch";

function routine(overrides: Partial<Routine> = {}): Routine {
  return {
    id: "routine-1",
    projectId: "project-1",
    kind: "ci_watch",
    enabled: true,
    timeOfDay: "00:00",
    config: JSON.stringify({ intervalMinutes: 10 }),
    lastRunAt: null,
    lastStatus: null,
    ...overrides,
  };
}

const EPICS: CiWatchEpic[] = [
  {
    id: "epic-open",
    title: "Open PR",
    readableId: "E-proj-001",
    prNumber: 11,
    prStatus: "open",
  },
  {
    id: "epic-closed",
    title: "Closed PR",
    readableId: "E-proj-002",
    prNumber: 12,
    prStatus: "closed",
  },
  {
    id: "epic-no-pr",
    title: "No PR",
    readableId: "E-proj-003",
    prNumber: null,
    prStatus: "open",
  },
];

function deps(row: Routine): CiWatchDeps {
  return {
    listOpenPullRequestEpics: vi.fn(() => EPICS),
    getGitHubOwnerRepo: vi.fn(() => "acme/widgets"),
    fetchPullRequestCi: vi.fn(async () => ({
      headSha: "sha-1",
      state: "failing" as const,
      failedChecks: ["lint", "unit"],
    })),
    isAutofixEnabled: vi.fn(() => false),
    fetchFailureEvidence: vi.fn(async (_owner, _repo, snapshot) =>
      snapshot.failedChecks.map((name: string) => ({
        name,
        logTail: `${name} failed`,
      })),
    ),
    launchAutofix: vi.fn(async () => ({
      status: "launched" as const,
      sessionId: "session-fix-1",
    })),
    persistState: vi.fn((_id, state) => {
      row.config = JSON.stringify({
        ...JSON.parse(row.config),
        ciWatchState: state,
      });
    }),
    notifyFailure: vi.fn(),
  };
}

describe("CI watch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetDbMockState();
  });

  it("polls only open PRs with a PR number", async () => {
    const row = routine();
    const watchDeps = deps(row);

    const result = await runCiWatchRoutine(row, watchDeps);

    expect(watchDeps.fetchPullRequestCi).toHaveBeenCalledTimes(1);
    expect(watchDeps.fetchPullRequestCi).toHaveBeenCalledWith(
      "acme",
      "widgets",
      11,
    );
    expect(result.shouldNotify).toBe(true);
  });

  it("suppresses the generic run notification when no PR needs polling", async () => {
    const row = routine();
    const watchDeps = deps(row);
    vi.mocked(watchDeps.listOpenPullRequestEpics).mockReturnValue([]);

    const result = await runCiWatchRoutine(row, watchDeps);

    expect(result.status).toBe("skipped");
    expect(result.shouldNotify).toBe(false);
    expect(watchDeps.fetchPullRequestCi).not.toHaveBeenCalled();
  });

  it("notifies a failing SHA once and includes the failed check names", async () => {
    const row = routine();
    const watchDeps = deps(row);

    await runCiWatchRoutine(row, watchDeps);
    await runCiWatchRoutine(row, watchDeps);

    expect(watchDeps.notifyFailure).toHaveBeenCalledTimes(1);
    expect(watchDeps.notifyFailure).toHaveBeenCalledWith({
      projectId: "project-1",
      epicId: "epic-open",
      epicTitle: "Open PR",
      epicReadableId: "E-proj-001",
      prNumber: 11,
      headSha: "sha-1",
      failedChecks: ["lint", "unit"],
    });
  });

  it("continues polling later PRs when one GitHub request fails", async () => {
    const row = routine();
    const watchDeps = deps(row);
    vi.mocked(watchDeps.listOpenPullRequestEpics).mockReturnValue([
      EPICS[0],
      {
        id: "epic-open-2",
        title: "Second open PR",
        readableId: "E-proj-004",
        prNumber: 14,
        prStatus: "open",
      },
    ]);
    vi.mocked(watchDeps.fetchPullRequestCi)
      .mockRejectedValueOnce(new Error("GitHub unavailable"))
      .mockResolvedValueOnce({
        headSha: "sha-2",
        state: "failing",
        failedChecks: ["e2e"],
      });

    const result = await runCiWatchRoutine(row, watchDeps);

    expect(watchDeps.fetchPullRequestCi).toHaveBeenCalledTimes(2);
    expect(watchDeps.notifyFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        epicId: "epic-open-2",
        prNumber: 14,
        failedChecks: ["e2e"],
      }),
    );
    expect(result.message).toContain("Checked 1 of 2 open pull requests");
    expect(result.message).toContain("1 could not be processed (PR #11)");
  });

  it("preserves a public config edit made while a sweep is running", async () => {
    const row = routine();
    const watchDeps = deps(row);
    vi.mocked(watchDeps.notifyFailure).mockImplementationOnce(() => {
      row.config = JSON.stringify({ intervalMinutes: 45 });
    });

    await runCiWatchRoutine(row, watchDeps);

    expect(JSON.parse(row.config)).toMatchObject({
      intervalMinutes: 45,
      ciWatchState: {
        "epic-open": {
          headSha: "sha-1",
          failureNotified: true,
        },
      },
    });
  });

  it("reports a red transition after an initial green observation", async () => {
    const row = routine();
    const watchDeps = deps(row);
    vi.mocked(watchDeps.fetchPullRequestCi)
      .mockResolvedValueOnce({
        headSha: "sha-1",
        state: "passing",
        failedChecks: [],
      })
      .mockResolvedValueOnce({
        headSha: "sha-1",
        state: "failing",
        failedChecks: ["e2e"],
      });

    const passingResult = await runCiWatchRoutine(row, watchDeps);
    expect(watchDeps.notifyFailure).not.toHaveBeenCalled();
    const failingResult = await runCiWatchRoutine(row, watchDeps);

    expect(passingResult.shouldNotify).toBe(false);
    expect(failingResult.shouldNotify).toBe(true);
    expect(watchDeps.notifyFailure).toHaveBeenCalledTimes(1);
  });

  it("allows one new alert after the PR receives a new head SHA", async () => {
    const row = routine();
    const watchDeps = deps(row);
    vi.mocked(watchDeps.fetchPullRequestCi)
      .mockResolvedValueOnce({
        headSha: "sha-1",
        state: "failing",
        failedChecks: ["unit"],
      })
      .mockResolvedValueOnce({
        headSha: "sha-2",
        state: "failing",
        failedChecks: ["unit"],
      });

    await runCiWatchRoutine(row, watchDeps);
    await runCiWatchRoutine(row, watchDeps);

    expect(watchDeps.notifyFailure).toHaveBeenCalledTimes(2);
  });

  it("keeps a SHA notified even if the same SHA temporarily turns green", () => {
    const first = nextCiObservation(undefined, 11, {
      headSha: "sha-1",
      state: "failing",
      failedChecks: ["unit"],
    });
    const green = nextCiObservation(first.observation, 11, {
      headSha: "sha-1",
      state: "passing",
      failedChecks: [],
    });
    const redAgain = nextCiObservation(green.observation, 11, {
      headSha: "sha-1",
      state: "failing",
      failedChecks: ["unit"],
    });

    expect(first.shouldNotify).toBe(true);
    expect(green.shouldNotify).toBe(false);
    expect(redAgain.shouldNotify).toBe(false);
  });

  it("defaults CI autofix to OFF and honors explicit tri-state overrides", () => {
    expect(isCiAutofixEnabled("project-1")).toBe(false);

    dbMockState.allRows = [
      { key: "ci_autofix_enabled", value: "true" },
      { key: "ci_autofix_enabled:project-1", value: "false" },
    ];
    expect(isCiAutofixEnabled("project-1")).toBe(false);

    dbMockState.allRows = [{ key: "ci_autofix_enabled", value: "true" }];
    expect(isCiAutofixEnabled("project-1")).toBe(true);
  });

  it("keeps autofix OFF by default while still notifying the CI failure", async () => {
    const row = routine();
    const watchDeps = deps(row);

    await runCiWatchRoutine(row, watchDeps);

    expect(watchDeps.notifyFailure).toHaveBeenCalledTimes(1);
    expect(watchDeps.fetchFailureEvidence).not.toHaveBeenCalled();
    expect(watchDeps.launchAutofix).not.toHaveBeenCalled();
  });

  it("launches one autofix per PR head and rearms only after a new push", async () => {
    const row = routine();
    const watchDeps = deps(row);
    vi.mocked(watchDeps.isAutofixEnabled).mockReturnValue(true);
    vi.mocked(watchDeps.fetchPullRequestCi)
      .mockResolvedValueOnce({
        headSha: "sha-1",
        state: "failing",
        failedChecks: ["unit"],
      })
      .mockResolvedValueOnce({
        headSha: "sha-1",
        state: "failing",
        failedChecks: ["unit"],
      })
      .mockResolvedValueOnce({
        headSha: "sha-2",
        state: "failing",
        failedChecks: ["unit"],
      });
    vi.mocked(watchDeps.launchAutofix)
      .mockResolvedValueOnce({ status: "launched", sessionId: "fix-sha-1" })
      .mockResolvedValueOnce({ status: "launched", sessionId: "fix-sha-2" });

    await runCiWatchRoutine(row, watchDeps);
    await runCiWatchRoutine(row, watchDeps);
    await runCiWatchRoutine(row, watchDeps);

    expect(watchDeps.launchAutofix).toHaveBeenCalledTimes(2);
    expect(watchDeps.launchAutofix).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ headSha: "sha-1", prNumber: 11 }),
    );
    expect(watchDeps.launchAutofix).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ headSha: "sha-2", prNumber: 11 }),
    );
  });

  it("defers a busy target and retries the same SHA after its agent finishes", async () => {
    const row = routine();
    const watchDeps = deps(row);
    vi.mocked(watchDeps.isAutofixEnabled).mockReturnValue(true);
    vi.mocked(watchDeps.launchAutofix)
      .mockResolvedValueOnce({
        status: "skipped",
        reason: "target_busy",
        sessionId: "busy-session",
      })
      .mockResolvedValueOnce({
        status: "launched",
        sessionId: "fix-session",
      });

    await runCiWatchRoutine(row, watchDeps);
    expect(JSON.parse(row.config).ciWatchState["epic-open"]).toMatchObject({
      headSha: "sha-1",
      autofixAttempted: false,
      autofixSessionId: null,
    });

    await runCiWatchRoutine(row, watchDeps);

    expect(watchDeps.launchAutofix).toHaveBeenCalledTimes(2);
    expect(JSON.parse(row.config).ciWatchState["epic-open"]).toMatchObject({
      headSha: "sha-1",
      autofixAttempted: true,
      autofixSessionId: "fix-session",
    });
  });
});
