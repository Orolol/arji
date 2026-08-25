import {
  getGitHubTokenFromSettings,
  createGitHubClient,
} from "@/lib/github/client";
import {
  CI_AUTOFIX_MAX_FAILURES,
  CI_AUTOFIX_MAX_LOGGED_FAILURES,
  CI_AUTOFIX_MAX_LOG_TAIL_CHARS,
  boundCiAutofixEvidence,
} from "@/lib/routines/ci-autofix-limits";

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
export function generatePrBody(epic: EpicForPr, stories: StoryForPr[]): string {
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

export interface PullRequestFailedCheckRun {
  id: number;
  name: string;
  /** Used to spend the bounded log budget on the actionable failure first. */
  conclusion?: string | null;
}

export interface PullRequestCiStatus {
  headSha: string;
  state: PullRequestCiState;
  failedChecks: string[];
  /**
   * GitHub check-run ids whose logs can be fetched through the Actions job
   * endpoint. Legacy commit statuses have no job id and therefore appear in
   * `failedChecks` only.
   */
  failedCheckRuns?: PullRequestFailedCheckRun[];
  /** Lifecycle of the PR itself, so CI watch can stop polling merged PRs. */
  prState?: "draft" | "open" | "closed" | "merged";
}

export interface PullRequestCiFailureEvidence {
  name: string;
  /** Best-effort tail of the job log; null for legacy/third-party checks. */
  logTail: string | null;
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

const ACTIONABLE_FAILURE_CONCLUSIONS = new Set([
  "failure",
  "startup_failure",
  "timed_out",
]);

const RELATED_FAILURE_CONCLUSIONS = new Set(["cancelled", "stale"]);

const FAILURE_LOG_PRIORITY = new Map([
  ["failure", 0],
  ["timed_out", 0],
  ["startup_failure", 0],
  ["cancelled", 1],
  ["stale", 1],
]);

function compareFailedCheckRuns(
  left: PullRequestFailedCheckRun,
  right: PullRequestFailedCheckRun,
): number {
  const priorityDifference =
    (FAILURE_LOG_PRIORITY.get(left.conclusion ?? "") ?? 2) -
    (FAILURE_LOG_PRIORITY.get(right.conclusion ?? "") ?? 2);
  return priorityDifference || left.name.localeCompare(right.name);
}

export const CI_JOB_LOG_TAIL_CHARS = CI_AUTOFIX_MAX_LOG_TAIL_CHARS;

async function logPayloadToText(payload: unknown): Promise<string | null> {
  if (typeof payload === "string") return payload;
  if (payload instanceof ArrayBuffer) {
    return new TextDecoder().decode(new Uint8Array(payload));
  }
  if (ArrayBuffer.isView(payload)) {
    return new TextDecoder().decode(
      new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength),
    );
  }
  if (
    payload &&
    typeof payload === "object" &&
    "text" in payload &&
    typeof (payload as { text?: unknown }).text === "function"
  ) {
    return await (payload as { text(): Promise<string> }).text();
  }
  return null;
}

export function tailCiJobLog(
  log: string,
  maxChars: number = CI_JOB_LOG_TAIL_CHARS,
): string {
  const normalized = log.replace(/\0/g, "").trimEnd();
  return normalized.length <= maxChars
    ? normalized
    : normalized.slice(normalized.length - maxChars);
}

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
  const hasActionableFailure =
    input.checkRuns.some(
      (check) =>
        check.conclusion !== null &&
        ACTIONABLE_FAILURE_CONCLUSIONS.has(check.conclusion),
    ) ||
    input.commitStatuses.some(
      (status) => status.state === "error" || status.state === "failure",
    );

  if (hasActionableFailure) {
    // Only genuinely broken checks are reported: cancelled/stale matrix
    // siblings stay pending signals and never join the alert or the fix
    // prompt, where they would pad one real failure with empty work.
    for (const check of input.checkRuns) {
      if (
        check.conclusion &&
        ACTIONABLE_FAILURE_CONCLUSIONS.has(check.conclusion)
      ) {
        failedChecks.add(check.name);
      }
    }
    for (const status of input.commitStatuses) {
      if (status.state === "error" || status.state === "failure") {
        failedChecks.add(status.context);
      }
    }
  }

  if (failedChecks.size > 0) {
    return {
      state: "failing",
      failedChecks: [...failedChecks].sort((left, right) =>
        left.localeCompare(right),
      ),
    };
  }

  const hasPendingSignal =
    input.checkRuns.some(
      (check) =>
        check.status !== "completed" ||
        check.conclusion === "action_required" ||
        (check.conclusion !== null &&
          RELATED_FAILURE_CONCLUSIONS.has(check.conclusion)),
    ) || input.commitStatuses.some((status) => status.state === "pending");
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
  params: CreatePullRequestParams,
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
  prNumber: number,
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
  prNumber: number,
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
  const prState = pullRequest.merged
    ? ("merged" as const)
    : pullRequest.state === "closed"
      ? ("closed" as const)
      : pullRequest.draft
        ? ("draft" as const)
        : ("open" as const);

  const [checkRuns, rawCommitStatuses] = await Promise.all([
    octokit.paginate(octokit.checks.listForRef, {
      owner,
      repo,
      ref: headSha,
      filter: "latest",
      per_page: 100,
    }),
    octokit.paginate(octokit.repos.listCommitStatusesForRef, {
      owner,
      repo,
      ref: headSha,
      per_page: 100,
    }),
  ]);

  const checkRunSignals = checkRuns.flatMap((check) => {
    if (
      !Number.isInteger(check.id) ||
      typeof check.name !== "string" ||
      check.name.trim().length === 0 ||
      typeof check.status !== "string"
    ) {
      return [];
    }
    return [
      {
        id: check.id,
        name: check.name.trim(),
        status: check.status,
        conclusion:
          typeof check.conclusion === "string" ? check.conclusion : null,
      },
    ];
  });
  // The list endpoint is newest-first and may contain historical entries for
  // the same context. Keep the current signal only. Unlike the combined-status
  // response, this endpoint has a top-level array that Octokit's paginator can
  // safely concatenate across every page.
  const seenCommitStatusContexts = new Set<string>();
  const commitStatuses: CommitStatusSignal[] = [];
  for (const status of rawCommitStatuses) {
    if (
      typeof status.context !== "string" ||
      typeof status.state !== "string"
    ) {
      continue;
    }
    const context = status.context.trim();
    if (!context || seenCommitStatusContexts.has(context)) continue;
    seenCommitStatusContexts.add(context);
    commitStatuses.push({ context, state: status.state });
  }
  const classification = classifyPullRequestCi({
    checkRuns: checkRunSignals.map((check) => ({
      name: check.name,
      status: check.status,
      conclusion: check.conclusion,
    })),
    commitStatuses,
  });

  const failedCheckRuns = new Map<string, PullRequestFailedCheckRun>();
  for (const check of checkRunSignals) {
    if (
      classification.failedChecks.includes(check.name) &&
      !failedCheckRuns.has(check.name)
    ) {
      failedCheckRuns.set(check.name, {
        id: check.id,
        name: check.name,
        conclusion: check.conclusion,
      });
    }
  }

  return {
    headSha,
    prState,
    ...classification,
    failedCheckRuns: [...failedCheckRuns.values()].sort(compareFailedCheckRuns),
  };
}

