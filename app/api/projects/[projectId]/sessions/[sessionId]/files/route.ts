import fs from "fs";
import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import simpleGit from "simple-git";

import { db } from "@/lib/db";
import { agentSessions } from "@/lib/db/schema";
import {
  getEpicOr404,
  getProjectOr404,
  isErrorResponse,
} from "@/lib/api/route-helpers";
import { resolveDefaultBranch } from "@/lib/git/manager";
import type {
  SessionDiff,
  SessionDiffFile,
  SessionFilesProject,
  SessionFilesTicket,
} from "@/components/session-live/types";

/**
 * What the live-session screen's FILES TOUCHED card reads: the identity of the
 * session's ticket and project, plus a COUNTS-ONLY diffstat of its worktree.
 *
 * WHY THIS IS NOT `epics/[epicId]/diff`. That route answers with full hunks
 * (`FileDiff.hunks[].lines[]`) — kilobytes per file, none of which this card
 * shows — and, decisively, it calls `createWorktree` at its line 44, creating
 * a worktree as a SIDE EFFECT of a GET. This screen refetches every 15 seconds
 * while a session runs, so that is not an option. Everything below is
 * read-only: no `createWorktree`, no `attachWorktree`, no checkout, no
 * `worktree add`, no write of any kind.
 *
 * WHY THE TICKET RIDES ALONG. The header needs `readableId` and `title`, and
 * the only other source is `GET /api/projects/:id/epics`, a 727-line
 * aggregation the board already polls. This handler holds the epic row anyway.
 * Both `ticket` and `project` are resolved BEFORE any git work, so a broken
 * git state never blanks the header.
 *
 * WHY IT NEVER 500s. A damaged worktree, a pruned checkout or a git binary
 * that throws must not take the whole live-session page down with it: every
 * git failure answers 200 with `diff.available: false` and a `reason`, the
 * same posture the sibling route takes for unreadable chunks and logs.
 */

type Params = { params: Promise<{ projectId: string; sessionId: string }> };

/** Row cap on the file list. `totals` is still computed over everything. */
const MAX_FILES = 60;

/** A diff we could not produce, with the reason and no invented numbers. */
function unavailable(
  reason: NonNullable<SessionDiff["reason"]>,
  branchName: string | null
): SessionDiff {
  return {
    available: false,
    reason,
    branchName,
    baseBranch: null,
    mergeBase: null,
    behind: null,
    ahead: null,
    files: [],
    totals: null,
    truncated: false,
  };
}

/**
 * The path field of a `--numstat` row, with git's two rename spellings
 * resolved to the destination path: `old => new` for a whole-path rename and
 * `dir/{old => new}/file` for a partial one.
 */
function normaliseNumstatPath(raw: string): string {
  const braced = /^(.*)\{(.*) => (.*)\}(.*)$/.exec(raw);
  if (braced) {
    return `${braced[1]}${braced[3]}${braced[4]}`.replace(/\/{2,}/g, "/");
  }
  const arrow = raw.lastIndexOf(" => ");
  return arrow === -1 ? raw : raw.slice(arrow + 4);
}

interface NumstatRow {
  path: string;
  added: number | null;
  removed: number | null;
}

/**
 * Parse `git diff --numstat`. Each row is `added\tremoved\tpath`; a binary
 * file is `-\t-\tpath`, which becomes a null pair rather than a zero pair —
 * `+0 −0` on a binary file would be a lie, `DiffDelta` draws nothing for null.
 */
function parseNumstat(output: string): NumstatRow[] {
  const rows: NumstatRow[] = [];

  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    if (parts.length < 3) continue;

    const [addedRaw, removedRaw, ...rest] = parts;
    const path = normaliseNumstatPath(rest.join("\t").trim());
    if (!path) continue;

    const added = addedRaw === "-" ? null : Number.parseInt(addedRaw, 10);
    const removed = removedRaw === "-" ? null : Number.parseInt(removedRaw, 10);

    rows.push({
      path,
      added: added === null || Number.isNaN(added) ? null : added,
      removed: removed === null || Number.isNaN(removed) ? null : removed,
    });
  }

  return rows;
}

/** Sum two counts where `null` means "not countable", not "zero". */
function addCounts(a: number | null, b: number | null): number | null {
  if (a === null && b === null) return null;
  return (a ?? 0) + (b ?? 0);
}

