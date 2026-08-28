import { Octokit } from "@octokit/rest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { settings } from "@/lib/db/schema";

export const GITHUB_PAT_SETTING_KEY = "github_pat";

/**
 * The GitHub preconditions a project must satisfy before any GitHub call can
 * succeed. Sent to clients as the `code` field so the UI can branch on the
 * exact missing piece instead of pattern-matching prose.
 */
export type GitHubConfigErrorCode =
  | "GITHUB_REPO_NOT_CONFIGURED"
  | "GITHUB_PAT_NOT_CONFIGURED";

/**
 * "GitHub is not set up for this project" is an ordinary, recoverable state,
 * not a server fault. Throwing this instead of a bare Error lets routes answer
 * 400 with a machine-readable `code` — the shape `epics/:epicId/pr` and
 * `git/detect-remote` already use for the same class of condition — rather
 * than letting it fall through to a 500 the UI cannot act on.
 */
export class GitHubNotConfiguredError extends Error {
  readonly code: GitHubConfigErrorCode;

  constructor(code: GitHubConfigErrorCode, message: string) {
    super(message);
    this.name = "GitHubNotConfiguredError";
    this.code = code;
  }
}

export const GITHUB_PAT_NOT_CONFIGURED_MESSAGE =
  "GitHub PAT not configured. Set it in Settings.";

function normalizeToken(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }
  if (
    value &&
    typeof value === "object" &&
    "token" in (value as Record<string, unknown>)
  ) {
    const nested = (value as Record<string, unknown>).token;
    if (typeof nested === "string") {
      return nested.trim();
    }
  }
  return "";
}

export function getGitHubTokenFromSettings(): string | null {
  const row = db
    .select()
    .from(settings)
    .where(eq(settings.key, GITHUB_PAT_SETTING_KEY))
    .get();

  if (!row) return null;

  try {
    const parsed = JSON.parse(row.value);
    const token = normalizeToken(parsed);
    return token.length > 0 ? token : null;
  } catch {
    const token = normalizeToken(row.value);
    return token.length > 0 ? token : null;
  }
}

export function createGitHubClient(token: string): Octokit {
  return new Octokit({ auth: token.trim() });
}

/**
 * Creates an authenticated Octokit instance using the stored PAT.
 * Throws GitHubNotConfiguredError if no token is configured.
 */
export function createOctokit(): Octokit {
  const token = getGitHubTokenFromSettings();
  if (!token) {
    throw new GitHubNotConfiguredError(
      "GITHUB_PAT_NOT_CONFIGURED",
      GITHUB_PAT_NOT_CONFIGURED_MESSAGE
    );
  }
  return createGitHubClient(token);
}

/**
 * Parses an "owner/repo" string into its components.
 * Throws if the format is invalid.
 */
export function parseOwnerRepo(ownerRepo: string): {
  owner: string;
  repo: string;
} {
  const parts = ownerRepo.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(
      `Invalid GitHub owner/repo format: "${ownerRepo}". Expected "owner/repo".`
    );
  }
  return { owner: parts[0], repo: parts[1] };
}

export async function validateGitHubToken(token: string): Promise<{
  valid: boolean;
  login?: string;
  error?: string;
  /**
   * HTTP status GitHub answered with, when it answered at all. Absent for a
   * network failure — callers that must distinguish "GitHub rejected this
   * token" from "GitHub could not be reached" (POST /api/projects/clone) key
   * off 401 rather than off `valid` alone.
   */
  status?: number;
}> {
  const cleanToken = token.trim();
  if (!cleanToken) {
    return {
      valid: false,
      error: "GitHub token is required for validation.",
    };
  }

  try {
    const octokit = createGitHubClient(cleanToken);
    const response = await octokit.rest.users.getAuthenticated();

    return {
      valid: true,
      login: response.data.login,
      status: response.status,
    };
  } catch (error) {
    if (typeof error === "object" && error && "status" in error) {
      const status = (error as { status?: number }).status;
      if (status === 401) {
        return {
          valid: false,
          error: "GitHub rejected the token. Verify it and try again.",
          status,
        };
      }
      if (status === 403) {
        return {
          valid: false,
          error:
            "GitHub denied access for this token. Check token scopes and account access.",
          status,
        };
      }
    }

    return {
      valid: false,
      error:
        "Could not reach GitHub to validate this token. Check your network and try again.",
    };
  }
}
