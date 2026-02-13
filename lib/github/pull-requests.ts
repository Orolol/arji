import { getOctokit } from "@/lib/github/client";

interface EpicForPr {
  title: string;
  description: string | null;
}

interface StoryForPr {
  title: string;
  status: string;
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

/**
 * Creates a pull request on GitHub via Octokit.
 * Assumes the branch has already been pushed.
 */
export async function createPullRequest(
  params: CreatePullRequestParams
): Promise<PullRequestResult> {
  const octokit = getOctokit();

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
  const octokit = getOctokit();

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
