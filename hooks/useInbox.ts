"use client";

import { useTranslations } from "next-intl";

import { useState, useCallback } from "react";
import { usePolling } from "@/hooks/usePolling";

/** Row shape returned by GET /api/inbox (see app/api/inbox/route.ts). */
export interface InboxItem {
  epicId: string;
  projectId: string;
  projectName: string;
  readableId: string | null;
  title: string;
  status: string | null;
  type: string | null;
  awaitingReply: boolean;
  unread: boolean;
  latestCommentAuthor: string | null;
  latestCommentExcerpt: string | null;
  latestCommentCreatedAt: string | null;
  lastReadAt: string | null;
}

interface InboxState {
  items: InboxItem[];
  /** Every row in the inbox — the rule the bar badge counts. */
  unreadCount: number;
  /** Rows whose latest agent message has not been read yet. */
  unreadMessageCount: number;
  /** Rows holding a question the user has genuinely not answered. */
  awaitingReplyCount: number;
  loading: boolean;
}

const POLL_INTERVAL_MS = 5000;

/**
 * Cross-project inbox of unread agent messages: reports on tickets that may
 * well be finished, plus the questions an agent is genuinely held on. Polls
 * /api/inbox (house pattern, same cadence as useNotifications).
 *
 * The three counters are the route's (see app/api/inbox/route.ts): the row
 * count the bar badge has always shown, and the two category counters the
 * inbox page prints so a pile of unread reports is not read as a pile of
 * blocked agents.
 */
export function useInbox() {
  const tErrors = useTranslations("ClientErrors");
  const [state, setState] = useState<InboxState>({
    items: [],
    unreadCount: 0,
    unreadMessageCount: 0,
    awaitingReplyCount: 0,
    loading: true,
  });

  const fetchInbox = useCallback(async () => {
    try {
      const res = await fetch("/api/inbox");
      if (!res.ok) return;
      const body = await res.json();
      setState({
        items: body.data?.items || [],
        unreadCount: body.data?.unreadCount ?? 0,
        unreadMessageCount: body.data?.unreadMessageCount ?? 0,
        awaitingReplyCount: body.data?.awaitingReplyCount ?? 0,
        loading: false,
      });
    } catch {
      // Silently ignore — polling will retry
    }
  }, []);

  usePolling(fetchInbox, POLL_INTERVAL_MS);

  /** Move the epic's read cursor to now, then re-fetch the inbox. */
  const markRead = useCallback(
    async (epicId: string) => {
      try {
        await fetch("/api/inbox/read", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ epicId }),
        });
      } catch {
        // Best-effort — the item just stays until the next successful mark.
      }
      await fetchInbox();
    },
    [fetchInbox]
  );

  /**
   * Post a user reply on the ticket (existing per-epic comments route) and
   * mark it read. Throws on failure so the caller can surface the error.
   */
  const reply = useCallback(
    async (item: Pick<InboxItem, "projectId" | "epicId">, content: string) => {
      const res = await fetch(
        `/api/projects/${item.projectId}/epics/${item.epicId}/comments`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ author: "user", content }),
        }
      );
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.error) {
        throw new Error(body.error || tErrors("failedToPostReply"));
      }
      await markRead(item.epicId);
    },
    [markRead, tErrors]
  );

  return {
    items: state.items,
    unreadCount: state.unreadCount,
    unreadMessageCount: state.unreadMessageCount,
    awaitingReplyCount: state.awaitingReplyCount,
    loading: state.loading,
    markRead,
    reply,
    refresh: fetchInbox,
  };
}
