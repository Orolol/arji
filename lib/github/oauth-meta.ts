/**
 * `settings.github_oauth_meta` — how the stored GitHub token was obtained.
 *
 * The token itself keeps living under `settings.github_pat`, untouched and
 * unmoved, so clone, PR, issue, release and validation code paths do not know
 * or care whether a human pasted it or the device flow fetched it. This key is
 * the difference: it is what lets Settings say "connected as @octocat via
 * GitHub" instead of "a token is set".
 *
 * NOTHING SECRET LIVES HERE, on purpose — a login, a scope list, a timestamp
 * and a provenance tag. That is why `GET /api/settings` may serve it in the
 * clear next to the masked `github_pat`, and why it needs no redaction pass of
 * its own. Anything that would need masking belongs under `github_pat`, which
 * already has it.
 */

import { z } from "zod";

export const GITHUB_OAUTH_META_SETTING_KEY = "github_oauth_meta";

/** Where the token under `github_pat` came from. */
export type GitHubTokenSource = "oauth_device" | "manual";

export const GITHUB_TOKEN_SOURCES = ["oauth_device", "manual"] as const;

export interface GitHubOAuthMeta {
  /** The GitHub login the token authenticates as, per `validateGitHubToken`. */
  login: string;
  /** Scopes GitHub actually granted — not the ones we asked for. */
  scopes: string[];
  /** ISO timestamp of when the token was obtained. */
  obtainedAt: string;
  tokenSource: GitHubTokenSource;
}

/**
 * The stored shape, validated both on the way in from `PATCH /api/settings`
 * and wherever the value is read back. One schema so a hand-edited settings
 * row and a device-flow write cannot disagree about what the key holds.
 */
export const githubOAuthMetaSchema = z.object({
  login: z.string().min(1, "login is required"),
  // Required rather than defaulted: `PATCH /api/settings` stores the value it
  // was given, not the value zod parsed, so a default here would validate a
  // payload into a shape that never reaches the database.
  scopes: z.array(z.string(), "scopes must be an array of strings"),
  obtainedAt: z
    .string()
    .refine((v) => !Number.isNaN(Date.parse(v)), "obtainedAt must be a valid timestamp"),
  tokenSource: z.enum(
    GITHUB_TOKEN_SOURCES,
    'tokenSource must be "oauth_device" or "manual"'
  ),
});

/**
 * `null` clears the key — the shape `PATCH /api/settings` accepts when a user
 * replaces an OAuth connection by pasting a PAT by hand, leaving no stale
 * "connected as @someone-else" behind.
 */
export const githubOAuthMetaSettingSchema = githubOAuthMetaSchema.nullable();
