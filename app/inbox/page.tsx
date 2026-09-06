"use client";

import { useLocale } from "next-intl";
import { useMemo, useState } from "react";
import Link from "next/link";
import {
  Check,
  Hammer,
  Inbox,
  Mail,
  MessageCircleQuestion,
  Send,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useInbox, type InboxItem } from "@/hooks/useInbox";
import { formatRelative } from "@/lib/i18n/format";
import {
  isBuildableStatus,
  COLUMN_LABELS,
  type KanbanStatus,
} from "@/lib/types/kanban";

interface ProjectGroup {
  projectId: string;
  projectName: string;
  items: InboxItem[];
}

/** Group rows by project, preserving the server order (awaiting-reply first). */
function groupByProject(items: InboxItem[]): ProjectGroup[] {
  const groups: ProjectGroup[] = [];
  const byProject = new Map<string, ProjectGroup>();
  for (const item of items) {
    let group = byProject.get(item.projectId);
    if (!group) {
      group = {
        projectId: item.projectId,
        projectName: item.projectName,
        items: [],
      };
      byProject.set(item.projectId, group);
      groups.push(group);
    }
    group.items.push(item);
  }
  return groups;
}

function statusLabel(status: string | null): string {
  if (!status) return "";
  return COLUMN_LABELS[status as KanbanStatus] ?? status;
}

