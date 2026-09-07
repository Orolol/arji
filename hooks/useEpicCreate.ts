"use client";

import { useTranslations } from "next-intl";

import { useState, useCallback } from "react";
import { parseEpicFromConversation } from "@/lib/epic-parsing";

/** How long to wait for a finalization reply to land before giving up. */
const FINALIZE_TIMEOUT_MS = 180_000;
const FINALIZE_POLL_INTERVAL_MS = 2_000;

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface EpicCreateResult {
  epicId: string;
  title: string;
  userStoriesCreated: number;
}

interface UseEpicCreateOptions {
  projectId: string;
  conversationId: string | null;
  sendMessage?: (content: string, attachmentIds?: string[], options?: { finalize?: boolean }) => Promise<void>;
  onEpicCreated?: (result: EpicCreateResult) => void;
}

export function useEpicCreate({ projectId, conversationId, sendMessage, onEpicCreated }: UseEpicCreateOptions) {
  const tErrors = useTranslations("ClientErrors");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdEpic, setCreatedEpic] = useState<EpicCreateResult | null>(null);

  const createEpic = useCallback(
    async (): Promise<string | null> => {
      setIsLoading(true);
      setError(null);
      setCreatedEpic(null);

      try {
        if (!conversationId) {
          setError(tErrors("selectAnEpicCreationConversationFirst"));
          return null;
        }

        const loadMessages = async (): Promise<Array<{
          role: string;
          content: string;
        }> | null> => {
          const res = await fetch(
            `/api/projects/${projectId}/chat?conversationId=${conversationId}`
          );
          if (!res.ok) return null;
          const json = await res.json();
          return json.data || [];
        };

        const countAssistant = (list: Array<{ role: string }>) =>
          list.filter((message) => message.role === "assistant").length;

        const initialMessages = await loadMessages();
        if (!initialMessages) {
          setError(tErrors("unableToLoadTheConversationTryAgain"));
          return null;
        }
        let messages = initialMessages;

        if (messages.length === 0) {
          setError(tErrors("noMessagesFoundInThisConversationYet"));
          return null;
        }

        // First, try to extract an epic from existing messages without sending
        // additional finalization prompts. This handles the common case where the
        // AI has already responded with valid JSON during the conversation.
        let parsedEpic = parseEpicFromConversation(messages);

        // If no epic found in existing messages, try up to 2 finalization attempts.
        if (!parsedEpic && sendMessage) {
          const MAX_ATTEMPTS = 2;
          for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
            const prompt =
              attempt === 0
                ? "Generate the final epic with user stories based on our discussion."
                : 'Output ONLY the JSON code block for the epic. Start your response with ```json and end with ```. No other text.';
            const assistantCountBefore = countAssistant(messages);
            await sendMessage(prompt, [], { finalize: true });

            // `sendMessage` can resolve before the reply is persisted (aborted
            // stream, conversation switched while generating). Poll until a new
            // assistant message actually lands instead of parsing stale rows and
            // reporting a failure the user then sees contradicted on screen.
            const deadline = Date.now() + FINALIZE_TIMEOUT_MS;
            while (true) {
              const updated = await loadMessages();
              if (updated && updated.length > 0) {
                messages = updated;
              }

              parsedEpic = parseEpicFromConversation(messages);
              if (parsedEpic) break;
              // A reply landed but it is not parseable — let the next attempt
              // ask again rather than waiting out the timeout.
              if (countAssistant(messages) > assistantCountBefore) break;
              if (Date.now() >= deadline) break;

              await delay(FINALIZE_POLL_INTERVAL_MS);
            }

            if (parsedEpic) break;
          }
        }

        if (parsedEpic) {
          const res = await fetch(`/api/projects/${projectId}/epics`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              title: parsedEpic.title,
              description: parsedEpic.description,
              status: "backlog",
              userStories: parsedEpic.userStories,
            }),
          });

          const json = await res.json();

          if (!res.ok || json.error) {
            setError(json.error || tErrors("failedToCreateEpic"));
            return null;
          }

          const result: EpicCreateResult = {
            epicId: json.data?.id || json.data?.epicId,
            title: json.data?.title || parsedEpic.title,
            userStoriesCreated:
              typeof json.data?.userStoriesCreated === "number"
                ? json.data.userStoriesCreated
                : parsedEpic.userStories.length,
          };

          if (!result.epicId) {
            setError(tErrors("epicWasCreatedButNoEpicIDWasReturned"));
            return null;
          }

          setCreatedEpic(result);
          onEpicCreated?.(result);
          return result.epicId;
        }

        setError(
          tErrors("iCouldntExtractAFullEpicYetAskClaudeToProvideAnEpicTitleAndUserStoriesFirst"),
        );
        return null;
      } catch (err) {
        const message =
          err instanceof Error ? err.message : tErrors("failedToCreateEpic");
        setError(message);
        return null;
      } finally {
        setIsLoading(false);
      }
    },
    [projectId, conversationId, sendMessage, onEpicCreated, tErrors]
  );

  return { createEpic, isLoading, error, createdEpic };
}
