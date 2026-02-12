"use client";

import { useState, useCallback } from "react";

interface EpicCreateResult {
  epicId: string;
  title: string;
  userStoriesCreated: number;
}

export function useEpicCreate(projectId: string) {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdEpic, setCreatedEpic] = useState<EpicCreateResult | null>(null);

  const createEpic = useCallback(
    async (conversationId: string): Promise<string | null> => {
      setIsLoading(true);
      setError(null);
      setCreatedEpic(null);

      try {
        // Fetch conversation messages
        const messagesRes = await fetch(
          `/api/projects/${projectId}/chat?conversationId=${conversationId}`
        );
        const messagesJson = await messagesRes.json();
        const messages: Array<{ role: string; content: string }> =
          messagesJson.data || [];

        if (messages.length === 0) {
          setError("No messages found in conversation");
          setIsLoading(false);
          return null;
        }

        // Post to epic-create endpoint
        const res = await fetch(`/api/projects/${projectId}/epic-create`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            messages: messages.map((m) => ({
              role: m.role,
              content: m.content,
            })),
            conversationId,
          }),
        });

        const json = await res.json();

        if (json.error) {
          setError(json.error);
          setIsLoading(false);
          return null;
        }

        const result: EpicCreateResult = json.data;
        setCreatedEpic(result);
        setIsLoading(false);
        return result.epicId;
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Failed to create epic";
        setError(message);
        setIsLoading(false);
        return null;
      }
    },
    [projectId]
  );

  return { createEpic, isLoading, error, createdEpic };
}
