import { Octokit } from "@octokit/rest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { settings } from "@/lib/db/schema";

export const GITHUB_PAT_SETTING_KEY = "github_pat";

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

export async function validateGitHubToken(token: string): Promise<{
  valid: boolean;
  login?: string;
  error?: string;
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
    };
  } catch (error) {
    if (typeof error === "object" && error && "status" in error) {
      const status = (error as { status?: number }).status;
      if (status === 401) {
        return {
          valid: false,
          error: "GitHub rejected the token. Verify it and try again.",
        };
      }
      if (status === 403) {
        return {
          valid: false,
          error:
            "GitHub denied access for this token. Check token scopes and account access.",
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
