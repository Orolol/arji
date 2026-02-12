"use client";

import { useState, useCallback } from "react";

interface EpicCreateResult {
  epicId: string;
  title: string;
  userStoriesCreated: number;
}

interface ConversationMessage {
  role: string;
  content: string;
}

interface ParsedUserStory {
  title: string;
  description: string | null;
  acceptanceCriteria: string | null;
}

interface ParsedEpic {
  title: string;
  description: string;
  userStories: ParsedUserStory[];
}

interface UseEpicCreateOptions {
  projectId: string;
  conversationId: string | null;
  onEpicCreated?: (result: EpicCreateResult) => void;
}

function cleanLine(input: string): string {
  return input.replace(/\*\*/g, "").replace(/^["'`]+|["'`]+$/g, "").trim();
}

function extractJsonCandidates(content: string): string[] {
  const candidates: string[] = [];
  const fenceRegex = /```(?:json)?\s*([\s\S]*?)```/gi;

  for (const match of content.matchAll(fenceRegex)) {
    if (match[1]) {
      candidates.push(match[1].trim());
    }
  }

  const trimmed = content.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    candidates.push(trimmed);
  }

  return candidates;
}

function normalizeChecklist(items: string[]): string | null {
  if (items.length === 0) return null;
  return items.map((item) => `- [ ] ${item}`).join("\n");
}

function toParsedEpicFromJson(raw: unknown): ParsedEpic | null {
  if (!raw || typeof raw !== "object") return null;

  const input = raw as {
    title?: unknown;
    description?: unknown;
    userStories?: unknown;
    user_stories?: unknown;
  };

  if (typeof input.title !== "string" || input.title.trim().length === 0) {
    return null;
  }

  const storiesRaw = Array.isArray(input.userStories)
    ? input.userStories
    : Array.isArray(input.user_stories)
      ? input.user_stories
      : [];

  const userStories: ParsedUserStory[] = storiesRaw
    .map((story) => {
      if (!story || typeof story !== "object") return null;
      const storyInput = story as {
        title?: unknown;
        description?: unknown;
        acceptanceCriteria?: unknown;
        acceptance_criteria?: unknown;
      };

      if (typeof storyInput.title !== "string" || storyInput.title.trim().length === 0) {
        return null;
      }

      const acceptance =
        typeof storyInput.acceptanceCriteria === "string"
          ? storyInput.acceptanceCriteria
          : typeof storyInput.acceptance_criteria === "string"
            ? storyInput.acceptance_criteria
            : null;

      return {
        title: cleanLine(storyInput.title),
        description:
          typeof storyInput.description === "string" && storyInput.description.trim().length > 0
            ? cleanLine(storyInput.description)
            : null,
        acceptanceCriteria: acceptance ? cleanLine(acceptance) : null,
      };
    })
    .filter((story): story is ParsedUserStory => Boolean(story));

  if (userStories.length === 0) {
    return null;
  }

  return {
    title: cleanLine(input.title),
    description:
      typeof input.description === "string" && input.description.trim().length > 0
        ? cleanLine(input.description)
        : "Epic generated from conversation",
    userStories,
  };
}

function parseEpicFromJson(messages: ConversationMessage[]): ParsedEpic | null {
  const assistantContents = messages
    .filter((message) => message.role === "assistant")
    .map((message) => message.content)
    .filter((content) => content.trim().length > 0)
    .reverse();

  for (const content of assistantContents) {
    const candidates = extractJsonCandidates(content);
    for (const candidate of candidates) {
      try {
        const parsed = JSON.parse(candidate);
        const epic = toParsedEpicFromJson(parsed);
        if (epic) return epic;
      } catch {
        // Ignore malformed JSON candidates.
      }
    }
  }

  return null;
}

function extractEpicTitle(text: string): string | null {
  const explicitPatterns = [
    /(?:^|\n)\s*Epic\s+Title\s*:\s*(.+)/i,
    /(?:^|\n)\s*Title\s*:\s*(.+)/i,
    /(?:^|\n)\s*Epic\s*:\s*(.+)/i,
  ];

  for (const pattern of explicitPatterns) {
    const match = text.match(pattern);
    if (match?.[1]) return cleanLine(match[1]);
  }

  const heading = text.match(/(?:^|\n)\s*#+\s+(.+)/);
  if (heading?.[1]) {
    return cleanLine(heading[1]);
  }

  return null;
}

function extractEpicDescription(text: string): string | null {
  const explicitDescription = text.match(
    /(?:^|\n)\s*(?:Epic\s+Description|Description)\s*:\s*([\s\S]*?)(?:\n\s*(?:User\s+Stories|Stories)\b|$)/i,
  );
  if (explicitDescription?.[1]) {
    const normalized = cleanLine(explicitDescription[1]);
    if (normalized.length > 0) return normalized;
  }

  const paragraphs = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(
      (line) =>
        line.length > 0 &&
        !line.startsWith("#") &&
        !/^[-*]\s/.test(line) &&
        !/^\d+\.\s/.test(line) &&
        !/^As a[n]? /i.test(line) &&
        !/^acceptance criteria/i.test(line) &&
        !/^criteria/i.test(line) &&
        !/^Epic\s*:/i.test(line) &&
        !/^Title\s*:/i.test(line),
    );

  if (paragraphs.length === 0) return null;
  return cleanLine(paragraphs.slice(0, 2).join(" "));
}

function extractStoriesFromText(text: string): ParsedUserStory[] {
  const lines = text.split(/\r?\n/);
  const parsed: Array<{
    title: string;
    descriptionParts: string[];
    criteria: string[];
  }> = [];

  let current: {
    title: string;
    descriptionParts: string[];
    criteria: string[];
  } | null = null;
  let collectingCriteria = false;

  function commitCurrent() {
    if (!current) return;
    parsed.push(current);
    current = null;
    collectingCriteria = false;
  }

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    const storyMatch =
      line.match(/^(?:[-*]|\d+\.)\s*(As a[n]? .+)/i) || line.match(/^(As a[n]? .+)/i);
    if (storyMatch?.[1]) {
      commitCurrent();
      current = {
        title: cleanLine(storyMatch[1]),
        descriptionParts: [],
        criteria: [],
      };
      continue;
    }

    if (!current) continue;

    if (/^acceptance criteria[:]?$/i.test(line) || /^criteria[:]?$/i.test(line)) {
      collectingCriteria = true;
      continue;
    }

    const checklistMatch = line.match(/^[-*]\s+\[[xX ]\]\s+(.+)$/) || line.match(/^[-*]\s+(.+)$/);
    if (collectingCriteria && checklistMatch?.[1]) {
      current.criteria.push(cleanLine(checklistMatch[1]));
      continue;
    }

    if (!collectingCriteria && !line.startsWith("#")) {
      current.descriptionParts.push(cleanLine(line));
    }
  }

  commitCurrent();

  const byTitle = new Map<string, ParsedUserStory>();
  for (const story of parsed) {
    const title = cleanLine(story.title);
    if (!title) continue;
    if (byTitle.has(title)) continue;

    byTitle.set(title, {
      title,
      description: story.descriptionParts.length > 0 ? story.descriptionParts.join(" ") : null,
      acceptanceCriteria: normalizeChecklist(story.criteria),
    });
  }

  return Array.from(byTitle.values());
}

function parseEpicFromConversation(messages: ConversationMessage[]): ParsedEpic | null {
  const fromJson = parseEpicFromJson(messages);
  if (fromJson) return fromJson;

  const assistantText = messages
    .filter((message) => message.role === "assistant")
    .map((message) => message.content.trim())
    .filter((content) => content.length > 0)
    .join("\n\n");
  const userText = messages
    .filter((message) => message.role === "user")
    .map((message) => message.content.trim())
    .filter((content) => content.length > 0)
    .join("\n\n");

  const title = extractEpicTitle(assistantText) || extractEpicTitle(userText);
  const description = extractEpicDescription(assistantText) || extractEpicDescription(userText);
  const userStories = extractStoriesFromText(assistantText);

  if (!title || userStories.length === 0) {
    return null;
  }

  return {
    title,
    description: description || "Epic generated from conversation",
    userStories,
  };
}

export function useEpicCreate({ projectId, conversationId, onEpicCreated }: UseEpicCreateOptions) {
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
          setError("Select an epic creation conversation first.");
          return null;
        }

        const messagesRes = await fetch(
          `/api/projects/${projectId}/chat?conversationId=${conversationId}`
        );
        if (!messagesRes.ok) {
          setError("Unable to load the conversation. Try again.");
          return null;
        }
        const messagesJson = await messagesRes.json();
        const messages: Array<{ role: string; content: string }> =
          messagesJson.data || [];

        if (messages.length === 0) {
          setError("No messages found in this conversation yet.");
          return null;
        }

        const parsedEpic = parseEpicFromConversation(messages);
        if (!parsedEpic) {
          setError(
            "I couldn't extract a full epic yet. Ask Claude to provide an epic title and user stories first.",
          );
          return null;
        }

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
          setError(json.error || "Failed to create epic");
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
          setError("Epic was created but no epic ID was returned.");
          return null;
        }

        setCreatedEpic(result);
        onEpicCreated?.(result);
        return result.epicId;
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Failed to create epic";
        setError(message);
        return null;
      } finally {
        setIsLoading(false);
      }
    },
    [projectId, conversationId, onEpicCreated]
  );

  return { createEpic, isLoading, error, createdEpic };
}
