/**
 * The WRITE-path cap on `agent_session_chunks.content`.
 *
 * `appendChunk` used to store whatever it was handed at any size. That is how
 * the live database came to hold 395.5 MB of chunk content across 126,953
 * rows, with a single 8.3 MB chunk and a single 51.3 MB session in it. The
 * bounded read (`listChunkPage`) only ever limited what was SERVED; nothing
 * limited what was kept.
 *
 * These tests pin the four halves of that contract: an oversized chunk is
 * stored head + marker + tail, an ordinary chunk is stored byte-identical,
 * `lastNonEmptyText` is still derived from the UNCAPPED text, and the cut
 * never lands inside a character.
 */
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  capChunkContent,
  createSessionChunkStore,
  type SessionChunkStore,
} from "@/lib/agent-sessions/chunks";
import {
  chunkElisionMarker,
  isChunkElisionMarker,
  SESSION_CHUNK_ELISION_LABEL,
  SESSION_CHUNK_MAX_STORED_BYTES,
  SESSION_CHUNK_STORED_HEAD_BYTES,
  SESSION_CHUNK_STORED_TAIL_BYTES,
} from "@/lib/agent-sessions/chunk-cap";

function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE agent_sessions (
      id text PRIMARY KEY NOT NULL,
      last_non_empty_text text
    );

    CREATE TABLE agent_session_sequences (
      session_id text PRIMARY KEY NOT NULL,
      next_sequence integer NOT NULL DEFAULT 1,
      updated_at text DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (session_id) REFERENCES agent_sessions(id) ON DELETE cascade
    );

    CREATE TABLE agent_session_chunks (
      id text PRIMARY KEY NOT NULL,
      session_id text NOT NULL,
      stream_type text NOT NULL,
      sequence integer NOT NULL,
      chunk_key text,
      content text NOT NULL,
      created_at text DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (session_id) REFERENCES agent_sessions(id) ON DELETE cascade
    );

    CREATE UNIQUE INDEX agent_session_chunks_session_sequence_unique
      ON agent_session_chunks (session_id, sequence);
    CREATE UNIQUE INDEX agent_session_chunks_session_stream_key_unique
      ON agent_session_chunks (session_id, stream_type, chunk_key);
    CREATE INDEX agent_session_chunks_session_stream_sequence_idx
      ON agent_session_chunks (session_id, stream_type, sequence);
  `);
  db.prepare("INSERT INTO agent_sessions (id) VALUES ('s1')").run();
  return db;
}

/** What SQLite actually holds, read back rather than trusted from the return. */
function storedContent(db: Database.Database, sequence: number): string {
  return (
    db
      .prepare("SELECT content FROM agent_session_chunks WHERE sequence = ?")
      .get(sequence) as { content: string }
  ).content;
}

function lastNonEmptyText(db: Database.Database): string | null {
  return (
    db
      .prepare(
        "SELECT last_non_empty_text AS text FROM agent_sessions WHERE id = 's1'"
      )
      .get() as { text: string | null }
  ).text;
}

function setup(): { db: Database.Database; store: SessionChunkStore } {
  const db = createTestDb();
  return { db, store: createSessionChunkStore(db) };
}

describe("appendChunk write-path cap", () => {
  it("stores an oversized chunk capped, with head, tail and the marker", () => {
    const { db, store } = setup();
    // 1 MiB — four times the cap, and the shape of a real one-shot CLI result
    // blob: a recognisable opening, a mass of filler, a recognisable verdict.
    const filler = "x".repeat(1024 * 1024);
    const content = `START OF OUTPUT\n${filler}\nEND OF OUTPUT`;

    store.appendChunk({ sessionId: "s1", streamType: "output", content });

    const stored = storedContent(db, 1);
    expect(Buffer.byteLength(stored, "utf8")).toBeLessThanOrEqual(
      SESSION_CHUNK_MAX_STORED_BYTES
    );
    expect(stored).not.toBe(content);
    expect(stored.startsWith("START OF OUTPUT\n")).toBe(true);
    expect(stored.endsWith("\nEND OF OUTPUT")).toBe(true);

    const markerLine = stored
      .split("\n")
      .find((line) => isChunkElisionMarker(line));
    expect(markerLine).toBeDefined();
    expect(markerLine).toContain(SESSION_CHUNK_ELISION_LABEL);

    // The marker's number is the bytes actually dropped, not a guess: head +
    // marker line + tail + the two newlines must add back up to the original.
    const elided = Number(
      /\[… ([\d,]+) bytes/.exec(markerLine as string)![1].replace(/,/g, "")
    );
    const kept =
      Buffer.byteLength(stored, "utf8") -
      Buffer.byteLength(`\n${markerLine}\n`, "utf8");
    expect(kept + elided).toBe(Buffer.byteLength(content, "utf8"));
  });

  it("stores a normal-sized chunk byte-identical", () => {
    const { db, store } = setup();
    // Deliberately awkward: trailing whitespace, blank lines, a lone "[…" that
    // must NOT be mistaken for a marker, and multi-byte characters.
    const content =
      "$ npm test\n\n  · 6600 passed  \n[… not a marker …]\né🙂 done\n";

    const result = store.appendChunk({
      sessionId: "s1",
      streamType: "raw",
      content,
    });

    expect(storedContent(db, 1)).toBe(content);
    expect(result.chunk.content).toBe(content);
    expect(store.listChunks("s1", "raw")[0].content).toBe(content);
  });

  it("stores a chunk exactly at the cap byte-identical", () => {
    const { db, store } = setup();
    const content = "y".repeat(SESSION_CHUNK_MAX_STORED_BYTES);

    store.appendChunk({ sessionId: "s1", streamType: "raw", content });

    expect(storedContent(db, 1)).toBe(content);
  });

  it("never records the marker itself as lastNonEmptyText", () => {
    const { db, store } = setup();
    // The agent's last word, then more trailing blank padding than the tail
    // budget. Cap the content first and the stored chunk's last NON-EMPTY
    // line is the marker Arij just wrote — the session list would then show
    // Arij quoting itself instead of the agent's final line.
    const content = `${"z".repeat(300 * 1024)}\n  THE FINAL WORD  \n${"\n".repeat(
      64 * 1024
    )}`;

    store.appendChunk({ sessionId: "s1", streamType: "output", content });

    expect(lastNonEmptyText(db)).toBe("THE FINAL WORD");
    expect(isChunkElisionMarker(lastNonEmptyText(db) as string)).toBe(false);
  });

  it("keeps lastNonEmptyText accurate when the cap eats the tail's own text", () => {
    const { db, store } = setup();
    // A single enormous line with no trailing newline: the tail is a slice of
    // that same line, so the stored chunk's last line is a fragment. The
    // recorded final text must still be the whole line.
    const content = `head\n${"w".repeat(1024 * 1024)}TAIL-END`;

    store.appendChunk({ sessionId: "s1", streamType: "response", content });

    expect(lastNonEmptyText(db)).toBe(`${"w".repeat(1024 * 1024)}TAIL-END`);
  });
});

describe("capChunkContent", () => {
  it("leaves content at or under the cap untouched", () => {
    expect(capChunkContent("small")).toEqual({
      content: "small",
      capped: false,
    });
    const atCap = "a".repeat(SESSION_CHUNK_MAX_STORED_BYTES);
    expect(capChunkContent(atCap)).toEqual({ content: atCap, capped: false });
  });

  it("never cuts inside a multi-byte character", () => {
    // A 9-byte unit — "é" (2) + "→" (3) + "🌊" (4) — so neither cut point
    // divides evenly into it and both land mid-character. A wall of 4-byte
    // emoji does NOT test this: head (212,992 bytes) and tail offset are both
    // multiples of 4, so a naive byte slice would pass.
    const unit = "é→🌊";
    const text = unit.repeat(
      Math.ceil((SESSION_CHUNK_MAX_STORED_BYTES * 3) / Buffer.byteLength(unit))
    );
    const { content, capped } = capChunkContent(text);

    expect(capped).toBe(true);
    expect(content).not.toContain("�");
    // Round-tripping through UTF-8 must be a no-op — the proof that no
    // half-character survived either seam.
    expect(Buffer.from(content, "utf8").toString("utf8")).toBe(content);
    const [head, , tail] = content.split("\n");
    expect(head.endsWith("🌊") || head.endsWith("é") || head.endsWith("→")).toBe(
      true
    );
    expect(tail.length).toBeGreaterThan(0);
  });

  it("keeps a capped chunk strictly under the cap, marker included", () => {
    const { content } = capChunkContent("q".repeat(10 * 1024 * 1024));
    const bytes = Buffer.byteLength(content, "utf8");

    expect(bytes).toBeLessThan(SESSION_CHUNK_MAX_STORED_BYTES);
    // Head and tail are what the constants promise; the slack is the marker's.
    expect(bytes).toBeGreaterThanOrEqual(
      SESSION_CHUNK_STORED_HEAD_BYTES + SESSION_CHUNK_STORED_TAIL_BYTES
    );
  });
});

describe("the elision marker", () => {
  it("states the cap it enforces, derived from the constant", () => {
    expect(SESSION_CHUNK_ELISION_LABEL).toContain(
      `${SESSION_CHUNK_MAX_STORED_BYTES / 1024} KiB`
    );
    expect(chunkElisionMarker(1234567)).toBe(
      `[… 1,234,567 bytes elided — ${SESSION_CHUNK_ELISION_LABEL} …]`
    );
  });

  it("recognises its own markers and nothing else", () => {
    expect(isChunkElisionMarker(chunkElisionMarker(42))).toBe(true);
    expect(isChunkElisionMarker(`  ${chunkElisionMarker(42)}  `)).toBe(true);
    expect(isChunkElisionMarker("[… 42 bytes elided …]")).toBe(false);
    expect(isChunkElisionMarker(`x ${chunkElisionMarker(42)}`)).toBe(false);
    expect(isChunkElisionMarker("ordinary agent output")).toBe(false);
  });
});
