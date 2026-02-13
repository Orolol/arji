/**
 * Extracts the last non-empty text from session output.
 *
 * Supports multiple formats:
 * - NDJSON log files (data/sessions/<id>/logs.json)
 * - Codex output files (-o <tmpfile>)
 * - Raw result strings
 */

import { existsSync, readFileSync } from "fs";

/**
 * Extracts the last meaningful (non-blank, non-whitespace-only) line
 * from a block of text. Trims each line and skips empty results.
 *
 * @param text - Raw text, possibly multi-line
 * @param maxLength - Maximum length of the returned string (truncated with ellipsis)
 * @returns The last non-empty line, or null if none found
 */
export function extractLastNonEmptyLine(
  text: string | null | undefined,
  maxLength = 120,
): string | null {
  if (!text) return null;

  const lines = text.split("\n");

  // Walk backwards to find the last non-empty line
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (trimmed.length > 0) {
      if (trimmed.length > maxLength) {
        return trimmed.slice(0, maxLength - 3) + "...";
      }
      return trimmed;
    }
  }

  return null;
}

/**
 * Reads an NDJSON log file and extracts the last non-empty text from it.
 *
 * Looks at entries in reverse order and extracts text from:
 * - `raw` type entries (data field)
 * - `session_end` with error text
 * - Any entry with a `text` or `data` field
 */
export function extractLastNonEmptyFromLogs(
  logsPath: string | null | undefined,
): string | null {
  if (!logsPath || !existsSync(logsPath)) return null;

  try {
    const content = readFileSync(logsPath, "utf-8");

    // Try parsing as NDJSON first
    const lines = content.trim().split("\n").filter(Boolean);

    // Walk backwards through log entries
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(lines[i]);

        // Skip session_start entries
        if (entry._type === "session_start") continue;

        // session_end with error
        if (entry._type === "session_end" && entry.error) {
          const text = extractLastNonEmptyLine(entry.error);
          if (text) return text;
        }

        // raw log entries have data field
        if (entry._type === "raw" && entry.data) {
          const text = extractLastNonEmptyLine(
            typeof entry.data === "string" ? entry.data : JSON.stringify(entry.data),
          );
          if (text) return text;
        }

        // Generic text field
        if (entry.text) {
          const text = extractLastNonEmptyLine(entry.text);
          if (text) return text;
        }
      } catch {
        // Skip malformed JSON lines
      }
    }

    // If no NDJSON entries found, try parsing as plain JSON (build route output)
    try {
      const parsed = JSON.parse(content);
      if (parsed.result) {
        return extractLastNonEmptyLine(parsed.result);
      }
      if (parsed.error) {
        return extractLastNonEmptyLine(parsed.error);
      }
    } catch {
      // Not valid JSON either; try as raw text
      return extractLastNonEmptyLine(content);
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Extracts the last non-empty text for a session, trying multiple sources.
 *
 * Priority:
 * 1. Session result text (from process manager)
 * 2. NDJSON log file
 * 3. null
 */
export function getSessionLastText(
  logsPath: string | null | undefined,
  resultText?: string | null,
): string | null {
  // If we have a direct result, use it
  if (resultText) {
    const text = extractLastNonEmptyLine(resultText);
    if (text) return text;
  }

  // Otherwise read from log file
  return extractLastNonEmptyFromLogs(logsPath);
}
