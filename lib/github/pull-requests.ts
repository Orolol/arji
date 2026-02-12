import type { Octokit } from "@octokit/rest";

interface EpicForPr {
  title: string;
  description: string | null;
}

interface StoryForPr {
  title: string;
  status: string | null;
}

/**
 * Generates a markdown PR body from an epic and its user stories.
 */
export function generatePrBody(epic: EpicForPr, stories: StoryForPr[]): string {
  const sections: string[] = [];

  sections.push("## Summary");
  if (epic.description) {
    sections.push(epic.description);
  } else {
    sections.push(`Implementation of epic: **${epic.title}**`);
  }

  if (stories.length > 0) {
    sections.push("");
    sections.push("## User Stories");
    for (const story of stories) {
      const check = story.status === "done" ? "x" : " ";
      sections.push(`- [${check}] ${story.title}`);
    }
  }

  sections.push("");
  sections.push("---");
  sections.push("*Created by [Arij](https://github.com/arij) project orchestrator*");

  return sections.join("\n");
}

/**
 * Creates a pull request on GitHub.
 */
export async function createPullRequest(
  octokit: Octokit,
  owner: string,
  repo: string,
  head: string,
  base: string,
  title: string,
  body: string
): Promise<{
  number: number;
  htmlUrl: string;
  status: string;
  githubId: number;
}> {
  const { data } = await octokit.rest.pulls.create({
    owner,
    repo,
    head,
    base,
    title,
    body,
  });

  return {
    number: data.number,
    htmlUrl: data.html_url,
    status: data.draft ? "draft" : "open",
    githubId: data.id,
  };
}

/**
 * Fetches the current status of a pull request from GitHub.
 */
export async function getPullRequestStatus(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number
): Promise<{
  number: number;
  title: string;
  body: string | null;
  htmlUrl: string;
  status: string;
  headBranch: string;
  baseBranch: string;
  githubId: number;
}> {
  const { data } = await octokit.rest.pulls.get({
    owner,
    repo,
    pull_number: prNumber,
  });

  let status: string;
  if (data.merged) {
    status = "merged";
  } else if (data.state === "closed") {
    status = "closed";
  } else if (data.draft) {
    status = "draft";
  } else {
    status = "open";
  }

  return {
    number: data.number,
    title: data.title,
    body: data.body,
    htmlUrl: data.html_url,
    status,
    headBranch: data.head.ref,
    baseBranch: data.base.ref,
    githubId: data.id,
  };
}

/**
 * Gets the default branch of a repository.
 */
export async function getDefaultBranch(
  octokit: Octokit,
  owner: string,
  repo: string
): Promise<string> {
  const { data } = await octokit.rest.repos.get({ owner, repo });
  return data.default_branch;
}
