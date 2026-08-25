import { getGitHubTokenFromSettings, createGitHubClient } from "@/lib/github/client";

interface EpicForPr {
  title: string;
  description: string | null;
}

interface StoryForPr {
  title: string;
  /** Nullable like the column it comes from: anything but "done" renders unchecked. */
  status: string | null;
}

/**
 * Generates a markdown PR body from an epic summary and its user stories.
 */
export function generatePrBody(
  epic: EpicForPr,
  stories: StoryForPr[]
): string {
  const lines: string[] = [];

  lines.push("## Summary");
  lines.push("");
  lines.push(epic.description || "_No description provided._");
  lines.push("");

  if (stories.length > 0) {
    lines.push("## User Stories");
    lines.push("");
    for (const story of stories) {
      const checked = story.status === "done" ? "x" : " ";
      lines.push(`- [${checked}] ${story.title}`);
    }
    lines.push("");
  }

  lines.push("---");
  lines.push("_Created by [Arij](https://github.com/orolol/arji)_");

  return lines.join("\n");
}

interface CreatePullRequestParams {
  owner: string;
  repo: string;
  title: string;
  body: string;
  head: string;
  base: string;
  draft?: boolean;
}

interface PullRequestResult {
  number: number;
  url: string;
  title: string;
  status: "draft" | "open";
  headBranch: string;
  baseBranch: string;
}

export type PullRequestCiState = "passing" | "pending" | "failing";

export interface PullRequestCiStatus {
  headSha: string;
  state: PullRequestCiState;
  failedChecks: string[];
}

interface CheckRunSignal {
  name: string;
  status: string;
  conclusion: string | null;
}

interface CommitStatusSignal {
  context: string;
  state: string;
}

const FAILING_CHECK_CONCLUSIONS = new Set([
  "action_required",
  "cancelled",
  "failure",
  "stale",
  "startup_failure",
  "timed_out",
]);

/**
 * Collapse GitHub Checks and legacy commit statuses into one deterministic
 * signal. Names are de-duplicated because a provider may expose the same CI
 * job through both APIs.
 */
export function classifyPullRequestCi(input: {
  checkRuns: CheckRunSignal[];
  commitStatuses: CommitStatusSignal[];
}): Omit<PullRequestCiStatus, "headSha"> {
  const failedChecks = new Set<string>();

  for (const check of input.checkRuns) {
    if (
      check.conclusion &&
      FAILING_CHECK_CONCLUSIONS.has(check.conclusion)
    ) {
      failedChecks.add(check.name);
    }
  }
  for (const status of input.commitStatuses) {
    if (status.state === "error" || status.state === "failure") {
      failedChecks.add(status.context);
    }
  }

  if (failedChecks.size > 0) {
    return {
      state: "failing",
      failedChecks: [...failedChecks].sort((left, right) =>
        left.localeCompare(right)
      ),
    };
  }

  const hasPendingSignal =
    input.checkRuns.some((check) => check.status !== "completed") ||
    input.commitStatuses.some((status) => status.state === "pending");
  const hasAnySignal =
    input.checkRuns.length > 0 || input.commitStatuses.length > 0;

  return {
    state: hasPendingSignal || !hasAnySignal ? "pending" : "passing",
    failedChecks: [],
  };
}

/**
 * Creates a pull request on GitHub via Octokit.
 * Assumes the branch has already been pushed.
 */
export async function createPullRequest(
  params: CreatePullRequestParams
): Promise<PullRequestResult> {
  const token = getGitHubTokenFromSettings();
  if (!token) {
    throw new Error("GitHub PAT not configured. Set it in Settings.");
  }
  const octokit = createGitHubClient(token);

  const { data } = await octokit.pulls.create({
    owner: params.owner,
    repo: params.repo,
    title: params.title,
    body: params.body,
    head: params.head,
    base: params.base,
    draft: params.draft ?? false,
  });

  return {
    number: data.number,
    url: data.html_url,
    title: data.title,
    status: data.draft ? "draft" : "open",
    headBranch: params.head,
    baseBranch: params.base,
  };
}

/**
 * Fetches the current status of a pull request from GitHub.
 */
export async function fetchPrStatus(
  owner: string,
  repo: string,
  prNumber: number
): Promise<{ status: "draft" | "open" | "closed" | "merged"; title: string }> {
  const token = getGitHubTokenFromSettings();
  if (!token) {
    throw new Error("GitHub PAT not configured. Set it in Settings.");
  }
  const octokit = createGitHubClient(token);

  const { data } = await octokit.pulls.get({
    owner,
    repo,
    pull_number: prNumber,
  });

  let status: "draft" | "open" | "closed" | "merged";
  if (data.merged) {
    status = "merged";
  } else if (data.state === "closed") {
    status = "closed";
  } else if (data.draft) {
    status = "draft";
  } else {
    status = "open";
  }

  return { status, title: data.title };
}

/**
 * Fetch the current PR head and its CI signals through the existing
 * authenticated Octokit path. The head lookup happens first so checks and
 * statuses are always evaluated for the exact same commit.
 */
export async function fetchPullRequestCiStatus(
  owner: string,
  repo: string,
  prNumber: number
): Promise<PullRequestCiStatus> {
  const token = getGitHubTokenFromSettings();
  if (!token) {
    throw new Error("GitHub PAT not configured. Set it in Settings.");
  }
  const octokit = createGitHubClient(token);
  const { data: pullRequest } = await octokit.pulls.get({
    owner,
    repo,
    pull_number: prNumber,
  });
  const headSha = pullRequest.head.sha;

  const [{ data: checks }, { data: combinedStatus }] = await Promise.all([
    octokit.checks.listForRef({
      owner,
      repo,
      ref: headSha,
      filter: "latest",
      per_page: 100,
    }),
    octokit.repos.getCombinedStatusForRef({
      owner,
      repo,
      ref: headSha,
      per_page: 100,
    }),
  ]);

  return {
    headSha,
    ...classifyPullRequestCi({
      checkRuns: checks.check_runs.map((check) => ({
        name: check.name,
        status: check.status,
        conclusion: check.conclusion,
      })),
      commitStatuses: combinedStatus.statuses.map((status) => ({
        context: status.context,
        state: status.state,
      })),
    }),
  };
}
