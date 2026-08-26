"use client";

import { useState, useMemo } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { MentionTextarea } from "@/components/documents/MentionTextarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { TicketCommentContent } from "@/components/verify/TicketCommentContent";
import { locateRegressionReport } from "@/lib/verify/regression-report";
import {
  Send,
  User,
  Bot,
  Cog,
  Loader2,
  Hammer,
  ArrowRight,
  ChevronRight,
  ChevronDown,
  Workflow,
  Bug,
} from "lucide-react";
import type { TicketComment } from "@/hooks/useTicketComments";
import { useFeedAutoScroll } from "@/hooks/useFeedAutoScroll";
import {
  useEpicActivity,
  type EpicActivityEntry,
} from "@/hooks/useEpicActivity";
import { formatTime, timeAgo } from "@/lib/utils/format-date";
import { COLUMN_LABELS } from "@/lib/types/kanban";
import {
  isPipelineActivityReason,
  pipelineReasonTone,
  type PipelineReasonTone,
} from "@/lib/pipeline/constants";
import { cn } from "@/lib/utils";
import {
  isMcpCreateBugActivityReason,
  MCP_CREATE_BUG_ACTIVITY_PREFIX,
} from "@/lib/mcp/create-bug-contract";

/* ------------------------------------------------------------------ */
/* Feed construction (pure, exported for tests)                        */
/* ------------------------------------------------------------------ */

/** Consecutive system transitions closer together than this collapse into one group. */
export const SYSTEM_GROUP_WINDOW_MS = 60_000;

export type FeedItem =
  | { kind: "comment"; ts: string; comment: TicketComment }
  | { kind: "transition"; ts: string; entry: EpicActivityEntry }
  | { kind: "pipeline"; ts: string; entry: EpicActivityEntry }
  | { kind: "bug-created"; ts: string; entry: EpicActivityEntry }
  | { kind: "transition-group"; ts: string; entries: EpicActivityEntry[] };

/** The `Story <id> — ` prefix a cascaded child write used to carry. */
const STORY_ECHO_PREFIX = /^Story \S+ — /;

/** Everything but the story identity: what a parent and its echo share. */
function movementKey(entry: EpicActivityEntry, reason: string): string {
  return JSON.stringify([
    entry.actor,
    entry.fromStatus,
    entry.toStatus,
    entry.sessionId,
    reason,
  ]);
}

/**
 * Drop the per-story echoes of an epic movement recorded before the cascade
 * fix (lib/workflow/transition-service.ts).
 *
 * Moving an epic used to append one `Story <id> — <reason>` row per story
 * beside the epic's own, so a five-story epic showed six identical
 * "Agent moved In Progress → Review" lines. New movements record a single
 * entry; histories written earlier are folded here instead.
 *
 * A story row is dropped only when another entry has the same actor, status
 * pair, session AND the exact same reason minus the prefix — i.e. it is
 * provably the parent's own line repeated. A genuinely story-scoped move
 * keeps its row: its parent entry reads differently ("All stories are in
 * review or done"), so nothing matches it. Unprefixed entries are never
 * dropped.
 */
