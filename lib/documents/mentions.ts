import path from "path";
import { listProjectDocuments, type ProjectDocumentRecord } from "@/lib/documents/query";

const SIMPLE_FILENAME_MENTION = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

// Supports @filename and @{filename with spaces.ext}
const MENTION_PATTERN = /(^|\s)@(?:\{([^}\n]+)\}|([A-Za-z0-9][A-Za-z0-9._-]*))/g;

export class MentionResolutionError extends Error {
  readonly missingFilenames: string[];

  constructor(missingFilenames: string[]) {
    super(
      `Unknown document mention(s): ${missingFilenames
        .map((name) => formatDocumentMention(name))
        .join(", ")}. Upload these files in Docs or remove the mentions.`
    );
    this.name = "MentionResolutionError";
    this.missingFilenames = missingFilenames;
  }
}

export function formatDocumentMention(originalFilename: string): string {
  if (SIMPLE_FILENAME_MENTION.test(originalFilename)) {
    return `@${originalFilename}`;
  }
  return `@{${originalFilename}}`;
}

export function parseDocumentMentions(content: string): string[] {
  const unique = new Set<string>();

  for (const match of content.matchAll(MENTION_PATTERN)) {
    const raw = (match[2] || match[3] || "").trim();
    if (!raw) continue;
    const key = raw.toLowerCase();
    if (!unique.has(key)) {
      unique.add(key);
    }
  }

  return Array.from(unique);
}

export function collectMentionedFilenames(textSources: Array<string | null | undefined>): string[] {
  const combined = new Set<string>();

  for (const source of textSources) {
    if (!source) continue;
    const mentions = parseDocumentMentions(source);
    for (const mention of mentions) {
      combined.add(mention);
    }
  }

  return Array.from(combined);
}

export function resolveMentionedDocuments(
  docs: ProjectDocumentRecord[],
  mentionedFilenames: string[]
): {
  resolved: ProjectDocumentRecord[];
  missing: string[];
} {
  const docsByFilename = new Map<string, ProjectDocumentRecord>();
  for (const doc of docs) {
    docsByFilename.set(doc.originalFilename.toLowerCase(), doc);
  }

  const resolved: ProjectDocumentRecord[] = [];
  const missing: string[] = [];

  for (const filename of mentionedFilenames) {
    const doc = docsByFilename.get(filename.toLowerCase());
    if (!doc) {
      missing.push(filename);
      continue;
    }
    resolved.push(doc);
  }

  return { resolved, missing };
}

export function buildMentionContextBlock(documents: ProjectDocumentRecord[]): string {
  if (documents.length === 0) return "";

  const parts = documents.map((doc) => {
    const mentionToken = formatDocumentMention(doc.originalFilename);

    if (doc.kind === "text") {
      return [
        `### ${mentionToken}`,
        doc.markdownContent?.trim() || "",
      ].join("\n\n");
    }

    const absolutePath = doc.imagePath
      ? path.join(process.cwd(), doc.imagePath)
      : "(missing image path)";

    return `- ${mentionToken} references an image available at filesystem path: ${absolutePath}`;
  });

  return [
    "## Mentioned Project Documents",
    "",
    ...parts,
    "",
  ].join("\n");
}

export function enrichPromptWithResolvedMentions(
  prompt: string,
  resolvedDocuments: ProjectDocumentRecord[]
): string {
  if (resolvedDocuments.length === 0) return prompt;

  const mentionContext = buildMentionContextBlock(resolvedDocuments);
  return `${prompt.trim()}\n\n${mentionContext}`;
}

export function enrichPromptWithDocumentMentions(params: {
  projectId: string;
  prompt: string;
  textSources: Array<string | null | undefined>;
}): {
  prompt: string;
  mentions: string[];
  resolvedDocuments: ProjectDocumentRecord[];
} {
  const mentions = collectMentionedFilenames(params.textSources);
  if (mentions.length === 0) {
    return {
      prompt: params.prompt,
      mentions,
      resolvedDocuments: [],
    };
  }

  const projectDocs = listProjectDocuments(params.projectId);
  const { resolved, missing } = resolveMentionedDocuments(projectDocs, mentions);

  if (missing.length > 0) {
    throw new MentionResolutionError(missing);
  }

  return {
    prompt: enrichPromptWithResolvedMentions(params.prompt, resolved),
    mentions,
    resolvedDocuments: resolved,
  };
}

export function validateMentionsExist(params: {
  projectId: string;
  textSources: Array<string | null | undefined>;
}): { mentions: string[] } {
  const mentions = collectMentionedFilenames(params.textSources);
  if (mentions.length === 0) {
    return { mentions };
  }

  const projectDocs = listProjectDocuments(params.projectId);
  const { missing } = resolveMentionedDocuments(projectDocs, mentions);

  if (missing.length > 0) {
    throw new MentionResolutionError(missing);
  }

  return { mentions };
}
