/**
 * Unconditional same-session chunk deduplication.
 *
 * `appendChunk` used to dedupe only when the caller handed it a `chunkKey`:
 * SQLite treats NULLs in a unique index as distinct from one another, so the
 * (session_id, stream_type, chunk_key) index that collapses keyed repeats let
 * every keyless repeat through. Providers that omit the key — `chunkKey` is
 * optional on `ProviderChunk` — paid full storage for content already stored.
 *
 * Measured on the live database (256,594 chunk rows): 17,116 raw and 198
 * output content values repeat inside one session and stream, 25.3 MB of
 * duplicate content in all. Every row there is keyed today, so these tests
 * pin the keyless path before a provider that omits keys ever writes to it.
 *
 * The contract: a keyless chunk is stored under a digest of the content its
 * writer produced — before the write-path cap, which is lossy and would make
 * two different oversized chunks share a key — an exact repeat returns
 * `inserted: false` without consuming a sequence, and the keyed fast path is
 * untouched.
 */
import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  createSessionChunkStore,
  DERIVED_CHUNK_KEY_PREFIX,
  deriveChunkKey,
  type SessionChunkStore,
} from "@/lib/agent-sessions/chunks";
import {
  SESSION_CHUNK_MAX_STORED_BYTES,
  SESSION_CHUNK_STORED_HEAD_BYTES,
  SESSION_CHUNK_STORED_TAIL_BYTES,
  isChunkElisionMarker,
} from "@/lib/agent-sessions/chunk-cap";
import { createTestDb } from "@/lib/db/test-utils";

/**
 * The real migration chain, not hand-written DDL: dedupe IS the
 * (session_id, stream_type, chunk_key) unique index, and a test that
 * re-declares the index it depends on proves the copy, not the schema.
 */
function setup(): { db: Database.Database; store: SessionChunkStore } {
  const { sqlite } = createTestDb();
  sqlite
    .prepare("INSERT INTO projects (id, name) VALUES ('p1', 'Dedupe')")
    .run();
  for (const id of ["s1", "s2"]) {
    sqlite
      .prepare("INSERT INTO agent_sessions (id, project_id) VALUES (?, 'p1')")
      .run(id);
  }
  return { db: sqlite, store: createSessionChunkStore(sqlite) };
}

/** Rows as SQLite holds them, read back rather than trusted from the return. */
function rows(
  db: Database.Database,
  sessionId = "s1"
): { sequence: number; streamType: string; chunkKey: string | null; content: string }[] {
  return db
    .prepare(
      `SELECT sequence, stream_type AS streamType, chunk_key AS chunkKey, content
       FROM agent_session_chunks WHERE session_id = ? ORDER BY sequence`
    )
    .all(sessionId) as {
    sequence: number;
    streamType: string;
    chunkKey: string | null;
    content: string;
  }[];
}

/** The session row's final word, as the store wrote it. */
function lastNonEmptyText(db: Database.Database, sessionId = "s1"): string | null {
  return (
    db
      .prepare(
        "SELECT last_non_empty_text AS text FROM agent_sessions WHERE id = ?"
      )
      .get(sessionId) as { text: string | null }
  ).text;
}

/** The reservation counter, i.e. the sequence the NEXT insert would take. */
function nextSequence(db: Database.Database, sessionId = "s1"): number {
  const row = db
    .prepare(
      "SELECT next_sequence AS next FROM agent_session_sequences WHERE session_id = ?"
    )
    .get(sessionId) as { next: number } | undefined;
  return row?.next ?? 1;
}

