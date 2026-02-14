/**
 * Types representing the JSON output format from Claude Code CLI.
 *
 * When using `--output-format json --print`, Claude Code returns either
 * a single JSON object or an array of JSON objects, each with a `type`
 * field indicating the kind of content block.
 */

export interface ClaudeJsonBlock {
  type: string;
  content?: string | unknown[];
  text?: string;
  tool_use?: {
    name: string;
    input: Record<string, unknown>;
  };
  [key: string]: unknown;
}

export interface ParsedClaudeOutput {
  content: string;
  metadata?: Record<string, unknown>;
}

/**
 * Attempts to extract a CLI session ID from provider JSON output.
 *
 * Supports common field names used by CLI providers:
 * - session_id
 * - sessionId
 * - session.id
 */
export function extractCliSessionIdFromOutput(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Fast path for a plain JSON document
  const parsed = tryParseJson(trimmed);
  const fromParsed = findSessionIdInValue(parsed);
  if (fromParsed) return fromParsed;

  // Fallback: NDJSON / stream-json lines
  const lines = trimmed.split(/\r?\n/);
  for (const line of lines) {
    const candidate = line.trim();
    if (!candidate.startsWith("{") && !candidate.startsWith("[")) {
      continue;
    }
    const parsedLine = tryParseJson(candidate);
    const sessionId = findSessionIdInValue(parsedLine);
    if (sessionId) {
      return sessionId;
    }
  }

  return null;
}

/**
 * Parses the raw stdout from Claude Code CLI and extracts structured content.
 *
 * Handles the following formats:
 * - A single JSON object with a `result` or `content` field
 * - An array of JSON blocks (each with `type` and `content`/`text`)
 * - Plain text (when JSON parsing fails entirely)
 */
export function parseClaudeOutput(raw: string): ParsedClaudeOutput {
  const trimmed = raw.trim();

  if (!trimmed) {
    return { content: "" };
  }

  // Try parsing as JSON first
  const parsed = tryParseJson(trimmed);

  if (parsed === null) {
    const ndjson = tryParseLineDelimitedJson(trimmed);
    if (ndjson) {
      return ndjson;
    }

    // Not valid JSON at all -- return raw text as content
    return { content: trimmed };
  }

  // Handle array format: extract text content from all blocks
  if (Array.isArray(parsed)) {
    return parseBlockArray(parsed);
  }

  // Handle single object format
  return parseSingleObject(parsed);
}

/**
 * Extracts structured JSON data from Claude Code output.
 * Useful when the prompt requests JSON-formatted responses (e.g. import analysis).
 *
 * Looks for JSON embedded in the text content, either as the entire response
 * or within markdown code fences.
 */
