import { beforeEach, describe, expect, it, vi } from "vitest";

const githubMocks = vi.hoisted(() => ({
  pullsGet: vi.fn(),
  checksListForRef: vi.fn(),
  combinedStatus: vi.fn(),
  downloadJobLogs: vi.fn(),
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
  })),
}));

import {
  classifyPullRequestCi,
  fetchPullRequestCiFailureEvidence,
  fetchPullRequestCiStatus,
  tailCiJobLog,
} from "@/lib/github/pull-requests";

describe("classifyPullRequestCi", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
      })
    ).toEqual({ state: "failing", failedChecks: ["deploy", "unit"] });
  });

  it("distinguishes pending, passing, and an absent CI signal", () => {
    expect(
      classifyPullRequestCi({
        checkRuns: [
          { name: "unit", status: "in_progress", conclusion: null },
        ],
        commitStatuses: [],
      }).state
    ).toBe("pending");
    expect(
      classifyPullRequestCi({
        checkRuns: [
          { name: "unit", status: "completed", conclusion: "success" },
        ],
        commitStatuses: [],
      }).state
    ).toBe("passing");
    expect(
      classifyPullRequestCi({ checkRuns: [], commitStatuses: [] }).state
    ).toBe("pending");
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

    await expect(fetchPullRequestCiStatus("acme", "widgets", 42)).resolves.toEqual(
      {
        headSha: "head-123",
        state: "failing",
        failedChecks: ["unit"],
        failedCheckRuns: [{ id: 701, name: "unit" }],
      }
    );
    expect(githubMocks.pullsGet).toHaveBeenCalledWith({
      owner: "acme",
      repo: "widgets",
      pull_number: 42,
    });
    expect(githubMocks.checksListForRef).toHaveBeenCalledWith(
      expect.objectContaining({ ref: "head-123", filter: "latest" })
    );
    expect(githubMocks.combinedStatus).toHaveBeenCalledWith(
      expect.objectContaining({ ref: "head-123" })
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
      }
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
    githubMocks.downloadJobLogs.mockRejectedValue(new Error("not an Actions job"));

    await expect(
      fetchPullRequestCiFailureEvidence("acme", "widgets", {
        headSha: "head-123",
        state: "failing",
        failedChecks: ["third-party"],
        failedCheckRuns: [{ id: 999, name: "third-party" }],
      })
    ).resolves.toEqual([{ name: "third-party", logTail: null }]);
  });
});
