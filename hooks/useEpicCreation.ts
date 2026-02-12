"use client";

import { useState, useCallback, useEffect } from "react";
import type { QuestionData } from "@/lib/claude/spawn";

export interface EpicChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
}

export type EpicCreationStatus = "idle" | "generating" | "generated" | "error";

export function useEpicCreation(projectId: string, conversationId?: string | null) {
  const [messages, setMessages] = useState<EpicChatMessage[]>([]);
  const [sending, setSending] = useState(false);
  const [creating, setCreating] = useState(false);
  const [epicCreationStatus, setEpicCreationStatus] = useState<EpicCreationStatus>("idle");
  const [pendingQuestions, setPendingQuestions] = useState<QuestionData[] | null>(null);
  const [streamStatus, setStreamStatus] = useState<string | null>(null);

  // Load existing messages from DB when conversationId is set
  useEffect(() => {
    if (!conversationId) return;
    (async () => {
      try {
        const res = await fetch(
          `/api/projects/${projectId}/chat?conversationId=${conversationId}`
        );
        const json = await res.json();
        const data = json.data || [];
        if (data.length > 0) {
          setMessages(
            data.map((m: { id: string; role: string; content: string }) => ({
              id: m.id,
              role: m.role as "user" | "assistant",
              content: m.content,
            }))
          );
        }
      } catch {
        // ignore
      }
    })();
  }, [projectId, conversationId]);

  const sendMessage = useCallback(
    async (content: string) => {
      // Clear pending questions and status when user sends a message
      setPendingQuestions(null);
      setStreamStatus(null);

      const userMsg: EpicChatMessage = {
        id: `u-${Date.now()}`,
        role: "user",
        content,
      };

      const updatedMessages = [...messages, userMsg];
      setMessages(updatedMessages);
      setSending(true);

      // Add empty assistant placeholder for streaming
      const assistantTempId = `a-stream-${Date.now()}`;
      setMessages((prev) => [
        ...prev,
        { id: assistantTempId, role: "assistant", content: "" },
      ]);

      try {
        const res = await fetch(`/api/projects/${projectId}/epic-chat/stream`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            messages: updatedMessages.map((m) => ({
              role: m.role,
              content: m.content,
            })),
            conversationId: conversationId || undefined,
          }),
        });

        if (!res.ok || !res.body) {
          throw new Error("Stream request failed");
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const payload = line.slice(6);
            try {
              const event = JSON.parse(payload);
              if (event.status) {
                setStreamStatus(event.status);
              }
              if (event.delta) {
                setStreamStatus(null);
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === assistantTempId
                      ? { ...m, content: m.content + event.delta }
                      : m
                  )
                );
              }
              if (event.questions) {
                setPendingQuestions(event.questions);
                // Allow user to interact with question cards
                setSending(false);
                setStreamStatus(null);
              }
              if (event.done && event.content) {
                // Replace placeholder with final content
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === assistantTempId
                      ? { ...m, id: event.messageId || assistantTempId, content: event.content }
                      : m
                  )
                );
              }
            } catch {
              // ignore
            }
          }
        }
      } catch {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantTempId
              ? { ...m, content: "Error: Failed to reach the server." }
              : m
          )
        );
      }

      setSending(false);
      setStreamStatus(null);
    },
    [messages, projectId, conversationId],
  );

  const answerQuestions = useCallback(
    (formatted: string) => {
      sendMessage(formatted);
    },
    [sendMessage],
  );

  const createEpic = useCallback(async (): Promise<string | null> => {
    setCreating(true);
    setEpicCreationStatus("generating");

    try {
      const res = await fetch(`/api/projects/${projectId}/epic-create`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: messages.map((m) => ({
            role: m.role,
            content: m.content,
          })),
          conversationId: conversationId || undefined,
        }),
      });

      const json = await res.json();

      if (json.error) {
        setMessages((prev) => [
          ...prev,
          {
            id: `a-${Date.now()}`,
            role: "assistant",
            content: `Error creating epic: ${json.error}`,
          },
        ]);
        setCreating(false);
        setEpicCreationStatus("error");
        return null;
      }

      setCreating(false);
      setEpicCreationStatus("generated");
      return json.data.epicId as string;
    } catch {
      setMessages((prev) => [
        ...prev,
        {
          id: `a-${Date.now()}`,
          role: "assistant",
          content: "Error: Failed to create epic.",
        },
      ]);
      setCreating(false);
      setEpicCreationStatus("error");
      return null;
    }
  }, [messages, projectId, conversationId]);

  const reset = useCallback(() => {
    setMessages([]);
    setSending(false);
    setCreating(false);
    setEpicCreationStatus("idle");
    setPendingQuestions(null);
    setStreamStatus(null);
  }, []);

  return {
    messages,
    sending,
    creating,
    epicCreationStatus,
    pendingQuestions,
    streamStatus,
    sendMessage,
    answerQuestions,
    createEpic,
    reset,
  };
}
