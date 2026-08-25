import { beforeEach, describe, expect, it, vi } from "vitest";

const githubMocks = vi.hoisted(() => ({
  pullsGet: vi.fn(),
  checksListForRef: vi.fn(),
  combinedStatus: vi.fn(),
  downloadJobLogs: vi.fn(),
  paginate: vi.fn(),
}));

vi.mock("@/lib/github/client", () => ({
  getGitHubTokenFromSettings: vi.fn(() => "token"),
  createGitHubClient: vi.fn(() => ({
    pulls: { get: githubMocks.pullsGet },
    checks: { listForRef: githubMocks.checksListForRef },
    repos: { getCombinedStatusForRef: githubMocks.combinedStatus },
    actions: {
      downloadJobLogsForWorkflowRun: githubMocks.downloadJobLogs,
    },
    paginate: githubMocks.paginate,
  })),
}));

import {
  classifyPullRequestCi,
  fetchPullRequestCiFailureEvidence,
  fetchPullRequestCiStatus,
  tailCiJobLog,
} from "@/lib/github/pull-requests";
import {
  CI_AUTOFIX_MAX_EVIDENCE_BYTES,
  CI_AUTOFIX_MAX_LOGGED_FAILURES,
  ciAutofixEvidenceBytes,
} from "@/lib/routines/ci-autofix-limits";

