/**
 * `listChunkPage` — the bounded read behind the paginated session-detail
 * output.
 *
 * The session detail route used to hand every client all three chunk streams
 * in full: 112 MB for the worst session on the live database, materialised
 * synchronously on the one shared better-sqlite3 connection, which blocks the
 * whole event loop. These tests pin the two bounds that make the page safe —
 * the row limit AND the byte budget — plus the truncation contract for a
 * single chunk bigger than the cap, which no row limit can bound.
 */
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  createSessionChunkStore,
  truncateUtf8,
  type AgentSessionStreamType,
  type SessionChunkStore,
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
  db.prepare("INSERT INTO agent_sessions (id) VALUES ('s1')").run();
  return db;
}

function seed(
  store: SessionChunkStore,
  entries: Array<[AgentSessionStreamType, string]>
): void {
  for (const [streamType, content] of entries) {
    store.appendChunk({ sessionId: "s1", streamType, content });
  }
}

describe("listChunkPage — keyset pagination", () => {
  it("walks the stream in sequence order through nextAfter", () => {
    const store = createSessionChunkStore(createTestDb());
    seed(
      store,
      Array.from({ length: 5 }, (_, i) => ["raw", `chunk-${i}`] as const)
    );

    const first = store.listChunkPage("s1", "raw", { limit: 2 });
    expect(first.chunks.map((c) => c.content)).toEqual(["chunk-0", "chunk-1"]);
    expect(first.hasMore).toBe(true);

    const second = store.listChunkPage("s1", "raw", {
      limit: 2,
      after: first.nextAfter,
    });
    expect(second.chunks.map((c) => c.content)).toEqual(["chunk-2", "chunk-3"]);
    expect(second.hasMore).toBe(true);

    const third = store.listChunkPage("s1", "raw", {
      limit: 2,
      after: second.nextAfter,
    });
    expect(third.chunks.map((c) => c.content)).toEqual(["chunk-4"]);
    // The row limit was not reached AND nothing follows: the stream is done.
    expect(third.hasMore).toBe(false);
  });

  it("exhausts the stream exactly once — no chunk served twice or skipped", () => {
    const store = createSessionChunkStore(createTestDb());
    seed(
      store,
      Array.from({ length: 37 }, (_, i) => ["output", `c${i}`] as const)
    );

    for (const pageSize of [1, 2, 5, 37, 100]) {
      const seen: string[] = [];
      let after: number | null = null;
      // Bounded loop: a cursor that stopped advancing must not spin forever.
      for (let page = 0; page < 100; page++) {
        const result = store.listChunkPage("s1", "output", {
          limit: pageSize,
          after,
        });
        seen.push(...result.chunks.map((c) => c.content));
        after = result.nextAfter;
        if (!result.hasMore) break;
      }
      expect(seen).toEqual(
        Array.from({ length: 37 }, (_, i) => `c${i}`)
      );
    }
  });

  it("keeps an empty page's cursor where the caller left it", () => {
    const store = createSessionChunkStore(createTestDb());
    seed(store, [["response", "only"]]);

    const first = store.listChunkPage("s1", "response", {});
    expect(first.chunks).toHaveLength(1);
    expect(first.hasMore).toBe(false);

    // A live session that has written nothing since: same cursor back, so the
    // next poll asks for the same point rather than restarting the stream.
    const tail = store.listChunkPage("s1", "response", {
      after: first.nextAfter,
    });
    expect(tail.chunks).toEqual([]);
    expect(tail.nextAfter).toBe(first.nextAfter);
    expect(tail.hasMore).toBe(false);

    seed(store, [["response", "more"]]);
    const resumed = store.listChunkPage("s1", "response", {
      after: tail.nextAfter,
    });
    expect(resumed.chunks.map((c) => c.content)).toEqual(["more"]);
  });

  it("returns only the requested stream", () => {
    const store = createSessionChunkStore(createTestDb());
    seed(store, [
      ["raw", "raw-1"],
      ["output", "output-1"],
      ["response", "response-1"],
      ["raw", "raw-2"],
    ]);

    const page = store.listChunkPage("s1", "raw", {});
    expect(page.chunks.map((c) => c.content)).toEqual(["raw-1", "raw-2"]);
    expect(page.chunks.every((c) => c.streamType === "raw")).toBe(true);
  });
});

