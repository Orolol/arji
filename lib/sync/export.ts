import { db } from "@/lib/db";
import { projects, epics, userStories, ticketComments } from "@/lib/db/schema";
import { eq, inArray, or, sql } from "drizzle-orm";
import { writeArjiJson } from "./arji-json";
import type { ArjiJson, ArjiJsonEpic, ArjiJsonComment } from "./arji-json";

function toJsonComment(c: { id: string; author: string; content: string; createdAt: string | null }): ArjiJsonComment {
  return { id: c.id, author: c.author, content: c.content, createdAt: c.createdAt };
}

/**
 * Buckets rows by a nullable foreign key, preserving the order the rows were
 * read in. The queries below order by `rowid` explicitly, so a bucket holds
 * exactly what a per-parent `WHERE fk = ?` query used to return: insertion
 * order. Relying on the scan order instead would be a silent dependency on
 * the query plan — see the comments-query note below.
 */
function groupBy<T>(rows: T[], key: (row: T) => string | null): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const k = key(row);
    if (k === null) continue;
    const bucket = grouped.get(k);
    if (bucket) bucket.push(row);
    else grouped.set(k, [row]);
  }
  return grouped;
}

/**
 * `ORDER BY position` as SQLite performs it: NULLs first, then ascending.
 * Applied through `Array.prototype.sort`, which is stable, so rows tied on
 * position keep their rowid order — the same order the per-epic query gave.
 */
function comparePosition(a: number | null, b: number | null): number {
  if (a === null) return b === null ? 0 : -1;
  if (b === null) return 1;
  return a - b;
}

/**
 * Writes the project's `arji.json`.
 *
 * Three queries, whatever the board holds: the epics of the project, the
 * stories of those epics, and the comments attached to either. The previous
 * shape issued one stories query and one comments query per epic plus one
 * comments query per story — roughly 750 queries for a 158-epic project, all
 * of them blocking the shared synchronous better-sqlite3 connection and
 * therefore the whole event loop.
 */
export async function exportArjiJson(projectId: string): Promise<void> {
  const project = db.select().from(projects).where(eq(projects.id, projectId)).get();
  if (!project || !project.gitRepoPath) return;

  const allEpics = db
    .select()
    .from(epics)
    .where(eq(epics.projectId, projectId))
    .orderBy(epics.status, epics.position)
    .all();

  const epicIds = allEpics.map((epic) => epic.id);

  // `ORDER BY rowid`, not the scan order: `user_stories_epic_position_idx`
  // (migration 0046) makes this an index SEARCH, and an index-driven read is
  // only incidentally in insertion order. The sort below is stable, so rows
  // tied on `position` keep exactly the order the per-epic query gave.
  const allStories = epicIds.length
    ? db
        .select()
        .from(userStories)
        .where(inArray(userStories.epicId, epicIds))
        .orderBy(sql`rowid`)
        .all()
    : [];

  const storyIds = allStories.map((story) => story.id);

  // A comment carrying both keys belonged to both result sets before, and
  // still lands in both buckets below.
  //
  // `ORDER BY rowid` is load-bearing. With `ticket_comments_epic_idx` and
  // `ticket_comments_user_story_idx` both present (migration 0046) SQLite
  // answers this OR with MULTI-INDEX OR: it walks the epic index, then the
  // story index, and de-duplicates by rowid — so a comment carrying BOTH keys
  // is emitted while the epic branch is running, ahead of story-only comments
  // that were inserted before it. That reorders the story bucket against the
  // per-parent queries this replaced, and `arji.json` is a tracked file whose
  // bytes would churn. Ordering by rowid pins insertion order on both
  // branches, whatever plan the planner picks.
  const allComments =
    epicIds.length || storyIds.length
      ? db
          .select()
          .from(ticketComments)
          .where(
            or(
              epicIds.length ? inArray(ticketComments.epicId, epicIds) : undefined,
              storyIds.length ? inArray(ticketComments.userStoryId, storyIds) : undefined,
            ),
          )
          .orderBy(sql`rowid`)
          .all()
      : [];

  const storiesByEpic = groupBy(allStories, (story) => story.epicId);
  for (const bucket of storiesByEpic.values()) {
    bucket.sort((a, b) => comparePosition(a.position, b.position));
  }
  const commentsByEpic = groupBy(allComments, (comment) => comment.epicId);
  const commentsByStory = groupBy(allComments, (comment) => comment.userStoryId);

  const epicList: ArjiJsonEpic[] = allEpics.map((epic) => {
    const stories = storiesByEpic.get(epic.id) ?? [];
    const epicComments = commentsByEpic.get(epic.id) ?? [];

    return {
      id: epic.id,
      title: epic.title,
      description: epic.description,
      priority: epic.priority ?? 0,
      status: epic.status ?? "backlog",
      position: epic.position ?? 0,
      branchName: epic.branchName,
      type: epic.type ?? "feature",
      user_stories: stories.map((us) => {
        const storyComments = commentsByStory.get(us.id) ?? [];

        return {
          id: us.id,
          title: us.title,
          description: us.description,
          acceptance_criteria: us.acceptanceCriteria,
          status: us.status ?? "todo",
          position: us.position ?? 0,
          ...(storyComments.length > 0 && {
            comments: storyComments.map(toJsonComment),
          }),
        };
      }),
      ...(epicComments.length > 0 && {
        comments: epicComments.map(toJsonComment),
      }),
    };
  });

  const data: ArjiJson = {
    version: 1,
    lastSyncedAt: new Date().toISOString(),
    project: {
      name: project.name,
      description: project.description,
      status: project.status ?? "ideation",
      spec: project.spec,
    },
    epics: epicList,
  };

  await writeArjiJson(project.gitRepoPath, data);
}

