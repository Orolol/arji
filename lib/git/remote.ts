import simpleGit, { type SimpleGit } from "simple-git";

function getGit(repoPath: string): SimpleGit {
  return simpleGit(repoPath);
}

/**
 * Parses the `origin` remote URL and extracts owner/repo.
 * Supports both HTTPS and SSH URL formats.
 */
export async function detectRemote(
  repoPath: string
): Promise<{ owner: string; repo: string } | null> {
  const git = getGit(repoPath);

  try {
    const remotes = await git.getRemotes(true);
    const origin = remotes.find((r) => r.name === "origin");
    if (!origin?.refs?.fetch) return null;

    return parseRemoteUrl(origin.refs.fetch);
  } catch {
    return null;
  }
}

/**
 * Parses a git remote URL into owner/repo.
 * Handles:
 *   - https://github.com/owner/repo.git
 *   - git@github.com:owner/repo.git
 *   - https://github.com/owner/repo
 */
export function parseRemoteUrl(
  url: string
): { owner: string; repo: string } | null {
  // HTTPS format
  const httpsMatch = url.match(
    /(?:https?:\/\/)?(?:www\.)?github\.com\/([^/]+)\/([^/.\s]+?)(?:\.git)?$/
  );
  if (httpsMatch) {
    return { owner: httpsMatch[1], repo: httpsMatch[2] };
  }

  // SSH format
  const sshMatch = url.match(/git@github\.com:([^/]+)\/([^/.\s]+?)(?:\.git)?$/);
  if (sshMatch) {
    return { owner: sshMatch[1], repo: sshMatch[2] };
  }

  return null;
}

/**
 * Runs `git fetch origin`.
 */
export async function fetchRemote(repoPath: string): Promise<void> {
  const git = getGit(repoPath);
  await git.fetch("origin");
}

/**
 * Runs `git pull --ff-only origin <branch>`.
 * Throws on non-fast-forward or conflicts.
 */
export async function pullRemote(
  repoPath: string,
  branch: string
): Promise<void> {
  const git = getGit(repoPath);
  await git.pull("origin", branch, ["--ff-only"]);
}

/**
 * Runs `git push origin <branch>`.
 */
export async function pushRemote(
  repoPath: string,
  branch: string
): Promise<void> {
  const git = getGit(repoPath);
  await git.push("origin", branch);
}

/**
 * Runs `git push origin <tag>`.
 */
export async function pushTag(
  repoPath: string,
  tag: string
): Promise<void> {
  const git = getGit(repoPath);
  await git.push("origin", tag);
}

/**
 * Returns ahead/behind counts for a branch relative to its remote tracking branch.
 */
export async function getBranchStatus(
  repoPath: string,
  branch: string
): Promise<{ ahead: number; behind: number }> {
  const git = getGit(repoPath);

  try {
    const result = await git.raw([
      "rev-list",
      "--left-right",
      "--count",
      `${branch}...origin/${branch}`,
    ]);

    const parts = result.trim().split(/\s+/);
    return {
      ahead: parseInt(parts[0], 10) || 0,
      behind: parseInt(parts[1], 10) || 0,
    };
  } catch {
    return { ahead: 0, behind: 0 };
  }
}