describe("keyless chunk deduplication", () => {
  it("stores one row for two identical keyless chunks in one session", () => {
    const { db, store } = setup();

    const first = store.appendChunk({
      sessionId: "s1",
      streamType: "raw",
      content: "npm test\n> 6,600 passing\n",
    });
    const second = store.appendChunk({
      sessionId: "s1",
      streamType: "raw",
      content: "npm test\n> 6,600 passing\n",
    });

    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(false);
    expect(rows(db)).toHaveLength(1);
  });

  it("returns the stored chunk for a duplicate, as the keyed path does", () => {
    const { store } = setup();

    const first = store.appendChunk({
      sessionId: "s1",
      streamType: "raw",
      content: "same",
      createdAt: "2026-09-05T00:00:00.000Z",
    });
    const duplicate = store.appendChunk({
      sessionId: "s1",
      streamType: "raw",
      content: "same",
      createdAt: "2026-09-05T00:00:09.000Z",
    });

    expect(duplicate.inserted).toBe(false);
    // The first write's identity and timestamp, not the duplicate's.
    expect(duplicate.chunk.id).toBe(first.chunk.id);
    expect(duplicate.chunk.sequence).toBe(first.chunk.sequence);
    expect(duplicate.chunk.createdAt).toBe("2026-09-05T00:00:00.000Z");
  });

  it("does not consume a sequence for a deduped write", () => {
    const { db, store } = setup();

    store.appendChunk({ sessionId: "s1", streamType: "raw", content: "a" });
    store.appendChunk({ sessionId: "s1", streamType: "raw", content: "a" });
    store.appendChunk({ sessionId: "s1", streamType: "raw", content: "a" });
    const after = store.appendChunk({
      sessionId: "s1",
      streamType: "raw",
      content: "b",
    });

    // 2, not 4: the stream stays gap-free, so the pagination cursor never
    // walks sequences that hold no row.
    expect(after.chunk.sequence).toBe(2);
    expect(rows(db).map((row) => row.sequence)).toEqual([1, 2]);
    expect(nextSequence(db)).toBe(3);
  });

  it("stores a keyless chunk under a derived content key", () => {
    const { db, store } = setup();

    store.appendChunk({ sessionId: "s1", streamType: "raw", content: "hello" });

    const [row] = rows(db);
    expect(row.chunkKey).toBe(deriveChunkKey("hello"));
    expect(row.chunkKey?.startsWith(DERIVED_CHUNK_KEY_PREFIX)).toBe(true);
  });

  it("keeps different keyless content on separate rows", () => {
    const { db, store } = setup();

    store.appendChunk({ sessionId: "s1", streamType: "raw", content: "one" });
    store.appendChunk({ sessionId: "s1", streamType: "raw", content: "two" });
    // Whitespace is content: near-identical is not identical.
    store.appendChunk({ sessionId: "s1", streamType: "raw", content: "two " });

    expect(rows(db).map((row) => row.content)).toEqual(["one", "two", "two "]);
  });

  it("scopes dedupe to one session and one stream", () => {
    const { db, store } = setup();

    store.appendChunk({ sessionId: "s1", streamType: "raw", content: "shared" });
    const otherStream = store.appendChunk({
      sessionId: "s1",
      streamType: "output",
      content: "shared",
    });
    const otherSession = store.appendChunk({
      sessionId: "s2",
      streamType: "raw",
      content: "shared",
    });

    // Same content, but a different stream and a different session are
    // different facts about the run — exactly the keyed path's scope.
    expect(otherStream.inserted).toBe(true);
    expect(otherSession.inserted).toBe(true);
    expect(rows(db, "s1")).toHaveLength(2);
    expect(rows(db, "s2")).toHaveLength(1);
  });

  it("dedupes two identical oversized chunks on their original content", () => {
    const { db, store } = setup();
    const oversized = "x".repeat(SESSION_CHUNK_MAX_STORED_BYTES + 4096);

    const first = store.appendChunk({
      sessionId: "s1",
      streamType: "raw",
      content: oversized,
    });
    const second = store.appendChunk({
      sessionId: "s1",
      streamType: "raw",
      content: oversized,
    });

    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(false);
    // The digest identifies what the WRITER produced, not the capped row it
    // became — the row is stored capped, the key is the original's.
    expect(rows(db)[0].chunkKey).toBe(deriveChunkKey(oversized));
    expect(rows(db)[0].content).not.toBe(oversized);
    expect(rows(db)).toHaveLength(1);
  });

  it("keeps two oversized chunks that differ only inside the elided middle", () => {
    const { db, store } = setup();
    // Identical retained ends, identical byte length, different middles: what
    // the cap keeps is the same for both, so a digest of the CAPPED form
    // calls the second one a duplicate and drops it. The trailing whitespace
    // puts each chunk's real final line inside the part the cap elides.
    const head = "H".repeat(SESSION_CHUNK_STORED_HEAD_BYTES);
    const whitespaceTail = "\n".repeat(SESSION_CHUNK_STORED_TAIL_BYTES);
    const middle = "m".repeat(20_000);
    const chunk = (finalLine: string) =>
      `${head}\n${middle}\n${finalLine}\n${whitespaceTail}`;

    const first = store.appendChunk({
      sessionId: "s1",
      streamType: "output",
      content: chunk("First final answer"),
    });
    const second = store.appendChunk({
      sessionId: "s1",
      streamType: "output",
      content: chunk("Other final answer"),
    });

    // The premise: both really do cap to the same bytes.
    expect(first.chunk.content).toBe(second.chunk.content);
    expect(isChunkElisionMarker(first.chunk.content.split("\n")[1])).toBe(true);

    // Two distinct outputs, therefore two rows.
    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(true);
    expect(rows(db)).toHaveLength(2);
    expect(rows(db).map((row) => row.chunkKey)).toEqual([
      deriveChunkKey(chunk("First final answer")),
      deriveChunkKey(chunk("Other final answer")),
    ]);

    // And the second write's uncapped final word is what the session carries.
    expect(lastNonEmptyText(db)).toBe("Other final answer");
  });

  it("still derives lastNonEmptyText from the first of the duplicates", () => {
    const { db, store } = setup();

    store.appendChunk({
      sessionId: "s1",
      streamType: "output",
      content: "done\n",
    });
    store.appendChunk({
      sessionId: "s1",
      streamType: "response",
      content: "final word\n",
    });
    // A repeat of the earlier output must not resurrect it as the last word.
    store.appendChunk({
      sessionId: "s1",
      streamType: "output",
      content: "done\n",
    });

    expect(lastNonEmptyText(db)).toBe("final word");
  });
});

