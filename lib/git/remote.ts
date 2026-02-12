import simpleGit, { type SimpleGit } from "simple-git";

export interface ParsedGitHubRemote {
  owner: string;
  repo: string;
  ownerRepo: string;
}

export interface DetectedGitHubRemote extends ParsedGitHubRemote {
  remoteName: string;
  remoteUrl: string;
}

function normalizeRemoteUrl(raw: string): string {
  return raw.trim();
}

export function parseGitHubOwnerRepoFromRemoteUrl(
  remoteUrl: string
): ParsedGitHubRemote | null {
  const value = normalizeRemoteUrl(remoteUrl);
  if (!value) return null;

  const patterns = [
    /^git@github\.com:(?<owner>[^/]+)\/(?<repo>[^/]+?)(?:\.git)?\/?$/i,
    /^ssh:\/\/git@github\.com\/(?<owner>[^/]+)\/(?<repo>[^/]+?)(?:\.git)?\/?$/i,
    /^https?:\/\/github\.com\/(?<owner>[^/]+)\/(?<repo>[^/]+?)(?:\.git)?\/?$/i,
    /^git:\/\/github\.com\/(?<owner>[^/]+)\/(?<repo>[^/]+?)(?:\.git)?\/?$/i,
  ];

  for (const pattern of patterns) {
    const match = value.match(pattern);
    if (!match?.groups?.owner || !match.groups.repo) {
      continue;
    }

    const owner = match.groups.owner;
    const repo = match.groups.repo;
    if (!owner || !repo) continue;

    return {
      owner,
      repo,
      ownerRepo: `${owner}/${repo}`,
    };
  }

  return null;
}

function getGit(repoPath: string): SimpleGit {
  return simpleGit(repoPath);
}

export async function detectGitHubRemote(
  repoPath: string
): Promise<DetectedGitHubRemote | null> {
  const git = getGit(repoPath);
  const remotes = await git.getRemotes(true);
  if (remotes.length === 0) return null;

  const prioritized = [
    ...remotes.filter((remote) => remote.name === "origin"),
    ...remotes.filter((remote) => remote.name !== "origin"),
  ];

  for (const remote of prioritized) {
    const remoteUrl =
      remote.refs?.fetch || remote.refs?.push || "";
    const parsed = parseGitHubOwnerRepoFromRemoteUrl(remoteUrl);
    if (!parsed) continue;

    return {
      ...parsed,
      remoteName: remote.name,
      remoteUrl,
    };
  }

  return null;
}
