import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  SessionLogWriter,
  getLogWriter,
  releaseLogWriter,
  readLogEntries,
} from "@/lib/sessions/log-writer";
import fs from "fs";
import os from "os";
import path from "path";

describe("SessionLogWriter", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "arij-logwriter-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates the log directory if it does not exist", () => {
    const nestedDir = path.join(tmpDir, "nested", "deep");
    const filePath = path.join(nestedDir, "logs.ndjson");
    const writer = new SessionLogWriter("s1", filePath);
    writer.writeHeader();
    expect(fs.existsSync(nestedDir)).toBe(true);
  });

  it("writes a session header as the first entry", () => {
    const filePath = path.join(tmpDir, "logs.ndjson");
    const writer = new SessionLogWriter("s1", filePath);
    writer.writeHeader({ promptLength: 100 });

    const entries = readLogEntries(filePath);
    expect(entries).toHaveLength(1);
    expect(entries[0]._type).toBe("session_start");
    expect(entries[0].sessionId).toBe("s1");
    expect(entries[0].seq).toBe(0);
    expect(entries[0].promptLength).toBe(100);
  });

  it("appends entries with monotonically increasing sequence numbers", () => {
    const filePath = path.join(tmpDir, "logs.ndjson");
    const writer = new SessionLogWriter("s2", filePath);
    writer.writeHeader();
    writer.append("raw", { data: "first" });
    writer.append("raw", { data: "second" });
    writer.append("raw", { data: "third" });

    const entries = readLogEntries(filePath);
    expect(entries).toHaveLength(4); // header + 3 entries
    expect(entries[0].seq).toBe(0);
    expect(entries[1].seq).toBe(1);
    expect(entries[2].seq).toBe(2);
    expect(entries[3].seq).toBe(3);
  });

  it("includes sessionId in every entry", () => {
    const filePath = path.join(tmpDir, "logs.ndjson");
    const writer = new SessionLogWriter("my-session", filePath);
    writer.writeHeader();
    writer.append("raw", { data: "test" });

    const entries = readLogEntries(filePath);
    for (const entry of entries) {
      expect(entry.sessionId).toBe("my-session");
    }
  });

  it("includes timestamps in every entry", () => {
    const filePath = path.join(tmpDir, "logs.ndjson");
    const writer = new SessionLogWriter("s3", filePath);
    writer.writeHeader();
    writer.append("raw", { data: "test" });

    const entries = readLogEntries(filePath);
    for (const entry of entries) {
      expect(entry.ts).toBeDefined();
      expect(new Date(entry.ts).getTime()).not.toBeNaN();
    }
  });

  it("writes session end marker", () => {
    const filePath = path.join(tmpDir, "logs.ndjson");
    const writer = new SessionLogWriter("s4", filePath);
    writer.writeHeader();
    writer.append("raw", { data: "work" });
    writer.end({ status: "completed", durationMs: 5000 });

    const entries = readLogEntries(filePath);
    const lastEntry = entries[entries.length - 1];
    expect(lastEntry._type).toBe("session_end");
    expect(lastEntry.status).toBe("completed");
    expect(lastEntry.durationMs).toBe(5000);
  });

  it("writes session end marker with error", () => {
    const filePath = path.join(tmpDir, "logs.ndjson");
    const writer = new SessionLogWriter("s5", filePath);
    writer.writeHeader();
    writer.end({ status: "failed", error: "something broke", durationMs: 100 });

    const entries = readLogEntries(filePath);
    const lastEntry = entries[entries.length - 1];
    expect(lastEntry._type).toBe("session_end");
    expect(lastEntry.status).toBe("failed");
    expect(lastEntry.error).toBe("something broke");
  });

  it("tracks current sequence number", () => {
    const filePath = path.join(tmpDir, "logs.ndjson");
    const writer = new SessionLogWriter("s6", filePath);
    expect(writer.currentSeq).toBe(0);
    writer.writeHeader();
    expect(writer.currentSeq).toBe(1);
    writer.append("raw", { data: "test" });
    expect(writer.currentSeq).toBe(2);
  });
});