export function extractJsonFromOutput<T = unknown>(
  raw: string,
): T | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Parse text content first so envelope/object-array formats are normalized.
  const parsedContent = parseClaudeOutput(trimmed).content.trim();
  const fromParsedContent = tryExtractJsonFromText<T>(parsedContent);
  if (fromParsedContent !== null) {
    return fromParsedContent;
  }

  // Fallback to raw output for cases where parseClaudeOutput cannot preserve
  // the full JSON structure (for example direct arrays of plain objects).
  if (parsedContent !== trimmed) {
    return tryExtractJsonFromText<T>(trimmed);
  }

  return null;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function tryParseJson(text: string): unknown | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function tryExtractJsonFromText<T = unknown>(value: string): T | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  // Step 1: If the output is a provider envelope, prefer its result payload.
  let contentToSearch = trimmed;
  const envelope = tryParseJson(trimmed);
  if (isRecord(envelope) && envelope.type === "result") {
    if (typeof envelope.result === "string") {
      contentToSearch = envelope.result;
    } else if (envelope.result !== undefined && envelope.result !== null) {
      const resultText = parseClaudeOutput(JSON.stringify(envelope.result)).content.trim();
      contentToSearch = resultText || JSON.stringify(envelope.result);
    }
  }

  // Step 2: Try direct parse of the content (maybe it's already JSON)
  const direct = tryParseJson(contentToSearch);
  if (
    direct !== null &&
    typeof direct === "object" &&
    !isCliResultEnvelope(direct)
  ) {
    return direct as T;
  }

  // Step 3: Try extracting from markdown code fences: ```json ... ``` or ``` ... ```
  const codeFencePattern = /```(?:json)?\s*\n?([\s\S]*?)```/g;
  let match: RegExpExecArray | null;

  while ((match = codeFencePattern.exec(contentToSearch)) !== null) {
    const candidate = match[1].trim();
    const result = tryParseJson(candidate);
    if (result !== null && typeof result === "object") {
      return result as T;
    }
  }

  // Step 4: Try finding a JSON object with a "project" key (specific to import)
  const projectJsonPattern = /(\{[\s\S]*?"project"[\s\S]*\})\s*$/;
  const projectMatch = projectJsonPattern.exec(contentToSearch);
  if (projectMatch) {
    const result = tryParseJson(projectMatch[1]);
    if (result !== null) {
      return result as T;
    }
  }

  // Step 5: Try finding any JSON object in the content
  const jsonObjectPattern = /(\{[\s\S]*\})/;
  const objectMatch = jsonObjectPattern.exec(contentToSearch);
  if (objectMatch) {
    const result = tryParseJson(objectMatch[1]);
    if (
      result !== null &&
      typeof result === "object" &&
      !isCliResultEnvelope(result)
    ) {
      return result as T;
    }
  }

  // Step 6: Try finding a JSON array in the content
  const jsonArrayPattern = /(\[[\s\S]*\])/;
  const arrayMatch = jsonArrayPattern.exec(contentToSearch);
  if (arrayMatch) {
    const result = tryParseJson(arrayMatch[1]);
    if (result !== null) {
      return result as T;
    }
  }

  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCliResultEnvelope(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  if (value.type !== "result") {
    return false;
  }
  return (
    "result" in value ||
    "subtype" in value ||
    "session_id" in value ||
    "is_error" in value
  );
}

function findSessionIdInValue(value: unknown): string | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findSessionIdInValue(item);
      if (found) return found;
    }
    return null;
  }

  if (!isRecord(value)) {
    return null;
  }

  if (typeof value.session_id === "string" && value.session_id.trim().length > 0) {
    return value.session_id.trim();
  }
  if (typeof value.sessionId === "string" && value.sessionId.trim().length > 0) {
    return value.sessionId.trim();
  }

  const session = value.session;
  if (isRecord(session) && typeof session.id === "string" && session.id.trim().length > 0) {
    return session.id.trim();
  }

  for (const nested of Object.values(value)) {
    const found = findSessionIdInValue(nested);
    if (found) return found;
  }

  return null;
}

function parseBlockArray(
  blocks: unknown[],
): ParsedClaudeOutput {
  const textParts: string[] = [];
  const metadata: Record<string, unknown> = {
    blockCount: blocks.length,
    types: [] as string[],
  };

  for (const block of blocks) {
    if (typeof block !== "object" || block === null) {
      continue;
    }

    const b = block as ClaudeJsonBlock;

    if (b.type) {
      (metadata.types as string[]).push(b.type);
    }

    // Extract text content from the block
    const text = extractTextFromBlock(b);
    if (text) {
      textParts.push(text);
    }
  }

  return {
    content: textParts.join("\n\n"),
    metadata,
  };
}

function parseSingleObject(
  obj: unknown,
): ParsedClaudeOutput {
  if (typeof obj !== "object" || obj === null) {
    return { content: String(obj) };
  }

  const record = obj as Record<string, unknown>;
  const metadata: Record<string, unknown> = {};

  // Collect known metadata fields
  if (record.type) metadata.type = record.type;
  if (record.model) metadata.model = record.model;
  if (record.usage) metadata.usage = record.usage;
  if (record.stop_reason) metadata.stopReason = record.stop_reason;

  // Extract content
  const content = extractTextFromBlock(record as ClaudeJsonBlock);

  // If this is a Claude CLI result envelope (type: "result") with no textual
  // content, produce a human-readable fallback instead of dumping raw JSON.
  if (!content && record.type === "result") {
    const subtype = record.subtype as string | undefined;
    const fallback = subtype === "success"
      ? "Agent completed successfully (no textual output)."
      : subtype === "error"
        ? `Agent finished with an error.${record.error ? ` ${record.error}` : ""}`
        : "Agent session completed without output.";
    return {
      content: fallback,
      metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    };
  }

  return {
    content: content || JSON.stringify(obj, null, 2),
    metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
  };
}

