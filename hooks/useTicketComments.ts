"use client";

import { useState, useCallback } from "react";
import { usePolling } from "@/hooks/usePolling";

export interface TicketComment {
  id: string;
  userStoryId?: string | null;
  epicId?: string | null;
  author: "user" | "agent";
  content: string;
  agentSessionId: string | null;
  createdAt: string;
}

const EMPTY_COMMENTS: TicketComment[] = [];

export type TicketCommentsTarget =
  | { kind: "epic"; epicId: string | null }
  | { kind: "story"; storyId: string };

/**
 * Loads and polls (5s) the comment thread of an epic or story.
 * Epic targets with a null epicId — and any target on an unresolved project —
 * resolve to an empty, non-polling thread.
 */
export function useTicketComments(
  projectId: string | null | undefined,
  target: TicketCommentsTarget,
) {
  const kind = target.kind;
  const epicId = kind === "epic" ? target.epicId : null;
  const storyId = kind === "story" ? target.storyId : null;

  // An unresolved project is not an id: `/api/projects//stories/s1/comments`
  // collapses to `/api/projects/stories/s1/comments`, a route nothing serves.
  // The epic branch below guards `epicId`, which says nothing about the
  // project, so the project needs its own guard — before the request, and on
  // both branches, since this thread polls every 5 seconds.
  const resolvedProjectId = projectId?.trim() ? projectId.trim() : null;

  const commentsUrl = !resolvedProjectId
    ? null
    : kind === "epic"
      ? epicId
        ? `/api/projects/${resolvedProjectId}/epics/${epicId}/comments`
        : null
      : `/api/projects/${resolvedProjectId}/stories/${storyId}/comments`;

  const [loadedComments, setComments] = useState<TicketComment[]>([]);
  const [isLoading, setLoading] = useState(true);

  // A target with no URL has an empty, settled thread. Deriving that beats the
  // reset effect it replaces: the value is right on the first render instead of
  // one commit later, and returning to a target still shows its cached thread.
  const comments = commentsUrl ? loadedComments : EMPTY_COMMENTS;
  const loading = commentsUrl ? isLoading : false;

  const loadComments = useCallback(async () => {
    if (!commentsUrl) return;
    try {
      const res = await fetch(commentsUrl);
      const data = await res.json();
      if (data.data) {
        setComments(data.data);
      }
    } catch {
      // silently fail on poll
    }
    setLoading(false);
  }, [commentsUrl]);

  // Initial load + 5s polling
  usePolling(loadComments, 5000, !!commentsUrl);

  const addComment = useCallback(
    async (content: string) => {
      if (!commentsUrl) return;
      const res = await fetch(commentsUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ author: "user", content }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error) {
        throw new Error(data.error || "Failed to add comment");
      }
      if (data.data) {
        setComments((prev) => [...prev, data.data]);
      }
      return data.data;
    },
    [commentsUrl]
  );

  return { comments, loading, addComment, refresh: loadComments };
}