function InboxRow({
  item,
  onReply,
  onMarkRead,
}: {
  item: InboxItem;
  onReply: (
    item: Pick<InboxItem, "projectId" | "epicId">,
    content: string
  ) => Promise<void>;
  onMarkRead: (epicId: string) => Promise<void>;
}) {
  const locale = useLocale();
  const [replyText, setReplyText] = useState("");
  const [busy, setBusy] = useState<"reply" | "dispatch" | "read" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const canSendToDev = isBuildableStatus(item.status);
  // A row is a REPORT unless an agent is actually held on an answer. Reports
  // are the bulk of the inbox — most of them land on tickets that are already
  // finished — so they are never framed as owing the user a reply: they carry
  // a neutral "Unread" mark and a way to file them away by reading them.
  const isPendingQuestion = item.awaitingReply;
  const canMarkRead = item.unread && !isPendingQuestion;

  async function handleReply() {
    const content = replyText.trim();
    if (!content || busy) return;
    setBusy("reply");
    setError(null);
    try {
      await onReply(item, content);
      setReplyText("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to post reply");
    } finally {
      setBusy(null);
    }
  }

  // Reading is the whole action: it moves the epic's read cursor through the
  // existing /api/inbox/read route and nothing else. No comment is posted and
  // no ticket status is touched — a finished ticket stays finished.
  async function handleMarkRead() {
    if (busy) return;
    setBusy("read");
    setError(null);
    try {
      await onMarkRead(item.epicId);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to mark as read");
    } finally {
      setBusy(null);
    }
  }

  // "Send to Dev" shortcut: a plain POST to the existing per-epic build
  // route (which already handles the comment, status sync, scheduling and
  // 409 concurrency) — no AgentActionsBar machinery needed. Any typed reply
  // rides along as the dispatch comment.
  async function handleSendToDev() {
    if (busy) return;
    setBusy("dispatch");
    setError(null);
    try {
      const comment = replyText.trim();
      const res = await fetch(
        `/api/projects/${item.projectId}/epics/${item.epicId}/build`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(comment ? { comment } : {}),
        }
      );
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.error) {
        throw new Error(body.error || "Failed to dispatch build agent");
      }
      setReplyText("");
      await onMarkRead(item.epicId);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to dispatch build agent");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div
      className="rounded-lg border border-border bg-card px-4 py-3 space-y-2"
      data-testid={`inbox-item-${item.epicId}`}
    >
      {/*
        Two lines, not one. Packed on a single row the badge, the readable id
        and the status chip are all `shrink-0`, so on a phone the title — the
        only thing that says which ticket this is — was left ~30px of the 390
        and truncated to nothing. The meta keeps its row; the title gets its
        own, at full width, on every screen.
      */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 min-w-0">
        {isPendingQuestion && (
          <span
            className="inline-flex items-center gap-1 rounded-full bg-priority-yellow/10 text-priority-yellow px-2 py-0.5 text-[11px] font-medium shrink-0"
            data-testid={`inbox-awaiting-badge-${item.epicId}`}
          >
            <MessageCircleQuestion className="h-3 w-3" />
            Awaiting reply
          </span>
        )}
        {!isPendingQuestion && item.unread && (
          <span
            className="inline-flex items-center gap-1 rounded-full bg-muted text-muted-foreground px-2 py-0.5 text-[11px] font-medium shrink-0"
            data-testid={`inbox-unread-badge-${item.epicId}`}
          >
            <Mail className="h-3 w-3" />
            Unread
          </span>
        )}
        {item.readableId && (
          <span className="text-xs font-mono text-muted-foreground shrink-0">
            {item.readableId}
          </span>
        )}
        <span className="ml-auto text-xs text-muted-foreground shrink-0">
          {statusLabel(item.status)}
        </span>
      </div>

      <Link
        href={`/projects/${item.projectId}?ticket=${item.epicId}`}
        className="block text-sm font-medium truncate hover:underline"
        data-testid={`inbox-item-link-${item.epicId}`}
      >
        {item.title}
      </Link>

      {item.latestCommentExcerpt && (
        <p className="text-sm text-muted-foreground line-clamp-2">
          {item.latestCommentExcerpt}
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        {item.latestCommentAuthor ? `${item.latestCommentAuthor} · ` : ""}
        {formatRelative(item.latestCommentCreatedAt, { locale })}
      </p>

      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <Textarea
          value={replyText}
          onChange={(e) => setReplyText(e.target.value)}
          placeholder={
            isPendingQuestion
              ? "Reply to the agent…"
              : "Comment on this ticket (optional)…"
          }
          rows={1}
          className="min-h-9 text-sm flex-1 min-w-0 resize-none"
          data-testid={`inbox-reply-input-${item.epicId}`}
        />
        <div className="flex flex-wrap items-center gap-2 sm:shrink-0">
          {canMarkRead && (
            <Button
              size="sm"
              variant="ghost"
              onClick={handleMarkRead}
              disabled={busy !== null}
              data-testid={`inbox-mark-read-${item.epicId}`}
            >
              <Check className="h-3.5 w-3.5 mr-1" />
              {busy === "read" ? "Marking…" : "Mark as read"}
            </Button>
          )}
          <Button
            size="sm"
            variant="secondary"
            onClick={handleReply}
            disabled={!replyText.trim() || busy !== null}
            data-testid={`inbox-reply-send-${item.epicId}`}
          >
            <Send className="h-3.5 w-3.5 mr-1" />
            {busy === "reply"
              ? "Sending…"
              : isPendingQuestion
                ? "Reply"
                : "Comment"}
          </Button>
          {canSendToDev && (
            <Button
              size="sm"
              onClick={handleSendToDev}
              disabled={busy !== null}
              data-testid={`inbox-send-to-dev-${item.epicId}`}
            >
              <Hammer className="h-3.5 w-3.5 mr-1" />
              {busy === "dispatch" ? "Dispatching…" : "Send to Dev"}
            </Button>
          )}
        </div>
      </div>
      {error && (
        <p
          className="text-xs text-destructive"
          data-testid={`inbox-item-error-${item.epicId}`}
        >
          {error}
        </p>
      )}
    </div>
  );
}

export default function InboxPage() {
  const { items, unreadMessageCount, awaitingReplyCount, loading, markRead, reply } =
    useInbox();

  const groups = useMemo(() => groupByProject(items), [items]);

  return (
    <div className="max-w-3xl mx-auto px-6 py-8 space-y-6" data-testid="inbox-page">
      {/*
        B-arij-DWd1DEARyLMe — this header used to read "Agents waiting on you"
        over "55 waiting", while most of those 55 rows were unread reports on
        tickets that had already been merged. The list is right; the wording
        was not. The headline count now names what it counts (unread messages)
        and the questions genuinely held on the user get their own counter,
        which is the only one that says "waiting".
      */}
      <div className="flex flex-wrap items-center gap-3">
        <Inbox className="h-6 w-6 text-muted-foreground shrink-0" />
        <div className="min-w-0">
          <h1 className="text-xl font-bold">Inbox</h1>
          <p
            className="text-sm text-muted-foreground"
            data-testid="inbox-subtitle"
          >
            Unread agent messages, across all projects. Only the questions
            flagged below need an answer.
          </p>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-x-3 gap-y-1">
          {unreadMessageCount > 0 && (
            <span
              className="text-sm text-muted-foreground"
              data-testid="inbox-count"
            >
              {unreadMessageCount} unread
            </span>
          )}
          {awaitingReplyCount > 0 && (
            <span
              className="inline-flex items-center gap-1 rounded-full bg-priority-yellow/10 text-priority-yellow px-2 py-0.5 text-sm font-medium"
              data-testid="inbox-awaiting-count"
            >
              <MessageCircleQuestion className="h-3.5 w-3.5" />
              {awaitingReplyCount} awaiting your reply
            </span>
          )}
        </div>
      </div>

      {loading ? (
        <div className="py-12 text-center text-sm text-muted-foreground">
          Loading…
        </div>
      ) : items.length === 0 ? (
        <div
          className="py-12 text-center text-sm text-muted-foreground"
          data-testid="inbox-empty"
        >
          Inbox zero — no unread agent messages.
        </div>
      ) : (
        groups.map((group) => (
          <section
            key={group.projectId}
            className="space-y-2"
            data-testid={`inbox-project-group-${group.projectId}`}
          >
            <h2 className="text-sm font-semibold text-muted-foreground">
              <Link
                href={`/projects/${group.projectId}`}
                className="hover:underline"
              >
                {group.projectName}
              </Link>{" "}
              <span className="font-normal">({group.items.length})</span>
            </h2>
            {group.items.map((item) => (
              <InboxRow
                key={item.epicId}
                item={item}
                onReply={reply}
                onMarkRead={markRead}
              />
            ))}
          </section>
        ))
      )}
    </div>
  );
}