export function dropCascadeEchoes(
  entries: EpicActivityEntry[]
): EpicActivityEntry[] {
  const parents = new Set(
    entries
      .filter((entry) => !STORY_ECHO_PREFIX.test(entry.reason ?? ""))
      .map((entry) => movementKey(entry, entry.reason ?? ""))
  );
  if (parents.size === 0) return entries;
  return entries.filter((entry) => {
    const reason = entry.reason ?? "";
    if (!STORY_ECHO_PREFIX.test(reason)) return true;
    return !parents.has(
      movementKey(entry, reason.replace(STORY_ECHO_PREFIX, ""))
    );
  });
}

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
    ...dropCascadeEchoes(entries).map((entry) => ({
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
/* Filtering (pure, exported for tests)                                */
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
/* Long-entry collapsing (pure, exported for tests)                    */
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

/* ------------------------------------------------------------------ */
/* Presentational pieces                                               */
/* ------------------------------------------------------------------ */

const ACTOR_STYLES: Record<
  EpicActivityEntry["actor"],
  { label: string; Icon: typeof User; className: string }
> = {
  user: { label: "You", Icon: User, className: "text-foreground" },
  agent: { label: "Agent", Icon: Bot, className: "text-agent" },
  system: { label: "System", Icon: Cog, className: "text-priority-yellow" },
};

function StatusChip({ status }: { status: string }) {
  const label =
    (COLUMN_LABELS as Record<string, string>)[status] ?? status;
  return (
    <span className="rounded-[6px] bg-band px-1.5 py-0.5 text-[11px] font-medium">
      {label}
    </span>
  );
}

function TransitionRow({
  entry,
  projectId,
}: {
  entry: EpicActivityEntry;
  projectId: string;
}) {
  const actor = ACTOR_STYLES[entry.actor] ?? ACTOR_STYLES.system;
  const { Icon } = actor;
  return (
    <div
      data-testid="activity-transition"
      data-actor={entry.actor}
      data-kind="system"
      className="flex flex-wrap items-center gap-1.5 px-1 py-0.5 text-[12px]"
    >
      <Icon className={`h-3.5 w-3.5 shrink-0 ${actor.className}`} />
      <span className={`font-medium ${actor.className}`}>{actor.label}</span>
      <span className="text-muted-foreground">moved</span>
      <StatusChip status={entry.fromStatus} />
      <ArrowRight className="h-3 w-3 text-muted-foreground" />
      <StatusChip status={entry.toStatus} />
      <span className="text-muted-foreground">{timeAgo(entry.createdAt)}</span>
      {entry.sessionId && (
        <Link
          data-testid="activity-session-link"
          href={`/projects/${projectId}/sessions/${entry.sessionId}`}
          className="text-primary underline-offset-2 hover:underline"
        >
          View session
        </Link>
      )}
      {entry.reason && (
        <span className="w-full pl-5 italic text-muted-foreground">
          {entry.reason}
        </span>
      )}
    </div>
  );
}

const PIPELINE_TONE_STYLES: Record<PipelineReasonTone, string> = {
  progress: "text-primary",
  success: "text-agent",
  paused: "text-priority-yellow",
  failure: "text-destructive",
};

/**
 * One line of the autonomous pipeline's narration. Renders the reason text
 * itself (the trace strings are the contract) instead of the from→to status
 * pair, which is always a no-op transition for these entries.
 */
function PipelineRow({
  entry,
  projectId,
}: {
  entry: EpicActivityEntry;
  projectId: string;
}) {
  const reason = entry.reason ?? "Pipeline event";
  const tone = pipelineReasonTone(reason);
  return (
    <div
      data-testid="activity-pipeline"
      data-tone={tone}
      data-kind="system"
      className="flex flex-wrap items-center gap-1.5 border-l-2 border-agent-border px-1 py-0.5 pl-2 text-[12px]"
    >
      <Workflow className={`h-3.5 w-3.5 shrink-0 ${PIPELINE_TONE_STYLES[tone]}`} />
      <span className={`font-medium ${PIPELINE_TONE_STYLES[tone]}`}>
        {reason}
      </span>
      <span className="text-muted-foreground">{timeAgo(entry.createdAt)}</span>
      {entry.sessionId && (
        <Link
          data-testid="activity-session-link"
          href={`/projects/${projectId}/sessions/${entry.sessionId}`}
          className="text-primary underline-offset-2 hover:underline"
        >
          View session
        </Link>
      )}
    </div>
  );
}

function BugCreatedRow({
  entry,
  projectId,
}: {
  entry: EpicActivityEntry;
  projectId: string;
}) {
  const detail = entry.reason
    ?.slice(MCP_CREATE_BUG_ACTIVITY_PREFIX.length)
    .trim();
  return (
    <div
      data-testid="activity-bug-created"
      data-actor={entry.actor}
      data-kind="system"
      className="flex flex-wrap items-center gap-1.5 rounded-[8px] border border-destructive/20 bg-destructive/5 px-2 py-1.5 text-[12px]"
    >
      <Bug className="h-3.5 w-3.5 shrink-0 text-destructive" />
      <span className="font-medium text-agent">Agent</span>
      <span className="text-foreground">created this bug</span>
      <span className="text-muted-foreground">{timeAgo(entry.createdAt)}</span>
      {entry.sessionId && (
        <Link
          data-testid="activity-session-link"
          href={`/projects/${projectId}/sessions/${entry.sessionId}`}
          className="text-primary underline-offset-2 hover:underline"
        >
          View source session
        </Link>
      )}
      {detail && (
        <span className="w-full pl-5 italic text-muted-foreground">
          {detail}
        </span>
      )}
    </div>
  );
}

function TransitionGroupRow({
  entries,
  ts,
  projectId,
}: {
  entries: EpicActivityEntry[];
  ts: string;
  projectId: string;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div data-kind="system">
      <button
        type="button"
        data-testid="activity-transition-group"
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center gap-1.5 px-1 py-0.5 text-[12px] text-muted-foreground hover:text-foreground"
      >
        {expanded ? (
          <ChevronDown className="h-3 w-3" />
        ) : (
          <ChevronRight className="h-3 w-3" />
        )}
        <Cog className="h-3.5 w-3.5 text-priority-yellow" />
        <span>{entries.length} automatic transitions</span>
        <span>{timeAgo(ts)}</span>
      </button>
      {expanded && (
        <div className="ml-4 border-l border-border pl-2">
          {entries.map((entry) => (
            <TransitionRow key={entry.id} entry={entry} projectId={projectId} />
          ))}
        </div>
      )}
    </div>
  );
}

function CommentRow({ comment }: { comment: TicketComment }) {
  const [expanded, setExpanded] = useState(false);
  // A verify report renders as a structured red/green block, not prose:
  // a word-boundary preview would cut its JSON payload and drop it back to
  // a raw blob, so report comments stay whole instead of collapsing.
  const isReport = locateRegressionReport(comment.content) !== null;
  const long = !isReport && isLongComment(comment.content);
  const showFull = !long || expanded;
  return (
    <div
      data-testid="activity-comment"
      data-kind="comment"
      data-long={long || undefined}
      className={`rounded-[11px] p-3 ${
        comment.author === "agent"
          ? "border border-agent-border bg-agent-bg"
          : "border border-border-soft bg-band"
      }`}
    >
      <div className="flex items-center gap-2 mb-2">
        {comment.author === "agent" ? (
          <Bot className="h-3.5 w-3.5 text-agent" />
        ) : (
          <User className="h-3.5 w-3.5 text-muted-foreground" />
        )}
        <span className="text-xs font-medium">
          {comment.author === "agent" ? "Agent" : "You"}
        </span>
        <span className="text-xs text-muted-foreground">
          {formatTime(comment.createdAt)}
        </span>
      </div>
      {/* Long build outputs and logs collapse to a word-boundary preview so
          the feed stays scannable; the full text stays one click away. */}
      <div className="text-sm">
        <TicketCommentContent
          content={showFull ? comment.content : commentPreview(comment.content)}
        />
      </div>
      {long && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          data-testid={
            expanded ? "activity-comment-collapse" : "activity-comment-expand"
          }
          className="mt-2 text-[12px] font-medium text-primary hover:underline"
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Feed                                                                */
/* ------------------------------------------------------------------ */

interface EpicActivityFeedProps {
  projectId: string;
  epicId: string | null;
  comments: TicketComment[];
  commentsLoading: boolean;
  onAddComment: (content: string) => Promise<unknown>;
  /** One-click dispatch: immediately sends to dev without dialog */
  onSendToDev?: () => Promise<unknown>;
  /** Whether the send-to-dev action is disabled (agent running, etc.) */
  sendToDevDisabled?: boolean;
  /** Whether the send-to-dev action is currently dispatching */
  sendToDevLoading?: boolean;
}

/**
 * Unified activity feed for an epic: comments and kanban transitions
 * interleaved chronologically, plus the comment composer.
 *
 * Transitions come from `useEpicActivity` (polled at 5s while mounted; the
 * Activity tab unmounts this component when hidden, so polling stops with it).
 */
export function EpicActivityFeed({
  projectId,
  epicId,
  comments,
  commentsLoading,
  onAddComment,
  onSendToDev,
  sendToDevDisabled,
  sendToDevLoading,
}: EpicActivityFeedProps) {
  const { entries, loading: activityLoading } = useEpicActivity(
    projectId,
    epicId
  );

  const feed = useMemo(
    () => buildActivityFeed(comments, entries),
    [comments, entries]
  );
  // Legacy per-story echoes are folded out of the feed, so they must not
  // inflate the header count either.
  const entryCount = useMemo(() => dropCascadeEchoes(entries).length, [entries]);

  const [filter, setFilter] = useState<ActivityFilter>("all");
  const visibleFeed = useMemo(
    () => filterActivityFeed(feed, filter),
    [feed, filter]
  );
  const kindCounts = useMemo(() => {
    const comments = feed.filter((item) => feedItemKind(item) === "comment").length;
    return { all: feed.length, comments, system: feed.length - comments };
  }, [feed]);

  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Follows the newest entry; see useFeedAutoScroll for the viewport it
  // actually scrolls and when it declines to follow.
  const scrollRef = useFeedAutoScroll(feed.length);

  async function handleSubmit() {
    if (!input.trim() || sending) return;
    setSending(true);
    setError(null);
    try {
      await onAddComment(input.trim());
      setInput("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to add comment");
    } finally {
      setSending(false);
    }
  }

  const loading = commentsLoading || activityLoading;

  return (
    <div className="flex flex-col h-full">
      {/* Header + kind filter (comments vs. system events) */}
      <div className="shrink-0 border-b border-border-soft px-[24px] py-[12px]">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-[12px] uppercase tracking-[.08em] text-meta">
            Activity ({comments.length + entryCount})
          </h3>
          <div
            className="flex items-center gap-[4px]"
            data-testid="activity-filter-bar"
            role="group"
            aria-label="Filter activity"
          >
            {(["all", "comments", "system"] as const).map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => setFilter(f)}
                aria-pressed={filter === f}
                data-testid={`activity-filter-${f}`}
                className={cn(
                  "rounded-full px-[8px] text-[11px] leading-[20px]",
                  filter === f
                    ? "bg-band font-medium text-foreground"
                    : "text-meta hover:text-foreground"
                )}
              >
                {f === "all" ? "All" : f === "comments" ? "Comments" : "System"} ({kindCounts[f]})
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Feed — the only scrolling box of the panel.
          `min-h-0` is what makes it one: a flex item defaults to
          `min-height: auto`, so without it the ScrollArea root is floored at
          its content height, grows past the panel instead of scrolling, and
          the feed (plus the composer under it) gets clipped by the panel's
          `overflow-hidden` with no scrollbar anywhere. */}
      <ScrollArea className="min-h-0 flex-1" data-testid="activity-scroll-area">
        <div ref={scrollRef} className="space-y-3 px-[24px] py-[18px]">
          {loading && feed.length === 0 ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            </div>
          ) : feed.length === 0 ? (
            <p className="py-8 text-center text-[13px] text-muted-foreground">
              No activity yet. Start the conversation.
            </p>
          ) : visibleFeed.length === 0 ? (
            <p
              className="py-8 text-center text-[13px] text-muted-foreground"
              data-testid="activity-filter-empty"
            >
              Nothing here — try another filter.
            </p>
          ) : (
            visibleFeed.map((item) =>
              item.kind === "comment" ? (
                <CommentRow key={item.comment.id} comment={item.comment} />
              ) : item.kind === "pipeline" ? (
                <PipelineRow
                  key={item.entry.id}
                  entry={item.entry}
                  projectId={projectId}
                />
              ) : item.kind === "bug-created" ? (
                <BugCreatedRow
                  key={item.entry.id}
                  entry={item.entry}
                  projectId={projectId}
                />
              ) : item.kind === "transition" ? (
                <TransitionRow
                  key={item.entry.id}
                  entry={item.entry}
                  projectId={projectId}
                />
              ) : (
                <TransitionGroupRow
                  key={item.entries[0].id}
                  entries={item.entries}
                  ts={item.ts}
                  projectId={projectId}
                />
              )
            )
          )}
        </div>
      </ScrollArea>

      {/* Input — pinned outside the scrolling viewport. */}
      <div
        className="shrink-0 border-t border-border-soft px-[18px] py-[14px]"
        data-testid="activity-composer"
      >
        {error && <p className="mb-2 text-[12px] text-destructive">{error}</p>}
        <div className="flex gap-2">
          <MentionTextarea
            projectId={projectId}
            value={input}
            onValueChange={setInput}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSubmit();
              }
            }}
            placeholder="Add a comment..."
            rows={3}
            className="min-h-24 resize-none"
          />
          <div className="flex flex-col gap-1 shrink-0 self-end">
            <Button
              size="icon"
              onClick={handleSubmit}
              disabled={!input.trim() || sending}
            >
              {sending ? (
                <Loader2 className="h-5 w-5 animate-spin" />
              ) : (
                <Send className="h-5 w-5" />
              )}
            </Button>
            {onSendToDev && (
              <Button
                size="icon"
                variant="outline"
                onClick={onSendToDev}
                disabled={sendToDevDisabled || sendToDevLoading}
                title="Send to dev"
                data-testid="send-to-dev-button"
              >
                {sendToDevLoading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Hammer className="h-4 w-4" />
                )}
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