function extractTextFromBlock(block: ClaudeJsonBlock): string {
  if (typeof block.response === "string") {
    return block.response;
  }

  if (typeof block.output === "string") {
    return block.output;
  }

  if (typeof block.message === "string") {
    return block.message;
  }

  // Direct text or content fields
  if (typeof block.content === "string") {
    return block.content;
  }

  if (typeof block.text === "string") {
    return block.text;
  }

  // Result field (top-level response object)
  if (typeof block.result === "string") {
    const nestedResultText = extractTextFromJsonString(block.result);
    if (nestedResultText) {
      return nestedResultText;
    }
    return block.result;
  }

  if (isRecord(block.result)) {
    const nestedResultText = extractTextFromBlock(block.result as ClaudeJsonBlock);
    if (nestedResultText) {
      return nestedResultText;
    }
  }

  // Content array (Anthropic message format: content: [{type: "text", text: "..."}])
  if (Array.isArray(block.content)) {
    const contentArray = block.content as unknown[];
    const parts: string[] = [];
    for (let i = 0; i < contentArray.length; i++) {
      const item = contentArray[i];
      if (typeof item === "string") {
        parts.push(item);
      } else if (
        typeof item === "object" &&
        item !== null &&
        typeof (item as Record<string, unknown>).text === "string"
      ) {
        parts.push((item as Record<string, unknown>).text as string);
      } else if (isRecord(item)) {
        const nested = extractTextFromBlock(item as ClaudeJsonBlock);
        if (nested) {
          parts.push(nested);
        }
      }
    }
    if (parts.length > 0) {
      return parts.join("\n");
    }
  }

  if (Array.isArray(block.candidates)) {
    const parts: string[] = [];
    const candidates = block.candidates as Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    for (const candidate of candidates) {
      const candidateParts = candidate.content?.parts;
      if (!Array.isArray(candidateParts)) {
        continue;
      }
      for (const part of candidateParts) {
        if (typeof part.text === "string" && part.text.trim().length > 0) {
          parts.push(part.text);
        }
      }
    }
    if (parts.length > 0) {
      return parts.join("\n");
    }
  }

  return "";
}

function extractTextFromJsonString(value: string): string {
  const parsed = tryParseJson(value.trim());
  if (parsed === null) {
    return "";
  }

  if (Array.isArray(parsed)) {
    return parseBlockArray(parsed).content;
  }

  if (isRecord(parsed)) {
    return extractTextFromBlock(parsed as ClaudeJsonBlock);
  }

  return "";
}

function tryParseLineDelimitedJson(raw: string): ParsedClaudeOutput | null {
  const lines = raw.split(/\r?\n/);
  const parts: string[] = [];
  const types: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || (!trimmed.startsWith("{") && !trimmed.startsWith("["))) {
      continue;
    }

    const parsed = tryParseJson(trimmed);
    if (parsed === null) {
      continue;
    }

    if (Array.isArray(parsed)) {
      const parsedArray = parseBlockArray(parsed);
      if (parsedArray.content) {
        parts.push(parsedArray.content);
      }
      continue;
    }

    if (!isRecord(parsed)) {
      continue;
    }

    if (typeof parsed.type === "string" && parsed.type.trim().length > 0) {
      types.push(parsed.type);
    }

    const text = extractTextFromBlock(parsed as ClaudeJsonBlock);
    if (text) {
      parts.push(text);
      continue;
    }

    if (parsed.type === "result") {
      const fallback = parseSingleObject(parsed);
      if (fallback.content) {
        parts.push(fallback.content);
      }
    }
  }

  if (parts.length === 0) {
    return null;
  }

  return {
    content: parts.join("\n\n"),
    metadata: types.length > 0 ? { types } : undefined,
  };
}