export async function GET(_request: NextRequest, { params }: Params) {
  const { projectId, sessionId } = await params;

  // Scoped by the PAIR, exactly like the sibling detail route: the URL says
  // which project owns this session and `project_id` is NOT NULL, so a
  // mismatch is a session from somewhere else. 404, not 403 — a caller with
  // the wrong project has no business learning the id exists.
  const session = db
    .select()
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.id, sessionId),
        eq(agentSessions.projectId, projectId)
      )
    )
    .get();

  if (!session) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  // Identity first, git second: the header must not depend on the worktree.
  let ticket: SessionFilesTicket | null = null;
  if (session.epicId) {
    const found = getEpicOr404(projectId, session.epicId);
    // A deleted epic is not an error here — the session outlives its ticket.
    if (!isErrorResponse(found)) {
      ticket = {
        id: found.epic.id,
        readableId: found.epic.readableId ?? null,
        title: found.epic.title,
      };
    }
  }

  const foundProject = getProjectOr404(projectId);
  if (isErrorResponse(foundProject)) return foundProject;
  const { project } = foundProject;
  const projectSummary: SessionFilesProject = {
    id: project.id,
    name: project.name,
  };

  const branchName = session.branchName ?? null;
  const worktreePath = session.worktreePath ?? null;

  function answer(diff: SessionDiff) {
    return NextResponse.json({
      data: { sessionId, ticket, project: projectSummary, diff },
    });
  }

  if (!project.gitRepoPath) return answer(unavailable("not-a-repo", branchName));
  if (!worktreePath) return answer(unavailable("no-worktree", branchName));
  // Worktrees are pruned when a ticket lands; the session row keeps the path.
  // The worktree belongs to the *user's* repository, outside this app's tree,
  // so there is nothing here for the build to trace.
  if (!fs.existsSync(/*turbopackIgnore: true*/ worktreePath)) {
    return answer(unavailable("worktree-missing", branchName));
  }

  try {
    // Resolve the base through the SAME path `createWorktree` did rather than
    // reading `projects.default_branch` raw: a stored default that no longer
    // exists locally (renamed after import, or a local branch set that
    // diverged from the remote's) fed `merge-base` a non-existent ref and
    // produced a silent empty diff over a branch with real commits.
    const baseBranch = await resolveDefaultBranch(
      project.gitRepoPath,
      project.defaultBranch
    );
    if (baseBranch.startsWith("-")) {
      throw new Error(`Invalid base branch: ${baseBranch}`);
    }

    const git = simpleGit(worktreePath);

    let mergeBase: string | null = null;
    try {
      // The `--` separator is what stops `baseBranch` being read as an option.
      mergeBase = (
        await git.raw(["merge-base", "--", baseBranch, "HEAD"])
      ).trim();
    } catch {
      // Unrelated histories or a missing base branch: no merge base, no line.
    }

    let behind: number | null = null;
    let ahead: number | null = null;
    try {
      const revList = (
        await git.raw([
          "rev-list",
          "--left-right",
          "--count",
          `${baseBranch}...HEAD`,
        ])
      ).trim();
      const parts = revList.split(/\s+/);
      const left = Number.parseInt(parts[0], 10);
      const right = Number.parseInt(parts[1], 10);
      behind = Number.isNaN(left) ? null : left;
      ahead = Number.isNaN(right) ? null : right;
    } catch {
      // Counts stay null; the "à jour" suffix is then omitted, not guessed.
    }

    let committed: NumstatRow[] = [];
    if (mergeBase) {
      try {
        committed = parseNumstat(
          await git.raw(["diff", "--numstat", mergeBase, "HEAD"])
        );
      } catch {
        // No committed rows; the in-progress ones below may still stand.
      }
    }

    const inProgress: NumstatRow[] = [];
    try {
      inProgress.push(...parseNumstat(await git.raw(["diff", "--numstat"])));
    } catch {
      // Unstaged read failed — fall through to the staged one.
    }
    try {
      inProgress.push(
        ...parseNumstat(await git.raw(["diff", "--cached", "--numstat"]))
      );
    } catch {
      // Staged read failed.
    }

    // Merge by path. A file present in the staged/unstaged numstat is one the
    // agent is still writing: it is flagged `inProgress`, its counts summed
    // with whatever it already committed, and the card shows the word "en
    // cours" instead of a bar — a bar over a diff still moving is a lie.
    const byPath = new Map<string, SessionDiffFile>();

    for (const row of committed) {
      const seen = byPath.get(row.path);
      byPath.set(row.path, {
        path: row.path,
        added: seen ? addCounts(seen.added, row.added) : row.added,
        removed: seen ? addCounts(seen.removed, row.removed) : row.removed,
        inProgress: seen?.inProgress ?? false,
      });
    }

    for (const row of inProgress) {
      const seen = byPath.get(row.path);
      byPath.set(row.path, {
        path: row.path,
        added: seen ? addCounts(seen.added, row.added) : row.added,
        removed: seen ? addCounts(seen.removed, row.removed) : row.removed,
        inProgress: true,
      });
    }

    const all = [...byPath.values()].sort(
      (a, b) =>
        (b.added ?? 0) + (b.removed ?? 0) - ((a.added ?? 0) + (a.removed ?? 0))
    );

    // Totals cover EVERY row even when the list below is capped, so the band
    // meta stays honest about how much the session actually touched.
    const totals = all.length
      ? {
          files: all.length,
          added: all.reduce((sum, file) => sum + (file.added ?? 0), 0),
          removed: all.reduce((sum, file) => sum + (file.removed ?? 0), 0),
        }
      : null;

    return answer({
      available: true,
      branchName,
      baseBranch,
      mergeBase,
      behind,
      ahead,
      files: all.slice(0, MAX_FILES),
      totals,
      truncated: all.length > MAX_FILES,
    });
  } catch (error) {
    console.warn(
      `[sessions] files diff failed for session ${sessionId}:`,
      error
    );
    return answer(unavailable("git-failed", branchName));
  }
}
