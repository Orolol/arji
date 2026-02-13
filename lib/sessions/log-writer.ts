/**
 * Session-scoped NDJSON log writer with ordering guarantees.
 *
 * Each session gets its own LogWriter instance that maintains a monotonic
 * sequence number and serialises appends to prevent interleaving under
 * concurrent writes.
 */

import { appendFileSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "fs";
import { dirname } from "path";

export interface LogEntry {
  _type: string;
  ts: string;
  seq: number;
  sessionId: string;
  [key: string]: unknown;
}

export class SessionLogWriter {
  private seq = 0;
  private writing = false;
  private queue: LogEntry[] = [];

  constructor(
    public readonly sessionId: string,
    public readonly filePath: string,
  ) {
    // Ensure directory exists
    const dir = dirname(filePath);
    mkdirSync(dir, { recursive: true });
  }

  /**
   * Writes the session header as the first line of the log file.
   */
  writeHeader(metadata: Record<string, unknown> = {}): void {
    const entry: LogEntry = {
      _type: "session_start",
      ts: new Date().toISOString(),
      seq: this.seq++,
      sessionId: this.sessionId,
      ...metadata,
    };
    writeFileSync(this.filePath, JSON.stringify(entry) + "\n", "utf-8");
  }

  /**
   * Appends an event to the log file with a monotonic sequence number.
   * Writes are serialised: if another write is in progress, the entry
   * is queued and flushed in order.
   */
  append(type: string, data: Record<string, unknown> = {}): void {
    const entry: LogEntry = {
      _type: type,
      ts: new Date().toISOString(),
      seq: this.seq++,
      sessionId: this.sessionId,
      ...data,
    };
    this.queue.push(entry);
    this.flush();
  }

  /**
   * Writes the session end marker.
   */
  end(info: { status: string; error?: string; durationMs?: number }): void {
    this.append("session_end", {
      status: info.status,
      error: info.error,
      durationMs: info.durationMs,
    });
  }

  /** Current sequence number (for testing). */
  get currentSeq(): number {
    return this.seq;
  }

  private flush(): void {
    if (this.writing) return;
    this.writing = true;
    try {
      while (this.queue.length > 0) {
        const entry = this.queue.shift()!;
        appendFileSync(this.filePath, JSON.stringify(entry) + "\n", "utf-8");
      }
    } finally {
      this.writing = false;
    }
  }
}

/**
 * Registry of active log writers, keyed by sessionId.
 * Prevents multiple writers for the same session.
 */
const activeWriters = new Map<string, SessionLogWriter>();

/**
 * Gets or creates a SessionLogWriter for the given session.
 * Returns the same instance if called multiple times for the same sessionId.
 */
export function getLogWriter(
  sessionId: string,
  filePath: string,
): SessionLogWriter {
  let writer = activeWriters.get(sessionId);
  if (!writer) {
    writer = new SessionLogWriter(sessionId, filePath);
    activeWriters.set(sessionId, writer);
  }
  return writer;
}

/**
 * Removes a log writer from the registry (called when session completes).
 */
export function releaseLogWriter(sessionId: string): void {
  activeWriters.delete(sessionId);
}

/**
 * Reads an NDJSON log file and returns parsed entries sorted by seq number.
 * Ensures deterministic ordering even if entries were written out of order.
 */
export function readLogEntries(filePath: string): LogEntry[] {
  if (!existsSync(filePath)) return [];

  try {
    const content = readFileSync(filePath, "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);
    const entries: LogEntry[] = [];

    for (const line of lines) {
      try {
        entries.push(JSON.parse(line) as LogEntry);
      } catch {
        // Skip malformed lines
      }
    }

    // Sort by sequence number for deterministic ordering
    entries.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
    return entries;
  } catch {
    return [];
  }
}
