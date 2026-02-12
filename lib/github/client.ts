import { Octokit } from "@octokit/rest";
import { db } from "@/lib/db";
import { settings } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

/**
 * Retrieves the GitHub Personal Access Token from the settings table.
 * Returns null if not configured.
 */
export function getGitHubToken(): string | null {
  const row = db.select().from(settings).where(eq(settings.key, "githubPat")).get();
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.value);
    return typeof parsed === "string" && parsed.length > 0 ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Creates an authenticated Octokit instance using the stored GitHub PAT.
 * Throws if no token is configured.
 */
export function createOctokit(): Octokit {
  const token = getGitHubToken();
  if (!token) {
    throw new Error(
      "GitHub PAT not configured. Go to Settings and add your GitHub Personal Access Token."
    );
  }
  return new Octokit({ auth: token });
}

/**
 * Validates the GitHub token by making a simple API call.
 * Returns the authenticated username on success, or throws on failure.
 */
export async function validateToken(token: string): Promise<string> {
  const octokit = new Octokit({ auth: token });
  const { data } = await octokit.rest.users.getAuthenticated();
  return data.login;
}

/**
 * Parses an "owner/repo" string into its components.
 * Throws if the format is invalid.
 */
export function parseOwnerRepo(ownerRepo: string): { owner: string; repo: string } {
  const parts = ownerRepo.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(
      `Invalid GitHub owner/repo format: "${ownerRepo}". Expected "owner/repo".`
    );
  }
  return { owner: parts[0], repo: parts[1] };
}
