"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import type { TicketComment } from "./useComments";

export function useEpicComments(projectId: string, epicId: string | null) {
  const [comments, setComments] = useState<TicketComment[]>([]);
  const [loading, setLoading] = useState(true);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadComments = useCallback(async () => {
    if (!epicId) return;
    try {
      const res = await fetch(
        `/api/projects/${projectId}/epics/${epicId}/comments`
      );
      const data = await res.json();
      if (data.data) {
        setComments(data.data);
      }
    } catch {
      // silently fail on poll
    }
    setLoading(false);
  }, [projectId, epicId]);

  useEffect(() => {
    if (!epicId) {
      setComments([]);
      setLoading(false);
      return;
    }
    loadComments();
    intervalRef.current = setInterval(loadComments, 5000);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [loadComments, epicId]);

  const addComment = useCallback(
    async (content: string) => {
      if (!epicId) return;
      const res = await fetch(
        `/api/projects/${projectId}/epics/${epicId}/comments`,
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
    [projectId, epicId]
  );

  return { comments, loading, addComment, refresh: loadComments };
}
