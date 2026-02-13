import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  createSessionChunkStore,
  type AgentSessionStreamType,
} from "@/lib/agent-sessions/chunks";

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
  return db;
}

function seedSession(db: Database.Database, sessionId: string): void {
  db.prepare("INSERT INTO agent_sessions (id) VALUES (?)").run(sessionId);
}

describe("session chunk persistence", () => {
  it("stores sessionId, streamType, sequence, and timestamp metadata", () => {
    const db = createTestDb();
    seedSession(db, "s1");
    const store = createSessionChunkStore(db);

    const result = store.appendChunk({
      sessionId: "s1",
      streamType: "raw",
      content: "chunk-1",
      chunkKey: "stdout:1",
      createdAt: "2026-02-12T00:00:00.000Z",
    });

    expect(result.inserted).toBe(true);
    expect(result.chunk.sessionId).toBe("s1");
    expect(result.chunk.streamType).toBe("raw");
    expect(result.chunk.sequence).toBe(1);
    expect(result.chunk.createdAt).toBe("2026-02-12T00:00:00.000Z");
  });

  it("keeps sequence numbers monotonic per session", () => {
    const db = createTestDb();
    seedSession(db, "s2");
    const store = createSessionChunkStore(db);

    const streamTypes: AgentSessionStreamType[] = [
      "raw",
      "output",
      "response",
      "raw",
      "response",
    ];
    const sequences = streamTypes.map((streamType, index) =>
      store.appendChunk({
        sessionId: "s2",
        streamType,
        content: `chunk-${index + 1}`,
        chunkKey: `${streamType}:${index + 1}`,
      }).chunk.sequence
    );

    expect(sequences).toEqual([1, 2, 3, 4, 5]);
  });

  it("returns reads sorted by sequence ascending per stream", () => {
    const db = createTestDb();
    seedSession(db, "s3");
    const store = createSessionChunkStore(db);

    store.appendChunk({
      sessionId: "s3",
      streamType: "raw",
      content: "raw-1",
      chunkKey: "stdout:1",
    });
    store.appendChunk({
      sessionId: "s3",
      streamType: "output",
      content: "out-1",
      chunkKey: "output:1",
    });
    store.appendChunk({
      sessionId: "s3",
      streamType: "raw",
      content: "raw-2",
      chunkKey: "stdout:2",
    });

    const raw = store.listChunks("s3", "raw");
    const output = store.listChunks("s3", "output");

    expect(raw.map((chunk) => chunk.sequence)).toEqual([1, 3]);
    expect(output.map((chunk) => chunk.sequence)).toEqual([2]);
  });

  it("handles duplicate inserts idempotently for identical unique keys", () => {
    const db = createTestDb();
    seedSession(db, "s4");
    const store = createSessionChunkStore(db);

    const first = store.appendChunk({
      sessionId: "s4",
      streamType: "raw",
      content: "same",
      chunkKey: "stderr:1",
    });
    const duplicate = store.appendChunk({
      sessionId: "s4",
      streamType: "raw",
      content: "same",
      chunkKey: "stderr:1",
    });

    expect(first.inserted).toBe(true);
    expect(duplicate.inserted).toBe(false);
    expect(duplicate.chunk.sequence).toBe(first.chunk.sequence);
    expect(store.listChunks("s4", "raw")).toHaveLength(1);
  });

  it("derives and stores lastNonEmptyText from output/response chunks", () => {
    const db = createTestDb();
    seedSession(db, "s5");
    const store = createSessionChunkStore(db);

    store.appendChunk({
      sessionId: "s5",
      streamType: "output",
      content: "line one\n\n   final output line   \n",
      chunkKey: "output:1",
    });

    const firstValue = db
      .prepare("SELECT last_non_empty_text AS lastNonEmptyText FROM agent_sessions WHERE id = ?")
      .get("s5") as { lastNonEmptyText: string | null };
    expect(firstValue.lastNonEmptyText).toBe("final output line");

    // Whitespace-only response must not overwrite existing value.
    store.appendChunk({
      sessionId: "s5",
      streamType: "response",
      content: "   \n\t  ",
      chunkKey: "response:1",
    });

    const secondValue = db
      .prepare("SELECT last_non_empty_text AS lastNonEmptyText FROM agent_sessions WHERE id = ?")
      .get("s5") as { lastNonEmptyText: string | null };
    expect(secondValue.lastNonEmptyText).toBe("final output line");
  });
});