describe("readLogEntries()", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "arij-readlog-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns empty array for non-existent file", () => {
    expect(readLogEntries("/tmp/does-not-exist.ndjson")).toEqual([]);
  });

  it("returns empty array for empty file", () => {
    const filePath = path.join(tmpDir, "empty.ndjson");
    fs.writeFileSync(filePath, "");
    expect(readLogEntries(filePath)).toEqual([]);
  });

  it("skips malformed JSON lines", () => {
    const filePath = path.join(tmpDir, "bad.ndjson");
    const content = [
      JSON.stringify({ _type: "good", seq: 0, sessionId: "s1", ts: "2025-01-01T00:00:00Z" }),
      "not json",
      JSON.stringify({ _type: "good", seq: 2, sessionId: "s1", ts: "2025-01-01T00:00:02Z" }),
    ].join("\n");
    fs.writeFileSync(filePath, content);

    const entries = readLogEntries(filePath);
    expect(entries).toHaveLength(2);
  });

  it("sorts entries by sequence number", () => {
    const filePath = path.join(tmpDir, "unsorted.ndjson");
    const content = [
      JSON.stringify({ _type: "raw", seq: 3, sessionId: "s1", ts: "t3" }),
      JSON.stringify({ _type: "raw", seq: 1, sessionId: "s1", ts: "t1" }),
      JSON.stringify({ _type: "raw", seq: 2, sessionId: "s1", ts: "t2" }),
    ].join("\n");
    fs.writeFileSync(filePath, content);

    const entries = readLogEntries(filePath);
    expect(entries.map((e) => e.seq)).toEqual([1, 2, 3]);
  });
});

describe("getLogWriter() / releaseLogWriter()", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "arij-registry-"));
  });

  afterEach(() => {
    releaseLogWriter("test-session");
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns the same writer instance for the same sessionId", () => {
    const filePath = path.join(tmpDir, "logs.ndjson");
    const writer1 = getLogWriter("test-session", filePath);
    const writer2 = getLogWriter("test-session", filePath);
    expect(writer1).toBe(writer2);
  });

  it("returns different writer instances for different sessionIds", () => {
    const writer1 = getLogWriter("session-a", path.join(tmpDir, "a.ndjson"));
    const writer2 = getLogWriter("session-b", path.join(tmpDir, "b.ndjson"));
    expect(writer1).not.toBe(writer2);
    releaseLogWriter("session-a");
    releaseLogWriter("session-b");
  });

  it("creates a new writer after release", () => {
    const filePath = path.join(tmpDir, "logs.ndjson");
    const writer1 = getLogWriter("test-session", filePath);
    releaseLogWriter("test-session");
    const writer2 = getLogWriter("test-session", filePath);
    expect(writer1).not.toBe(writer2);
  });
});

describe("Parallel session ingestion", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "arij-parallel-"));
  });

  afterEach(() => {
    releaseLogWriter("session-1");
    releaseLogWriter("session-2");
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("maintains separate sequence counters for different sessions", () => {
    const file1 = path.join(tmpDir, "s1.ndjson");
    const file2 = path.join(tmpDir, "s2.ndjson");

    const writer1 = getLogWriter("session-1", file1);
    const writer2 = getLogWriter("session-2", file2);

    writer1.writeHeader();
    writer2.writeHeader();

    // Interleave writes
    writer1.append("raw", { data: "s1-1" });
    writer2.append("raw", { data: "s2-1" });
    writer1.append("raw", { data: "s1-2" });
    writer2.append("raw", { data: "s2-2" });
    writer1.append("raw", { data: "s1-3" });

    const entries1 = readLogEntries(file1);
    const entries2 = readLogEntries(file2);

    // Verify isolation: s1 has 4 entries (header + 3), s2 has 3 (header + 2)
    expect(entries1).toHaveLength(4);
    expect(entries2).toHaveLength(3);

    // Verify all s1 entries have sessionId "session-1"
    for (const e of entries1) {
      expect(e.sessionId).toBe("session-1");
    }

    // Verify all s2 entries have sessionId "session-2"
    for (const e of entries2) {
      expect(e.sessionId).toBe("session-2");
    }

    // Verify sequence numbers are monotonic within each session
    const seqs1 = entries1.map((e) => e.seq);
    const seqs2 = entries2.map((e) => e.seq);
    expect(seqs1).toEqual([0, 1, 2, 3]);
    expect(seqs2).toEqual([0, 1, 2]);
  });

  it("no log chunk is attached to the wrong session", () => {
    const file1 = path.join(tmpDir, "s1.ndjson");
    const file2 = path.join(tmpDir, "s2.ndjson");

    const writer1 = getLogWriter("session-1", file1);
    const writer2 = getLogWriter("session-2", file2);

    writer1.writeHeader();
    writer2.writeHeader();

    // Simulate rapid concurrent writes
    for (let i = 0; i < 50; i++) {
      writer1.append("raw", { data: `s1-chunk-${i}` });
      writer2.append("raw", { data: `s2-chunk-${i}` });
    }

    writer1.end({ status: "completed", durationMs: 1000 });
    writer2.end({ status: "completed", durationMs: 2000 });

    const entries1 = readLogEntries(file1);
    const entries2 = readLogEntries(file2);

    // All entries in file1 belong to session-1
    for (const e of entries1) {
      expect(e.sessionId).toBe("session-1");
    }

    // All entries in file2 belong to session-2
    for (const e of entries2) {
      expect(e.sessionId).toBe("session-2");
    }

    // Verify counts: header + 50 raw + end = 52 each
    expect(entries1).toHaveLength(52);
    expect(entries2).toHaveLength(52);
  });
});