describe("classifyPullRequestCi", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    githubMocks.paginate.mockImplementation(
      async (
        method: (params: unknown) => Promise<{ data: unknown }>,
        params,
      ) => {
        const response = await method(params);
        const data = response.data as {
          check_runs?: unknown[];
          statuses?: unknown[];
        };
        return data.check_runs ?? data.statuses ?? [];
      },
    );
  });

  it("combines and de-duplicates failed checks and legacy statuses", () => {
    expect(
      classifyPullRequestCi({
        checkRuns: [
          { name: "unit", status: "completed", conclusion: "failure" },
          { name: "lint", status: "completed", conclusion: "success" },
        ],
        commitStatuses: [
          { context: "unit", state: "failure" },
          { context: "deploy", state: "error" },
        ],
      }),
    ).toEqual({ state: "failing", failedChecks: ["deploy", "unit"] });
  });

  it("distinguishes pending, passing, and an absent CI signal", () => {
    expect(
      classifyPullRequestCi({
        checkRuns: [{ name: "unit", status: "in_progress", conclusion: null }],
        commitStatuses: [],
      }).state,
    ).toBe("pending");
    expect(
      classifyPullRequestCi({
        checkRuns: [
          { name: "unit", status: "completed", conclusion: "success" },
        ],
        commitStatuses: [],
      }).state,
    ).toBe("passing");
    expect(
      classifyPullRequestCi({ checkRuns: [], commitStatuses: [] }).state,
    ).toBe("pending");
  });

  it("treats action-required checks as pending rather than failing", () => {
    expect(
      classifyPullRequestCi({
        checkRuns: [
          {
            name: "environment approval",
            status: "completed",
            conclusion: "action_required",
          },
        ],
        commitStatuses: [],
      }),
    ).toEqual({ state: "pending", failedChecks: [] });
  });

  it("reads checks and commit statuses for the exact PR head SHA", async () => {
    githubMocks.pullsGet.mockResolvedValue({
      data: { head: { sha: "head-123" } },
    });
    githubMocks.checksListForRef.mockResolvedValue({
      data: {
        check_runs: [
          {
            id: 701,
            name: "unit",
            status: "completed",
            conclusion: "failure",
          },
        ],
      },
    });
    githubMocks.combinedStatus.mockResolvedValue({ data: { statuses: [] } });

    await expect(
      fetchPullRequestCiStatus("acme", "widgets", 42),
    ).resolves.toEqual({
      headSha: "head-123",
      state: "failing",
      failedChecks: ["unit"],
      failedCheckRuns: [{ id: 701, name: "unit", conclusion: "failure" }],
    });
    expect(githubMocks.pullsGet).toHaveBeenCalledWith({
      owner: "acme",
      repo: "widgets",
      pull_number: 42,
    });
    expect(githubMocks.checksListForRef).toHaveBeenCalledWith(
      expect.objectContaining({ ref: "head-123", filter: "latest" }),
    );
    expect(githubMocks.combinedStatus).toHaveBeenCalledWith(
      expect.objectContaining({ ref: "head-123" }),
    );
  });

  it("paginates checks and statuses so a failure after page one is visible", async () => {
    githubMocks.pullsGet.mockResolvedValue({
      data: { head: { sha: "head-many" } },
    });
    githubMocks.paginate
      .mockResolvedValueOnce([
        ...Array.from({ length: 100 }, (_, index) => ({
          id: index + 1,
          name: `passing-${index}`,
          status: "completed",
          conclusion: "success",
        })),
        {
          id: 999,
          name: "late failure",
          status: "completed",
          conclusion: "failure",
        },
      ])
      .mockResolvedValueOnce([]);

    await expect(
      fetchPullRequestCiStatus("acme", "widgets", 42),
    ).resolves.toMatchObject({
      headSha: "head-many",
      state: "failing",
      failedChecks: ["late failure"],
    });
    expect(githubMocks.paginate).toHaveBeenNthCalledWith(
      1,
      githubMocks.checksListForRef,
      expect.objectContaining({ ref: "head-many", per_page: 100 }),
    );
    expect(githubMocks.paginate).toHaveBeenNthCalledWith(
      2,
      githubMocks.combinedStatus,
      expect.objectContaining({ ref: "head-many", per_page: 100 }),
    );
  });

  it("downloads bounded log tails for failed Actions checks", async () => {
    githubMocks.downloadJobLogs.mockResolvedValue({
      data: `prefix-${"x".repeat(40)}-failure-tail`,
    });

    const evidence = await fetchPullRequestCiFailureEvidence(
      "acme",
      "widgets",
      {
        headSha: "head-123",
        state: "failing",
        failedChecks: ["legacy", "unit"],
        failedCheckRuns: [{ id: 701, name: "unit" }],
      },
    );

    expect(evidence).toEqual([
      { name: "legacy", logTail: null },
      {
        name: "unit",
        logTail: `prefix-${"x".repeat(40)}-failure-tail`,
      },
    ]);
    expect(githubMocks.downloadJobLogs).toHaveBeenCalledWith({
      owner: "acme",
      repo: "widgets",
      job_id: 701,
    });
    expect(tailCiJobLog("0123456789", 4)).toBe("6789");
  });

  it("keeps the failed check when its job log is unavailable", async () => {
    githubMocks.downloadJobLogs.mockRejectedValue(
      new Error("not an Actions job"),
    );

    await expect(
      fetchPullRequestCiFailureEvidence("acme", "widgets", {
        headSha: "head-123",
        state: "failing",
        failedChecks: ["third-party"],
        failedCheckRuns: [{ id: 999, name: "third-party" }],
      }),
    ).resolves.toEqual([{ name: "third-party", logTail: null }]);
  });

  it("bounds combined evidence and downloads logs for only a limited check set", async () => {
    const failedChecks = Array.from(
      { length: CI_AUTOFIX_MAX_LOGGED_FAILURES + 8 },
      (_, index) => `matrix-${index}`,
    );
    githubMocks.downloadJobLogs.mockResolvedValue({
      data: "x".repeat(8_000),
    });

    const evidence = await fetchPullRequestCiFailureEvidence(
      "acme",
      "widgets",
      {
        headSha: "head-123",
        state: "failing",
        failedChecks,
        failedCheckRuns: failedChecks.map((name, index) => ({
          id: index + 1,
          name,
        })),
      },
    );

    expect(evidence.map((failure) => failure.name)).toEqual(failedChecks);
    expect(githubMocks.downloadJobLogs).toHaveBeenCalledTimes(
      CI_AUTOFIX_MAX_LOGGED_FAILURES,
    );
    expect(ciAutofixEvidenceBytes(evidence)).toBeLessThanOrEqual(
      CI_AUTOFIX_MAX_EVIDENCE_BYTES,
    );
    expect(
      evidence.filter((failure) => failure.logTail !== null).length,
    ).toBeLessThanOrEqual(CI_AUTOFIX_MAX_LOGGED_FAILURES);
  });

  it("prioritizes actionable failures over cancelled matrix siblings", async () => {
    const cancelledChecks = Array.from(
      { length: CI_AUTOFIX_MAX_LOGGED_FAILURES },
      (_, index) => ({
        id: index + 1,
        name: `a-cancelled-${index}`,
        conclusion: "cancelled",
      }),
    );
    githubMocks.downloadJobLogs.mockResolvedValue({ data: "failure details" });

    await fetchPullRequestCiFailureEvidence("acme", "widgets", {
      headSha: "head-123",
      state: "failing",
      failedChecks: [
        ...cancelledChecks.map((check) => check.name),
        "z-real-failure",
      ],
      failedCheckRuns: [
        ...cancelledChecks,
        { id: 999, name: "z-real-failure", conclusion: "failure" },
      ],
    });

    expect(githubMocks.downloadJobLogs).toHaveBeenCalledTimes(
      CI_AUTOFIX_MAX_LOGGED_FAILURES,
    );
    expect(githubMocks.downloadJobLogs).toHaveBeenCalledWith({
      owner: "acme",
      repo: "widgets",
      job_id: 999,
    });
  });
});