describe("listChunkPage — byte bounds", () => {
  it("closes the page on the byte budget before the row limit", () => {
    const store = createSessionChunkStore(createTestDb());
    seed(
      store,
      Array.from({ length: 20 }, (_, i) => ["raw", "x".repeat(1000) + i] as const)
    );

    const page = store.listChunkPage("s1", "raw", {
      limit: 20,
      maxBytes: 3000,
    });

    // Two ~1001-byte chunks fit; the third would cross the budget.
    expect(page.chunks).toHaveLength(2);
    expect(
      page.chunks.reduce((n, c) => n + Buffer.byteLength(c.content), 0)
    ).toBeLessThanOrEqual(3000);
    // The row limit was never reached, so `hasMore` has to come from the
    // stream itself — otherwise the client stops three chunks in.
    expect(page.hasMore).toBe(true);

    const next = store.listChunkPage("s1", "raw", {
      limit: 20,
      maxBytes: 3000,
      after: page.nextAfter,
    });
    expect(next.chunks[0].content).toBe("x".repeat(1000) + "2");
  });

  it("stops inside a chunk larger than the cap and points the cursor at the rest", () => {
    const store = createSessionChunkStore(createTestDb());
    seed(store, [
      ["raw", "y".repeat(5000)],
      ["raw", "after-the-big-one"],
    ]);

    const page = store.listChunkPage("s1", "raw", {
      limit: 10,
      maxChunkBytes: 500,
      maxBytes: 4000,
    });

    // Only the first slice — the page does NOT run on to the next chunk,
    // because the cursor cannot say "chunk 1 partly, chunk 2 wholly".
    expect(page.chunks).toHaveLength(1);
    expect(page.chunks[0].content).toBe("y".repeat(500));
    expect(page.chunks[0].contentTruncated).toBe(true);
    expect(page.chunks[0].contentOffset).toBe(0);
    expect(page.chunks[0].contentLength).toBe(5000);
    // The cursor stays ON the big chunk, 500 characters in.
    expect(page.nextAfter).toBe(1);
    expect(page.nextOffset).toBe(500);
    expect(page.hasMore).toBe(true);

    const second = store.listChunkPage("s1", "raw", {
      limit: 10,
      maxChunkBytes: 500,
      maxBytes: 4000,
      after: page.nextAfter,
      afterOffset: page.nextOffset,
    });
    expect(second.chunks[0].content).toBe("y".repeat(500));
    expect(second.chunks[0].contentOffset).toBe(500);
    expect(second.nextOffset).toBe(1000);
  });

  it("delivers an oversized chunk whole across pages, then moves on", () => {
    const store = createSessionChunkStore(createTestDb());
    // Distinct characters, so a duplicated or skipped slice cannot pass by
    // looking like its neighbour — the failure mode a repeat() fixture hides.
    const big = Array.from({ length: 5000 }, (_, i) =>
      String.fromCharCode(97 + (i % 26))
    ).join("");
    seed(store, [
      ["raw", big],
      ["raw", "after-the-big-one"],
    ]);

    let after: number | null = null;
    let offset = 0;
    let assembled = "";
    let guard = 0;

    for (;;) {
      const page: ReturnType<typeof store.listChunkPage> = store.listChunkPage(
        "s1",
        "raw",
        { maxChunkBytes: 500, maxBytes: 4000, after, afterOffset: offset }
      );
      assembled += page.chunks.map((chunk) => chunk.content).join("");
      after = page.nextAfter;
      offset = page.nextOffset;
      if (!page.hasMore) break;
      if (++guard > 50) throw new Error("cursor never converged");
    }

    // The whole 5000-character chunk is recoverable, exactly once, and the
    // chunk that follows it is not lost behind it.
    expect(assembled).toBe(big + "after-the-big-one");
  });

  it("always returns one slice, even when it alone exceeds the budget", () => {
    const store = createSessionChunkStore(createTestDb());
    seed(store, [
      ["raw", "z".repeat(9000)],
      ["raw", "next"],
    ]);

    const page = store.listChunkPage("s1", "raw", { limit: 10, maxBytes: 100 });

    // Otherwise the cursor could never advance at all.
    expect(page.chunks).toHaveLength(1);
    expect(Buffer.byteLength(page.chunks[0].content)).toBeLessThanOrEqual(100);
    expect(page.chunks[0].contentTruncated).toBe(true);
    expect(page.hasMore).toBe(true);
    expect(page.nextOffset).toBeGreaterThan(0);
  });

  it("advances the offset in code points, the unit SQLite substr() works in", () => {
    const store = createSessionChunkStore(createTestDb());
    // Astral characters are 2 UTF-16 units but ONE character to substr(): an
    // offset counted in units would resume in the wrong place and repeat text.
    const astral = "🙂".repeat(20);
    seed(store, [["raw", astral]]);

    let after: number | null = null;
    let offset = 0;
    let assembled = "";
    for (let page = 0; page < 30; page++) {
      const result = store.listChunkPage("s1", "raw", {
        maxChunkBytes: 12,
        maxBytes: 12,
        after,
        afterOffset: offset,
      });
      assembled += result.chunks.map((chunk) => chunk.content).join("");
      after = result.nextAfter;
      offset = result.nextOffset;
      if (!result.hasMore) break;
    }

    expect(assembled).toBe(astral);
  });

  it("moves on from an offset that is past the end of its chunk", () => {
    const store = createSessionChunkStore(createTestDb());
    seed(store, [
      ["raw", "one"],
      ["raw", "two"],
    ]);

    // Sequence 1 holds 3 characters, so this cursor points past its end — a
    // chunk that shrank, or a client echoing back a stale pair. The page has
    // to move on rather than return nothing, forever.
    const page = store.listChunkPage("s1", "raw", { after: 1, afterOffset: 999 });

    expect(page.chunks.map((chunk) => chunk.content)).toEqual(["two"]);
    expect(page.nextOffset).toBe(0);
    expect(page.hasMore).toBe(false);
  });

  it("counts UTF-8 bytes, not UTF-16 units, and never splits a character", () => {
    const store = createSessionChunkStore(createTestDb());
    // 3 bytes each in UTF-8, 1 UTF-16 unit each: a unit-based budget would
    // ship 3x the bytes it promised.
    seed(store, [["raw", "漢".repeat(100)]]);

    const page = store.listChunkPage("s1", "raw", { maxChunkBytes: 100 });
    const [chunk] = page.chunks;

    expect(Buffer.byteLength(chunk.content, "utf8")).toBeLessThanOrEqual(100);
    expect(chunk.content).toBe("漢".repeat(33));
    expect(chunk.content).not.toMatch(/�/);
    expect(chunk.contentTruncated).toBe(true);
  });
});

