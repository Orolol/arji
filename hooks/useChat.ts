"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import type { QuestionData } from "@/lib/claude/spawn";

export interface ChatAttachment {
  id: string;
  fileName: string;
  mimeType: string;
  url: string;
}

export interface ChatMessage {
  id: string;
  projectId: string;
  role: "user" | "assistant";
  content: string;
  metadata?: string;
  attachments?: ChatAttachment[];
  createdAt: string;
}

export function useChat(projectId: string, conversationId: string | null) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [pendingQuestions, setPendingQuestions] = useState<QuestionData[] | null>(null);
  const [streamStatus, setStreamStatus] = useState<string | null>(null);

  // Track the conversation that owns the current stream so state updates
  // from a stale stream (after the user switches tabs) are ignored.
  const activeConvRef = useRef(conversationId);
  activeConvRef.current = conversationId;

  // AbortController for the in-flight fetch so we can cancel on conversation switch.
  const abortRef = useRef<AbortController | null>(null);

  // When the active conversation changes, reset transient UI state so the new
  // conversation starts with a clean slate (not blocked by the previous stream).
  useEffect(() => {
    setSending(false);
    setPendingQuestions(null);
    setStreamStatus(null);
  }, [conversationId]);

  const loadMessages = useCallback(async () => {
    if (!conversationId) {
      setMessages([]);
      return;
    }
    setLoading(true);
    try {
      const url = `/api/projects/${projectId}/chat?conversationId=${conversationId}`;
      const res = await fetch(url);
      const data = await res.json();
      setMessages(data.data || []);
    } catch {
      // ignore
    }
    setLoading(false);
  }, [projectId, conversationId]);

  useEffect(() => {
    loadMessages();
  }, [loadMessages]);

  const sendMessage = useCallback(
    async (content: string, attachmentIds?: string[], options?: { finalize?: boolean }) => {
      // Capture the conversation this send belongs to so we can guard state updates.
      const ownerConversationId = conversationId;

      // Abort any previous in-flight stream for this hook instance.
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      // Helper: only update state if this conversation is still the active one.
      // This prevents a slow-finishing stream from clobbering the new conversation.
      const isStale = () => activeConvRef.current !== ownerConversationId;

      setSending(true);
      setPendingQuestions(null);
      setStreamStatus(null);

      // Optimistically add user message + empty assistant placeholder
      const userTempId = `temp-user-${Date.now()}`;
      const assistantTempId = `temp-assistant-${Date.now()}`;

      setMessages((prev) => [
        ...prev,
        {
          id: userTempId,
          projectId,
          role: "user",
          content,
          createdAt: new Date().toISOString(),
        },
        {
          id: assistantTempId,
          projectId,
          role: "assistant",
          content: "",
          createdAt: new Date().toISOString(),
        },
      ]);

      try {
        const res = await fetch(`/api/projects/${projectId}/chat/stream`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content, conversationId: ownerConversationId, attachmentIds, finalize: options?.finalize }),
          signal: controller.signal,
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

          // If the user switched away, stop processing but let the server finish.
          if (isStale()) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const payload = line.slice(6);
            try {
              const event = JSON.parse(payload);
              if (isStale()) continue;

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
              if (event.done) {
                // Reload to sync real IDs from DB
                await loadMessages();
              }
            } catch {
              // ignore malformed event
            }
          }
        }
      } catch (err) {
        // Don't touch state if aborted due to conversation switch
        if (err instanceof DOMException && err.name === "AbortError") return;

        if (!isStale()) {
          // Remove optimistic messages on error
          setMessages((prev) =>
            prev.filter((m) => m.id !== userTempId && m.id !== assistantTempId)
          );
        }
      }
      if (!isStale()) {
        setSending(false);
        setStreamStatus(null);
      }
    },
    [projectId, conversationId, loadMessages]
  );

  const answerQuestions = useCallback(
    (formatted: string) => {
      sendMessage(formatted);
    },
    [sendMessage],
  );

  return {
    messages,
    setMessages,
    loading,
    sending,
    pendingQuestions,
    streamStatus,
    sendMessage,
    answerQuestions,
    refresh: loadMessages,
  };
}
