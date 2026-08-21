/**
 * Pure GitHub repository-reference parsing, safe to import from a client
 * component.
 *
 * `lib/git/remote.ts` imports `simple-git` at module scope, so it can never be
 * pulled into a browser bundle. The import page has to tell "this parses as a
 * repo" from "this does not" while the user is still typing — before any
 * network call — so the parsing rules live here with no node or simple-git
 * dependency, following the same client-safe split as
 * `lib/agents/scheduler-constants.ts` and `lib/night/constants.ts`.
 *
 * This module also owns the remote-URL grammar: `lib/git/remote.ts`
 * composes `parseGitHubOwnerRepoFromRemoteUrl` from `REMOTE_URL_PATTERNS`
 * and `isSafeRepoSegment` exported here, so the server-side parser and the
 * client-side one can never drift (pinned by
 * __tests__/github-remote-grammar-parity.test.ts).
 */

export interface ParsedGitHubRepoInput {
  owner: string;
  repo: string;
  ownerRepo: string;
  /** Always normalised to https://github.com/<owner>/<repo>.git */
  cloneUrl: string;
}

/**
 * The shapes `git remote -v` can hand back, plus what a user pastes.
 *
 * This module owns the grammar: `lib/git/remote.ts` composes its
 * `parseGitHubOwnerRepoFromRemoteUrl` from these patterns plus the segment
 * safety check below, so the server-side and client-side parsers can never
 * drift apart (enforced by __tests__/github-remote-grammar-parity.test.ts).
 */
export const REMOTE_URL_PATTERNS = [
  /^git@github\.com:(?<owner>[^/]+)\/(?<repo>[^/]+?)(?:\.git)?\/?$/i,
  /^ssh:\/\/git@github\.com\/(?<owner>[^/]+)\/(?<repo>[^/]+?)(?:\.git)?\/?$/i,
  /^https?:\/\/(?:www\.)?github\.com\/(?<owner>[^/]+)\/(?<repo>[^/]+?)(?:\.git)?\/?$/i,
  /^git:\/\/github\.com\/(?<owner>[^/]+)\/(?<repo>[^/]+?)(?:\.git)?\/?$/i,
];

/**
 * GitHub allows letters, digits, `.`, `-` and `_` in owner and repo names.
 * Anything else — separators, NUL bytes, whitespace — is rejected here so a
 * crafted URL can never reach the filesystem layer. A leading `-` is refused as
 * well: `git clone` would read it as an option. `.`, `..` and any embedded
 * traversal component are rejected too, matching the posture of
 * validatePath() in lib/validation/path.ts.
 */
const REPO_SEGMENT_PATTERN = /^[A-Za-z0-9._-]+$/;

export function isSafeRepoSegment(segment: string): boolean {
  if (!segment) return false;
  if (segment.startsWith("-")) return false;
  if (segment === "." || segment.includes("..")) return false;
  return REPO_SEGMENT_PATTERN.test(segment);
}

function buildRepoInput(
  owner: string,
  repo: string
): ParsedGitHubRepoInput | null {
  const cleanRepo = repo.replace(/\.git$/i, "");
  if (!isSafeRepoSegment(owner) || !isSafeRepoSegment(cleanRepo)) {
    return null;
  }

  return {
    owner,
    repo: cleanRepo,
    ownerRepo: `${owner}/${cleanRepo}`,
    cloneUrl: `https://github.com/${owner}/${cleanRepo}.git`,
  };
}

/**
 * Matches a value against the remote-URL grammar. The matched owner/repo are
 * NOT yet safety-checked — callers must run them through `isSafeRepoSegment`
 * (as `buildRepoInput` and `remote.ts` both do).
 */
export function matchGitHubRemoteUrl(
  value: string
): { owner: string; repo: string } | null {
  for (const pattern of REMOTE_URL_PATTERNS) {
    const match = value.match(pattern);
    if (match?.groups?.owner && match.groups.repo) {
      return { owner: match.groups.owner, repo: match.groups.repo };
    }
  }
  return null;
}

/**
 * Browser URLs carry a suffix the remote-url patterns do not know about:
 * `/tree/main`, `/blob/main/README.md`, `/pull/12`, `?tab=readme-ov-file`,
 * `#anchor`. Keep the first two path segments and drop the rest.
 */
function stripBrowserSuffix(value: string): string | null {
  const match = value.match(
    /^(?<base>https?:\/\/(?:www\.)?github\.com\/[^/?#]+\/[^/?#]+)[/?#]/i
  );
  return match?.groups?.base ?? null;
}

/** `owner/repo` shorthand — exactly two segments, no scheme, no host. */
function parseShorthand(value: string): ParsedGitHubRepoInput | null {
  const match = value.match(/^(?<owner>[^/]+)\/(?<repo>[^/]+?)\/?$/);
  if (!match?.groups?.owner || !match.groups.repo) return null;
  return buildRepoInput(match.groups.owner, match.groups.repo);
}

/**
 * Parses every GitHub repo reference a user is likely to paste — remote URLs
 * (https, ssh, git), browser URLs with trailing segments, and the `owner/repo`
 * shorthand — into a normalised clone target. Returns null for anything that is
 * not a GitHub repository or whose owner/repo fails strict validation.
 */
export function parseGitHubRepoInput(
  input: string
): ParsedGitHubRepoInput | null {
  if (typeof input !== "string") return null;

  const value = input.trim();
  if (!value || value.includes("\0")) return null;

  // `github.com/owner/repo` pasted without a scheme.
  const withScheme = /^(?:www\.)?github\.com\//i.test(value)
    ? `https://${value}`
    : value;

  for (const candidate of [withScheme, stripBrowserSuffix(withScheme)]) {
    if (!candidate) continue;
    const matched = matchGitHubRemoteUrl(candidate);
    if (!matched) continue;
    // A `?query` or `#anchor` is swallowed by the patterns' `[^/]+?` repo
    // group, so a rejected candidate falls through to the stripped one rather
    // than failing the whole parse.
    const result = buildRepoInput(matched.owner, matched.repo);
    if (result) return result;
  }

  // A github.com URL that did not parse is not a repo reference; do not fall
  // through to the shorthand rule and mis-read the host as an owner.
  if (withScheme !== value) return null;

  return parseShorthand(value);
}
