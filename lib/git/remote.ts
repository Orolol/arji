import simpleGit, { type SimpleGit } from "simple-git";
import {
  isSafeRepoSegment,
  matchGitHubRemoteUrl,
} from "@/lib/git/github-url";

export interface ParsedGitHubRemote {
  owner: string;
  repo: string;
  ownerRepo: string;
}

export interface DetectedGitHubRemote extends ParsedGitHubRemote {
  remoteName: string;
  remoteUrl: string;
}

// The full repo-reference parser (remote URLs, browser URLs, owner/repo
// shorthand) lives in lib/git/github-url.ts so the client-side import page
// can share it; re-exported here so server callers keep one import site.
export type { ParsedGitHubRepoInput } from "@/lib/git/github-url";
export { parseGitHubRepoInput } from "@/lib/git/github-url";

export interface BranchSyncStatus {
  branch: string;
  remote: string;
  remoteBranch: string;
  ahead: number;
  behind: number;
  hasRemoteBranch: boolean;
}

export interface PullWithConflictResult {
  conflicted: boolean;
  summary: string;
  conflictedFiles: string[];
}

export class PushValidationError extends Error {
  readonly code: "working_tree_dirty" | "branch_behind_remote";

  constructor(
    code: "working_tree_dirty" | "branch_behind_remote",
    message: string
  ) {
    super(message);
    this.name = "PushValidationError";
    this.code = code;
  }
}

function normalizeRemoteUrl(raw: string): string {
  return raw.trim();
}

export function parseGitHubOwnerRepoFromRemoteUrl(
  remoteUrl: string
): ParsedGitHubRemote | null {
  const value = normalizeRemoteUrl(remoteUrl);
  if (!value) return null;

  // The grammar (patterns + segment safety) lives in lib/git/github-url.ts so
  // the server-side and client-side parsers share one source of truth. The
  // safety check matters here too: a remote whose owner/repo fails it (e.g.
  // `..` or a leading `-`) is not a usable GitHub reference.
  const matched = matchGitHubRemoteUrl(value);
  if (!matched) return null;
  if (!isSafeRepoSegment(matched.owner) || !isSafeRepoSegment(matched.repo)) {
    return null;
  }

  return {
    owner: matched.owner,
    repo: matched.repo,
    ownerRepo: `${matched.owner}/${matched.repo}`,
  };
}

function getGit(repoPath: string): SimpleGit {
  return simpleGit(repoPath);
}

function assertNotFlagLike(value: string, label: string): string {
  const clean = value.trim();
  if (!clean) {
    throw new Error(`${label} is required.`);
  }
  if (clean.startsWith("-")) {
    throw new Error(`Invalid ${label}: ${clean}`);
  }
  return clean;
}

function defaultRemote(remote?: string): string {
  const clean = remote?.trim() || "origin";
  if (clean.startsWith("-")) {
    throw new Error(`Invalid remote name: ${clean}`);
  }
  return clean;
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

export async function fetchGitRemote(
  repoPath: string,
  remote = "origin"
) {
  const cleanRemote = defaultRemote(remote);
  const git = getGit(repoPath);
  return git.fetch(cleanRemote);
}

export async function pullGitBranchWithConflictSupport(
  repoPath: string,
  branch: string,
  remote = "origin"
): Promise<PullWithConflictResult> {
  const cleanBranch = assertNotFlagLike(branch, "branch name");
  const cleanRemote = defaultRemote(remote);
  const git = getGit(repoPath);
  try {
    const pullResult = await git.pull(cleanRemote, cleanBranch);
    return {
      conflicted: false,
      summary: pullResult.summary
        ? JSON.stringify(pullResult.summary)
        : "Pulled successfully.",
      conflictedFiles: [],
    };
  } catch (error) {
    const status = await git.status();
    if (status.conflicted.length > 0) {
      return {
        conflicted: true,
        summary: error instanceof Error ? error.message : "Merge conflicts detected.",
        conflictedFiles: status.conflicted,
      };
    }
    throw error;
  }
}

export async function pushGitBranch(
  repoPath: string,
  branch: string,
  remote = "origin",
  setUpstream = true
) {
  const cleanBranch = assertNotFlagLike(branch, "branch name");
  const cleanRemote = defaultRemote(remote);
  const git = getGit(repoPath);
  const options = setUpstream ? ["--set-upstream"] : [];
  return git.push(cleanRemote, cleanBranch, options);
}

export async function validatePushPreconditions(
  repoPath: string,
  branch: string,
  remote = "origin"
): Promise<void> {
  const git = getGit(repoPath);
  const status = await git.status();
  const hasChanges =
    status.files.length > 0 ||
    status.staged.length > 0 ||
    status.not_added.length > 0;
  if (hasChanges) {
    throw new PushValidationError(
      "working_tree_dirty",
      "Push rejected: working tree has uncommitted changes."
    );
  }

  const sync = await getBranchSyncStatus(repoPath, branch, remote);
  if (sync.behind > 0) {
    throw new PushValidationError(
      "branch_behind_remote",
      `Push rejected: local branch is ${sync.behind} commit(s) behind ${sync.remoteBranch}. Pull first.`
    );
  }
}

export async function getConflictFileDiffs(
  repoPath: string,
  files: string[]
): Promise<Array<{ filePath: string; diff: string }>> {
  const git = getGit(repoPath);
  const diffs: Array<{ filePath: string; diff: string }> = [];
  for (const file of files) {
    // Invariant: `--` separator ensures file path is treated as pathspec, not flag.
    const diff = await git.raw(["diff", "--", file]);
    diffs.push({ filePath: file, diff });
  }
  return diffs;
}

export async function getCurrentGitBranch(repoPath: string): Promise<string> {
  const git = getGit(repoPath);
  const branches = await git.branchLocal();
  return branches.current;
}

async function hasBranch(git: SimpleGit, branchName: string): Promise<boolean> {
  if (branchName.startsWith("-")) return false;
  try {
    await git.revparse([branchName]);
    return true;
  } catch {
    return false;
  }
}

export async function getBranchSyncStatus(
  repoPath: string,
  branch: string,
  remote = "origin"
): Promise<BranchSyncStatus> {
  const cleanBranch = assertNotFlagLike(branch, "branch name");
  const cleanRemote = defaultRemote(remote);
  const remoteBranch = `${cleanRemote}/${cleanBranch}`;
  const git = getGit(repoPath);

  const hasLocalBranch = await hasBranch(git, cleanBranch);
  if (!hasLocalBranch) {
    throw new Error(`Local branch '${cleanBranch}' was not found.`);
  }

  const hasRemoteBranch = await hasBranch(git, remoteBranch);
  if (!hasRemoteBranch) {
    return {
      branch: cleanBranch,
      remote: cleanRemote,
      remoteBranch,
      ahead: 0,
      behind: 0,
      hasRemoteBranch: false,
    };
  }

  // Invariant: cleanBranch and remoteBranch are validated to reject leading dashes.
  const raw = await git.raw([
    "rev-list",
    "--left-right",
    "--count",
    `${cleanBranch}...${remoteBranch}`,
  ]);
  const [aheadRaw, behindRaw] = raw.trim().split(/\s+/);
  return {
    branch: cleanBranch,
    remote: cleanRemote,
    remoteBranch,
    ahead: Number.parseInt(aheadRaw ?? "0", 10) || 0,
    behind: Number.parseInt(behindRaw ?? "0", 10) || 0,
    hasRemoteBranch: true,
  };
}