/** How long a burst of board writes collapses into a single export. */
const EXPORT_DEBOUNCE_MS = 250;
/**
 * Ceiling on how long a sustained stream of writes may keep deferring the
 * export. Without it, one write every 200 ms would postpone `arji.json`
 * indefinitely.
 */
const EXPORT_MAX_WAIT_MS = 2_000;

interface PendingExport {
  timer: ReturnType<typeof setTimeout>;
  /** When the first write of the current burst arrived. */
  burstStartedAt: number;
}

const pendingExports = new Map<string, PendingExport>();
/** One in-flight export per project, so two runs cannot race on the file. */
const inFlightExports = new Map<string, Promise<void>>();

function runExport(projectId: string): Promise<void> {
  const previous = inFlightExports.get(projectId) ?? Promise.resolve();
  const next: Promise<void> = previous
    .then(() => exportArjiJson(projectId))
    .catch((err) => console.warn("[sync/export] failed:", err))
    .finally(() => {
      if (inFlightExports.get(projectId) === next) inFlightExports.delete(projectId);
    });
  inFlightExports.set(projectId, next);
  return next;
}

function scheduleExport(projectId: string): void {
  const now = Date.now();
  const pending = pendingExports.get(projectId);
  const burstStartedAt = pending?.burstStartedAt ?? now;
  const deadline = burstStartedAt + EXPORT_MAX_WAIT_MS;

  if (pending) {
    // Already at the ceiling: the scheduled timer is the one that has to fire.
    if (now >= deadline) return;
    clearTimeout(pending.timer);
  }

  const delay = Math.max(0, Math.min(EXPORT_DEBOUNCE_MS, deadline - now));
  const timer = setTimeout(() => {
    pendingExports.delete(projectId);
    void runExport(projectId);
  }, delay);
  // A queued export must never be the reason the process stays alive.
  timer.unref?.();
  pendingExports.set(projectId, { timer, burstStartedAt });
}

/**
 * Fire-and-forget wrapper — never throws, never blocks the caller.
 *
 * Debounced per project: dragging a card fires several board writes in a row,
 * and each one used to rewrite the whole file. Now the burst coalesces into
 * one export. `exportArjiJson` stays available for callers that need the file
 * on disk before they return (the manual sync route).
 */
export function tryExportArjiJson(projectId: string): void {
  // Never export during test runs: a test that reaches this path through the
  // real db would destructively rewrite the tracked arji.json of THIS repo
  // from whatever the local dev database happens to contain.
  if (process.env.VITEST) return;
  scheduleExport(projectId);
}
