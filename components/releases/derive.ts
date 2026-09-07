import type { UiLocale } from "@/lib/i18n/locales";
import type { TranslationKey } from "@/lib/i18n/catalogue";

/**
 * Pure derivations for the Releases desk (frame 8c).
 *
 * No React, no imports from `components/`: everything here is a plain function
 * over the API row shapes, so the screen's arithmetic is unit-testable without
 * a DOM. Formatting that already exists elsewhere in the repo (`formatRelative`) is
 * NOT re-implemented here — the screen imports it from `lib/utils/format-date`.
 */

/** Mirror of a row of the `releases` table as the API returns it. */
export interface ReleaseRow {
  id: string;
  version: string;
  title: string | null;
  changelog: string | null;
  /** Free-form JSON text column — may be malformed. See {@link parseEpicIds}. */
  epicIds: string | null;
  releaseBranch: string | null;
  gitTag: string | null;
  githubReleaseId: number | null;
  githubReleaseUrl: string | null;
  pushedAt: string | null;
  createdAt: string;
}

/** The subset of the epics payload this screen reads. */
export interface ReleaseEpic {
  id: string;
  title: string;
  status: string;
  type?: string;
  readableId?: string | null;
  releaseId?: string | null;
  usCount?: number;
  usDone?: number;
  updatedAt?: string | null;
}

export type ReleaseState = "published" | "draft" | "local";

/**
 * Ported verbatim from the page this screen replaces.
 *
 * The ordering is load-bearing: `published` requires BOTH `githubReleaseId`
 * and `pushedAt`, because `pushedAt` is stamped at creation as well as at
 * publish — the two-field test is the only thing separating a pushed draft
 * from a published release.
 */
export const RELEASE_STATE_KEYS = {
  draft: "Releases.state.draft",
  published: "Releases.state.published",
  local: "Releases.state.local",
} as const satisfies Record<ReleaseState, TranslationKey>;

export function releaseState(release: ReleaseRow): ReleaseState {
  if (release.githubReleaseId !== null && release.pushedAt !== null) {
    return "published";
  }
  if (release.githubReleaseId !== null) return "draft";
  return "local";
}

/**
 * Ported verbatim. `epicIds` is a free-form JSON text column; a malformed
 * value must never throw inside a render, and a non-array must not be spread.
 */
export function parseEpicIds(release: ReleaseRow | null): string[] {
  if (!release?.epicIds) return [];
  try {
    const parsed = JSON.parse(release.epicIds);
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    return [];
  }
}

/** Exactly three numeric parts, with an optional leading `v`. */
const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)$/;

/**
 * `"0.4.2"` / `"v0.4.2"` → `"0.4.3"`.
 *
 * A 2-part or 4-part version returns null rather than guessing which segment
 * the user meant to bump.
 */
export function nextPatchVersion(
  latest: string | null | undefined,
): string | null {
  return versionBumps(latest)?.patch ?? null;
}

/** `"0.4.2"` → `{ patch: "0.4.3", minor: "0.5.0", major: "1.0.0" }`. */
export function versionBumps(
  latest: string | null | undefined,
): { patch: string; minor: string; major: string } | null {
  if (!latest) return null;
  const match = SEMVER.exec(latest.trim());
  if (!match) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  return {
    patch: `${major}.${minor}.${patch + 1}`,
    minor: `${major}.${minor + 1}.0`,
    major: `${major + 1}.0.0`,
  };
}

/**
 * Why a done, unreleased epic is NOT pre-selected for the release.
 * `null` means the ticket is clean and starts checked.
 *
 * Deliberately NOT `describeMergeBlocker`: `evaluateMergeReadiness` reports
 * `not_to_merge` for any epic whose status is not `to_merge`, and
 * `describeMergeBlocker` returns null for that blocker — so it would return
 * null for every candidate on this screen, always. The honest signal is the
 * story count the epics route already computes.
 */
export function ticketExclusionReason(epic: {
  usCount?: number;
  usDone?: number;
}, copy: (count: number) => string): string | null {
  const left = (epic.usCount ?? 0) - (epic.usDone ?? 0);
  if (left <= 0) return null;
  return copy(left);
}

/**
 * Client-side mirror of the server's fallback changelog
 * (`app/api/projects/[projectId]/releases/route.ts`), byte for byte.
 *
 * The compose card shows this rather than a fabricated preview so that what
 * the user reads before pressing Create release is exactly what they get if
 * the changelog agent run fails.
 */
export function buildChangelogPreview(
  version: string,
  title: string | null,
  epics: { title: string; type?: string }[],
): string {
  const featureLines = epics
    .filter((e) => e.type !== "bug")
    .map((e) => `- ${e.title}`);
  const bugLines = epics
    .filter((e) => e.type === "bug")
    .map((e) => `- ${e.title}`);

  return [
    `# ${version}${title ? ` — ${title}` : ""}`,
    "",
    "## Features",
    featureLines.length > 0 ? featureLines.join("\n") : "- None",
    "",
    "## Bugfixes",
    bugLines.length > 0 ? bugLines.join("\n") : "- None",
    "",
    "## Breaking Changes",
    "- None",
    "",
  ].join("\n");
}

/** Caption casing is presentation, independent of translated wording. */
export function upperAge(relative: string, locale: UiLocale): string {
  return relative ? relative.toLocaleUpperCase(locale) : "—";
}

/**
 * Stored release versions are written by the user ("0.4.2") while the frame
 * prints them v-prefixed ("v0.4.2"). Prefix only when absent, so a row that
 * already carries the `v` never renders "vv0.4.2".
 *
 * Display only: the tag the server creates is literally `v${version}` and the
 * footer summary quotes that raw form on purpose.
 */
export function displayVersion(version: string): string {
  return /^v/i.test(version) ? version : `v${version}`;
}

/**
 * A stable tone index for a project that has no stored `colorIndex`.
 *
 * `projectTone()` wraps anything out of range, so a hash of the id gives every
 * project a fixed identity colour that survives reloads. The day a
 * `colorIndex` column lands, pass it instead — this is the documented fallback,
 * not a second source of truth.
 */
export function projectToneIndex(projectId: string): number {
  let hash = 0;
  for (let i = 0; i < projectId.length; i += 1) {
    hash = (hash * 31 + projectId.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}
