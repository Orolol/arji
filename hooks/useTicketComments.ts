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
 * Epic targets with a null epicId resolve to an empty, non-polling thread.
 */
export function useTicketComments(projectId: string, target: TicketCommentsTarget) {
  const kind = target.kind;
  const epicId = kind === "epic" ? target.epicId : null;
  const storyId = kind === "story" ? target.storyId : null;

  const commentsUrl =
    kind === "epic"
      ? epicId
        ? `/api/projects/${projectId}/epics/${epicId}/comments`
        : null
      : `/api/projects/${projectId}/stories/${storyId}/comments`;

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