/**
 * Fetch bounded log tails for failed GitHub Actions checks. Every failed
 * check name remains present, but only a limited number of Actions logs are
 * downloaded and their combined evidence stays within the build-route byte
 * budget. Legacy/third-party checks remain present with `logTail: null`.
 */
export async function fetchPullRequestCiFailureEvidence(
  owner: string,
  repo: string,
  snapshot: PullRequestCiStatus,
): Promise<PullRequestCiFailureEvidence[]> {
  const token = getGitHubTokenFromSettings();
  if (!token) {
    throw new Error("GitHub PAT not configured. Set it in Settings.");
  }
  const octokit = createGitHubClient(token);
  const failedCheckRuns = [...(snapshot.failedCheckRuns ?? [])].sort(
    compareFailedCheckRuns,
  );
  const runByName = new Map(
    failedCheckRuns.map((check) => [check.name, check]),
  );
  // failedCheckRuns is priority-sorted (actionable conclusions first), so its
  // index is the order in which the shared log-byte budget should be spent.
  const logPriorityByName = new Map(
    failedCheckRuns.map((check, index) => [check.name, index]),
  );

  const loggedCheckNames = new Set(
    failedCheckRuns
      .slice(0, CI_AUTOFIX_MAX_LOGGED_FAILURES)
      .map((check) => check.name),
  );
  const evidence = await Promise.all(
    snapshot.failedChecks
      .slice(0, CI_AUTOFIX_MAX_FAILURES)
      .map(async (name) => {
        const checkRun = runByName.get(name);
        if (!checkRun || !loggedCheckNames.has(name)) {
          return { name, logTail: null };
        }

        try {
          const response = await octokit.actions.downloadJobLogsForWorkflowRun({
            owner,
            repo,
            job_id: checkRun.id,
          });
          const payload = (response as unknown as { data?: unknown }).data;
          const text = await logPayloadToText(payload);
          return { name, logTail: text === null ? null : tailCiJobLog(text) };
        } catch {
          // A non-Actions check run, expired redirect, or missing permission is
          // expected to have no downloadable log. The check name is still
          // useful evidence and the autofix must continue with the rest.
          return { name, logTail: null };
        }
      }),
  );
  return boundCiAutofixEvidence(
    evidence,
    (failure) => logPriorityByName.get(failure.name) ?? Number.MAX_SAFE_INTEGER,
  );
}