describe("the keyed fast path", () => {
  it("keeps a caller-supplied key, never a derived one", () => {
    const { db, store } = setup();

    store.appendChunk({
      sessionId: "s1",
      streamType: "raw",
      content: "keyed",
      chunkKey: "stdout:1",
    });

    expect(rows(db)[0].chunkKey).toBe("stdout:1");
  });

  it("still stores repeated content under distinct keys", () => {
    const { db, store } = setup();

    const first = store.appendChunk({
      sessionId: "s1",
      streamType: "raw",
      content: "repeated line\n",
      chunkKey: "stdout:1",
    });
    const second = store.appendChunk({
      sessionId: "s1",
      streamType: "raw",
      content: "repeated line\n",
      chunkKey: "stdout:2",
    });

    // The 25.3 MB of same-session duplicate content measured on the live
    // database sits here, behind distinct provider keys. Collapsing it would
    // change what the keyed path means — a separate decision, deliberately
    // not taken by this change.
    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(true);
    expect(rows(db)).toHaveLength(2);
  });

  it("dedupes on the key alone, whatever the content", () => {
    const { db, store } = setup();

    const first = store.appendChunk({
      sessionId: "s1",
      streamType: "raw",
      content: "first content",
      chunkKey: "stdout:1",
    });
    const replay = store.appendChunk({
      sessionId: "s1",
      streamType: "raw",
      content: "different content, same key",
      chunkKey: "stdout:1",
    });

    expect(first.inserted).toBe(true);
    expect(replay.inserted).toBe(false);
    expect(rows(db)).toHaveLength(1);
    expect(rows(db)[0].content).toBe("first content");
  });

  it("does not collide with a keyless chunk of the same content", () => {
    const { db, store } = setup();

    store.appendChunk({
      sessionId: "s1",
      streamType: "raw",
      content: "ambiguous",
    });
    const keyed = store.appendChunk({
      sessionId: "s1",
      streamType: "raw",
      content: "ambiguous",
      chunkKey: "stdout:1",
    });

    expect(keyed.inserted).toBe(true);
    expect(rows(db).map((row) => row.chunkKey)).toEqual([
      deriveChunkKey("ambiguous"),
      "stdout:1",
    ]);
  });
});
