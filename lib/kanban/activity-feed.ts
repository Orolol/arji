/**
 * Ticket activity feed — pure construction, filtering and collapsing.
 *
 * Rescued verbatim out of `components/kanban/epic-detail/EpicActivityFeed.tsx`
 * when the Piscine redesign replaced the three-tab ticket panel with the
 * frame-6a overlay. The component went; this logic did not, because it is the
 * tested part: merging comments with transitions, collapsing bursts of system
 * transitions, and previewing long build logs.
 *
 * `isLongComment` / `commentPreview` are what the overlay's `CommentBubble`
 * uses today. The feed builders keep their suites and stay available to
 * whichever surface next needs the merged chronology.
 */

import type { TicketComment } from "@/hooks/useTicketComments";
import type { EpicActivityEntry } from "@/hooks/useEpicActivity";
import { isPipelineActivityReason } from "@/lib/pipeline/constants";
import { isMcpCreateBugActivityReason } from "@/lib/mcp/create-bug-contract";

/* ------------------------------------------------------------------ */
/* Feed construction                                                   */
/* ------------------------------------------------------------------ */

/** Consecutive system transitions closer together than this collapse into one group. */
export const SYSTEM_GROUP_WINDOW_MS = 60_000;

export type FeedItem =
  | { kind: "comment"; ts: string; comment: TicketComment }
  | { kind: "transition"; ts: string; entry: EpicActivityEntry }
  | { kind: "pipeline"; ts: string; entry: EpicActivityEntry }
  | { kind: "bug-created"; ts: string; entry: EpicActivityEntry }
  | { kind: "transition-group"; ts: string; entries: EpicActivityEntry[] };

/**
 * Merge comments and transition entries into one chronological (oldest-first)
 * feed. Runs of 2+ consecutive `system` transitions whose successive
 * timestamps are within `SYSTEM_GROUP_WINDOW_MS` collapse into a single
 * `transition-group` item (timestamped at the run's newest entry).
 *
 * Autonomous-pipeline trace entries are `system` transitions too, but they
 * are the narration of a running pipeline — collapsing them behind an
 * "N automatic transitions" toggle would hide exactly the information the
 * user opened the feed for. They are split out as their own `pipeline`
 * items, which also breaks any surrounding grouping run.
 */
export function buildActivityFeed(
  comments: TicketComment[],
  entries: EpicActivityEntry[]
): FeedItem[] {
  const raw: FeedItem[] = [
    ...comments.map((comment) => ({
      kind: "comment" as const,
      ts: comment.createdAt ?? "",
      comment,
    })),
    ...entries.map((entry) => ({
      kind: isPipelineActivityReason(entry.reason)
        ? ("pipeline" as const)
        : isMcpCreateBugActivityReason(entry.reason)
          ? ("bug-created" as const)
          : ("transition" as const),
      ts: entry.createdAt ?? "",
      entry,
    })),
  ].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));

  const feed: FeedItem[] = [];
  let run: EpicActivityEntry[] = [];

  const flushRun = () => {
    if (run.length >= 2) {
      feed.push({
        kind: "transition-group",
        ts: run[run.length - 1].createdAt ?? "",
        entries: run,
      });
    } else {
      for (const entry of run) {
        feed.push({ kind: "transition", ts: entry.createdAt ?? "", entry });
      }
    }
    run = [];
  };

  for (const item of raw) {
    if (item.kind === "transition" && item.entry.actor === "system") {
      const prev = run[run.length - 1];
      const gap =
        prev && prev.createdAt && item.entry.createdAt
          ? new Date(item.entry.createdAt).getTime() -
            new Date(prev.createdAt).getTime()
          : Number.POSITIVE_INFINITY;
      if (prev && gap > SYSTEM_GROUP_WINDOW_MS) flushRun();
      run.push(item.entry);
    } else {
      flushRun();
      feed.push(item);
    }
  }
  flushRun();

  return feed;
}

/* ------------------------------------------------------------------ */
/* Filtering                                                           */
/* ------------------------------------------------------------------ */

export type ActivityFilter = "all" | "comments" | "system";

/** "comment" for human/agent comments, "system" for everything else. */
export function feedItemKind(item: FeedItem): "comment" | "system" {
  return item.kind === "comment" ? "comment" : "system";
}

export function matchesActivityFilter(
  item: FeedItem,
  filter: ActivityFilter
): boolean {
  if (filter === "all") return true;
  const kind = feedItemKind(item);
  return filter === "comments" ? kind === "comment" : kind === "system";
}

/**
 * Apply the visible-kind filter to an already-built feed. Grouping is
 * computed on the full feed (see buildActivityFeed) so a heavy system
 * burst still collapses even when some of it is filtered out — filtering
 * only hides, it never re-orders or re-groups.
 */
export function filterActivityFeed(
  feed: FeedItem[],
  filter: ActivityFilter
): FeedItem[] {
  return feed.filter((item) => matchesActivityFilter(item, filter));
}

/* ------------------------------------------------------------------ */
/* Long-entry collapsing                                               */
/* ------------------------------------------------------------------ */

/** Comments at or above this length collapse behind a preview. */
export const LONG_COMMENT_THRESHOLD = 400;

export function isLongComment(content: string): boolean {
  return content.length >= LONG_COMMENT_THRESHOLD;
}

/**
 * Truncate to `max` characters on a word boundary (no mid-word cuts) with
 * an ellipsis. Used as the collapsed preview for long build outputs and
 * logs so the feed stays scannable.
 */
export function commentPreview(
  content: string,
  max: number = LONG_COMMENT_THRESHOLD
): string {
  if (content.length <= max) return content;
  const cut = content.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  const boundary = lastSpace > 0 ? lastSpace : max;
  return `${cut.slice(0, boundary).trimEnd()}…`;
}
