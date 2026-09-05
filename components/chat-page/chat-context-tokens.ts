"use client";

import { useEffect, useMemo, useState } from "react";

import { estimateTokens } from "@/lib/tokens/estimator";

/**
 * The CONTEXTE rail's figures — "what this chat will send, in tokens".
 *
 * THERE IS NO ENDPOINT FOR THIS and this packet does not add one. The numbers
 * are derived on the client from the three reads the rail's own rows name:
 * the project's spec, the project's learned memory, and the documents the
 * conversation actually cites with `@`.
 *
 * `estimateTokens` is the SAME chars/4 estimator the real dispatch breakdown
 * uses (`lib/tokens/estimator.ts`), so these figures agree with frame 8b's
 * ANATOMIE DU PROMPT rather than offering a second, quieter answer. Its only
 * import is a type, so it is safe in a client bundle.
 *
 * DATA-GAP RULE: a value that does not exist is `null` and renders as an
 * em-dash. Never `0 tok` — an empty spec and a failed read are both "we do not
 * have this", and a zero would claim we measured one.
 */

export interface ChatContextDocument {
  id: string;
  originalFilename: string;
  markdownContent: string | null;
}

export interface ChatContextTokens {
  /** Tokens of the project spec, or null when absent / unreadable. */
  spec: number | null;
  /** Tokens of the learned memory, or null when absent / unreadable. */
  memory: number | null;
  /** One row per document the conversation cites with `@`. */
  citedDocs: { id: string; originalFilename: string; tokens: number | null }[];
}

/**
 * `k`-suffixed token count, one decimal — the frame's `3.1k` / `1.1k` / `0.8k`.
 *
 * `null` (and only `null`) is the em-dash. A document that exists but is empty
 * still has no measurable content, so it is `null` too, upstream of here.
 */
export function formatTokens(tokens: number | null): string {
  if (tokens === null || !Number.isFinite(tokens) || tokens <= 0) return "—";
  return `${(tokens / 1000).toFixed(1)}k`;
}

/** `estimateTokens`, but empty content is a data gap rather than a zero. */
export function tokensOf(content: string | null | undefined): number | null {
  if (!content || !content.trim()) return null;
  const estimated = estimateTokens(content);
  return estimated > 0 ? estimated : null;
}

/**
 * Every `@doc` reference in a body of text.
 *
 * Mirrors the two shapes `formatDocumentMention` writes — `@name` for a simple
 * filename, `@{name}` for anything else — and the two `MentionTextarea` detects
 * while typing. `enrichPromptWithDocumentMentions` is the server's answer to the
 * same question and cannot be imported here.
 */
const MENTION_PATTERN = /(?:^|\s)@(?:\{([^}\n]*)\}|([A-Za-z0-9][A-Za-z0-9._-]*))/g;

export function mentionedNames(text: string): string[] {
  const names: string[] = [];
  for (const match of text.matchAll(MENTION_PATTERN)) {
    const name = (match[1] ?? match[2] ?? "").trim();
    if (name) names.push(name.toLowerCase());
  }
  return names;
}

/**
 * The documents a conversation cites, in the order the project lists them.
 *
 * Only USER messages are scanned: an assistant quoting `@spec.md` back at you
 * did not add it to the prompt, and counting it would inflate the rail.
 */
export function citedDocuments(
  messages: readonly { role: string; content: string }[],
  documents: readonly ChatContextDocument[],
): ChatContextDocument[] {
  const cited = new Set<string>();
  for (const message of messages) {
    if (message.role !== "user" || !message.content) continue;
    for (const name of mentionedNames(message.content)) cited.add(name);
  }
  if (cited.size === 0) return [];
  return documents.filter((doc) =>
    cited.has(doc.originalFilename.toLowerCase()),
  );
}

/**
 * Reads the three sources once per project.
 *
 * NOT POLLED, deliberately. `better-sqlite3` is synchronous on one shared
 * connection, so every extra periodic read on this page stalls SSE for the
 * whole app; the spec and the memory change on a human's timescale, and the
 * document list changes when someone uploads one. A refresh costs a page load,
 * which is the honest trade for not adding three more polls per open tab.
 */
export function useChatContextTokens(
  projectId: string | null,
  messages: readonly { role: string; content: string }[],
): ChatContextTokens {
  const [spec, setSpec] = useState<string | null>(null);
  const [memory, setMemory] = useState<string | null>(null);
  const [documents, setDocuments] = useState<ChatContextDocument[]>([]);
  const [loadedProjectId, setLoadedProjectId] = useState<string | null>(null);

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;

    async function readJson(url: string): Promise<unknown> {
      try {
        const res = await fetch(url);
        if (!res.ok) return null;
        return await res.json();
      } catch {
        return null;
      }
    }

    void (async () => {
      const [project, memoryDoc, docs] = await Promise.all([
        readJson(`/api/projects/${projectId}`),
        readJson(`/api/projects/${projectId}/memory`),
        readJson(`/api/projects/${projectId}/documents`),
      ]);
      if (cancelled) return;
      setLoadedProjectId(projectId);

      const projectSpec = (project as { data?: { spec?: string | null } } | null)
        ?.data?.spec;
      setSpec(typeof projectSpec === "string" ? projectSpec : null);

      const memoryContent = (
        memoryDoc as { data?: { content?: string | null } } | null
      )?.data?.content;
      setMemory(typeof memoryContent === "string" ? memoryContent : null);

      const rows = (docs as { data?: unknown } | null)?.data;
      setDocuments(
        Array.isArray(rows)
          ? rows
              .map((row) => row as Record<string, unknown>)
              .filter(
                (row) =>
                  typeof row.id === "string" &&
                  typeof row.originalFilename === "string" &&
                  row.originalFilename.length > 0,
              )
              .map((row) => ({
                id: row.id as string,
                originalFilename: row.originalFilename as string,
                markdownContent:
                  typeof row.markdownContent === "string"
                    ? row.markdownContent
                    : null,
              }))
          : [],
      );
    })();

    return () => {
      cancelled = true;
    };
  }, [projectId]);

  return useMemo(
    () => ({
      spec: tokensOf(projectId === loadedProjectId ? spec : null),
      memory: tokensOf(projectId === loadedProjectId ? memory : null),
      citedDocs: citedDocuments(messages, projectId === loadedProjectId ? documents : []).map((doc) => ({
        id: doc.id,
        originalFilename: doc.originalFilename,
        tokens: tokensOf(doc.markdownContent),
      })),
    }),
    [spec, memory, documents, messages, projectId, loadedProjectId],
  );
}