describe("truncateUtf8", () => {
  it("leaves content under the cap untouched", () => {
    expect(truncateUtf8("hello", 10)).toEqual({
      text: "hello",
      truncated: false,
    });
  });

  it("cuts on a character boundary", () => {
    // "aéé" is 5 UTF-8 bytes. A 4-byte cap lands inside the second "é", so
    // the cut walks back to the boundary rather than emitting half a
    // character (which would decode to U+FFFD).
    expect(truncateUtf8("aéé", 4)).toEqual({ text: "aé", truncated: true });
    expect(truncateUtf8("aéé", 3)).toEqual({ text: "aé", truncated: true });
    expect(truncateUtf8("aéé", 2)).toEqual({ text: "a", truncated: true });
  });

  it("handles an astral character (surrogate pair) without splitting it", () => {
    expect(truncateUtf8("🙂🙂", 5)).toEqual({ text: "🙂", truncated: true });
  });
});

describe("listChunks — unchanged for the whole-stream callers", () => {
  it("still returns every chunk in full", () => {
    const store = createSessionChunkStore(createTestDb());
    seed(store, [
      ["raw", "a".repeat(5000)],
      ["raw", "b"],
    ]);

    // lib/pipeline/forensic.ts and lib/agent-sessions/arij-actions.ts read the
    // whole stream server-side; the page above must not have narrowed this.
    const all = store.listChunks("s1", "raw");
    expect(all).toHaveLength(2);
    expect(all[0].content).toBe("a".repeat(5000));
    expect(all[0]).not.toHaveProperty("contentTruncated");
  });
});
