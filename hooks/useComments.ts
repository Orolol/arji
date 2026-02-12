"use client";

import { useState, useEffect, useCallback, useRef } from "react";

export interface TicketComment {
  id: string;
  userStoryId: string;
  author: "user" | "agent";
  content: string;
  agentSessionId: string | null;
  createdAt: string;
}

export function useComments(projectId: string, storyId: string) {
  const [comments, setComments] = useState<TicketComment[]>([]);
  const [loading, setLoading] = useState(true);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadComments = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/projects/${projectId}/stories/${storyId}/comments`
      );
      const data = await res.json();
      if (data.data) {
        setComments(data.data);
      }
    } catch {
      // silently fail on poll
    }
    setLoading(false);
  }, [projectId, storyId]);

  // Initial load + 5s polling
  useEffect(() => {
    loadComments();
    intervalRef.current = setInterval(loadComments, 5000);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [loadComments]);

  const addComment = useCallback(
    async (content: string) => {
      const res = await fetch(
        `/api/projects/${projectId}/stories/${storyId}/comments`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ author: "user", content }),
        }
      );
      const data = await res.json();
      if (data.data) {
        setComments((prev) => [...prev, data.data]);
      }
      return data.data;
    },
    [projectId, storyId]
  );

  return { comments, loading, addComment, refresh: loadComments };
}
