import fs from "fs";

/**
 * Extract the last non-empty text from a session log file.
 *
 * Log files are JSON arrays of message objects. We search from the end
 * for the last entry that contains non-empty text content.
 *
 * Returns null if the file doesn't exist, is invalid, or has no text content.
 */
export function extractLastNonEmptyText(
  logsPath: string | null,
): string | null {
  if (!logsPath || !fs.existsSync(logsPath)) {
    return null;
  }

  try {
    const raw = fs.readFileSync(logsPath, "utf-8");
    const parsed = JSON.parse(raw);

    if (!Array.isArray(parsed)) {
      return null;
    }

    // Walk backwards to find last non-empty text
    for (let i = parsed.length - 1; i >= 0; i--) {
      const entry = parsed[i];
      // Handle various log entry shapes
      const text =
        entry?.text ??
        entry?.content ??
        entry?.message ??
        (typeof entry === "string" ? entry : null);

      if (typeof text === "string" && text.trim().length > 0) {
        return text.trim();
      }
    }

    return null;
  } catch {
    // Try line-based fallback for JSONL or plain text logs
    try {
      const raw = fs.readFileSync(logsPath, "utf-8");
      const lines = raw.split("\n");
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (line.length > 0) {
          // Try parsing as JSON line
          try {
            const obj = JSON.parse(line);
            const text =
              obj?.text ?? obj?.content ?? obj?.message ?? null;
            if (typeof text === "string" && text.trim().length > 0) {
              return text.trim();
            }
          } catch {
            // Plain text line
            return line;
          }
        }
      }
    } catch {
      // Ignore
    }
    return null;
  }
}
