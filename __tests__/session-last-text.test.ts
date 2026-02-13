import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  extractLastNonEmptyLine,
  extractLastNonEmptyFromLogs,
  getSessionLastText,
} from "@/lib/sessions/last-text";
import fs from "fs";
import os from "os";
import path from "path";

describe("extractLastNonEmptyLine()", () => {
  it("returns null for null input", () => {
    expect(extractLastNonEmptyLine(null)).toBeNull();
  });

  it("returns null for undefined input", () => {
    expect(extractLastNonEmptyLine(undefined)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(extractLastNonEmptyLine("")).toBeNull();
  });

  it("returns null for whitespace-only string", () => {
    expect(extractLastNonEmptyLine("   \n  \n   \t  ")).toBeNull();
  });

  it("returns the single line of a one-line string", () => {
    expect(extractLastNonEmptyLine("hello world")).toBe("hello world");
  });

  it("returns the last non-empty line of multi-line text", () => {
    expect(extractLastNonEmptyLine("line one\nline two\nline three")).toBe(
      "line three"
    );
  });

  it("skips trailing empty lines", () => {
    expect(extractLastNonEmptyLine("first\nsecond\n\n\n")).toBe("second");
  });

  it("trims whitespace from the result", () => {
    expect(extractLastNonEmptyLine("  hello  \n  world  \n  ")).toBe("world");
  });

  it("truncates very long lines with ellipsis", () => {
    const longLine = "a".repeat(200);
    const result = extractLastNonEmptyLine(longLine, 120);
    expect(result).toHaveLength(120);
    expect(result!.endsWith("...")).toBe(true);
  });

  it("does not truncate lines at exactly maxLength", () => {
    const line = "a".repeat(120);
    expect(extractLastNonEmptyLine(line, 120)).toBe(line);
  });

  it("does not truncate lines shorter than maxLength", () => {
    expect(extractLastNonEmptyLine("short", 120)).toBe("short");
  });

  it("respects custom maxLength", () => {
    const line = "abcdefghij"; // 10 chars
    const result = extractLastNonEmptyLine(line, 5);
    expect(result).toBe("ab...");
  });

  it("handles lines with only whitespace characters mixed in", () => {
    expect(extractLastNonEmptyLine("\t\n  \n\t  content  \n\t")).toBe("content");
  });

  it("handles Windows-style line endings", () => {
    expect(extractLastNonEmptyLine("line1\r\nline2\r\n\r\n")).toBe("line2");
  });

  it("handles text with special characters", () => {
    expect(extractLastNonEmptyLine("line1\nconst x = { a: 1 };")).toBe(
      "const x = { a: 1 };"
    );
  });
});

describe("extractLastNonEmptyFromLogs()", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "arij-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns null for null logsPath", () => {
    expect(extractLastNonEmptyFromLogs(null)).toBeNull();
  });

  it("returns null for undefined logsPath", () => {
    expect(extractLastNonEmptyFromLogs(undefined)).toBeNull();
  });

  it("returns null for non-existent file", () => {
    expect(extractLastNonEmptyFromLogs("/tmp/does-not-exist.json")).toBeNull();
  });

  it("extracts text from NDJSON raw entries", () => {
    const logFile = path.join(tmpDir, "logs.ndjson");
    const entries = [
      JSON.stringify({ _type: "session_start", ts: "2025-01-01T00:00:00Z", seq: 0, sessionId: "s1" }),
      JSON.stringify({ _type: "raw", ts: "2025-01-01T00:00:01Z", seq: 1, sessionId: "s1", data: "first output" }),
      JSON.stringify({ _type: "raw", ts: "2025-01-01T00:00:02Z", seq: 2, sessionId: "s1", data: "second output" }),
    ];
    fs.writeFileSync(logFile, entries.join("\n") + "\n");

    expect(extractLastNonEmptyFromLogs(logFile)).toBe("second output");
  });

  it("skips blank data entries", () => {
    const logFile = path.join(tmpDir, "logs.ndjson");
    const entries = [
      JSON.stringify({ _type: "session_start", ts: "2025-01-01T00:00:00Z", seq: 0, sessionId: "s1" }),
      JSON.stringify({ _type: "raw", ts: "2025-01-01T00:00:01Z", seq: 1, sessionId: "s1", data: "real output" }),
      JSON.stringify({ _type: "raw", ts: "2025-01-01T00:00:02Z", seq: 2, sessionId: "s1", data: "   " }),
    ];
    fs.writeFileSync(logFile, entries.join("\n") + "\n");

    expect(extractLastNonEmptyFromLogs(logFile)).toBe("real output");
  });

  it("extracts error from session_end entries", () => {
    const logFile = path.join(tmpDir, "logs.ndjson");
    const entries = [
      JSON.stringify({ _type: "session_start", ts: "2025-01-01T00:00:00Z", seq: 0, sessionId: "s1" }),
      JSON.stringify({ _type: "session_end", ts: "2025-01-01T00:00:01Z", seq: 1, sessionId: "s1", error: "Something failed" }),
    ];
    fs.writeFileSync(logFile, entries.join("\n") + "\n");

    expect(extractLastNonEmptyFromLogs(logFile)).toBe("Something failed");
  });

  it("extracts text entries", () => {
    const logFile = path.join(tmpDir, "logs.ndjson");
    const entries = [
      JSON.stringify({ _type: "session_start", ts: "2025-01-01T00:00:00Z", seq: 0, sessionId: "s1" }),
      JSON.stringify({ _type: "stderr", ts: "2025-01-01T00:00:01Z", text: "warning message" }),
    ];
    fs.writeFileSync(logFile, entries.join("\n") + "\n");

    expect(extractLastNonEmptyFromLogs(logFile)).toBe("warning message");
  });

  it("handles plain JSON result files (build route format)", () => {
    const logFile = path.join(tmpDir, "logs.json");
    fs.writeFileSync(
      logFile,
      JSON.stringify({ success: true, result: "Build completed successfully.\n\nAll tests passed.", duration: 5000 })
    );

    expect(extractLastNonEmptyFromLogs(logFile)).toBe("All tests passed.");
  });

  it("handles plain JSON with error", () => {
    const logFile = path.join(tmpDir, "logs.json");
    fs.writeFileSync(
      logFile,
      JSON.stringify({ success: false, error: "Compilation failed", duration: 1000 })
    );

    expect(extractLastNonEmptyFromLogs(logFile)).toBe("Compilation failed");
  });

  it("handles empty file", () => {
    const logFile = path.join(tmpDir, "empty.ndjson");
    fs.writeFileSync(logFile, "");

    expect(extractLastNonEmptyFromLogs(logFile)).toBeNull();
  });

  it("handles malformed JSON lines gracefully", () => {
    const logFile = path.join(tmpDir, "bad.ndjson");
    const content = [
      "not valid json",
      JSON.stringify({ _type: "raw", data: "valid entry" }),
      "{broken json",
    ].join("\n");
    fs.writeFileSync(logFile, content);

    expect(extractLastNonEmptyFromLogs(logFile)).toBe("valid entry");
  });

  it("handles file with only session_start entry", () => {
    const logFile = path.join(tmpDir, "start-only.ndjson");
    fs.writeFileSync(
      logFile,
      JSON.stringify({ _type: "session_start", ts: "2025-01-01T00:00:00Z", seq: 0, sessionId: "s1" }) + "\n"
    );

    expect(extractLastNonEmptyFromLogs(logFile)).toBeNull();
  });
});

describe("getSessionLastText()", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "arij-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("prefers resultText over log file", () => {
    const logFile = path.join(tmpDir, "logs.json");
    fs.writeFileSync(
      logFile,
      JSON.stringify({ success: true, result: "log result", duration: 1000 })
    );

    expect(getSessionLastText(logFile, "direct result")).toBe("direct result");
  });

  it("falls back to log file when resultText is null", () => {
    const logFile = path.join(tmpDir, "logs.json");
    fs.writeFileSync(
      logFile,
      JSON.stringify({ success: true, result: "log result", duration: 1000 })
    );

    expect(getSessionLastText(logFile, null)).toBe("log result");
  });

  it("falls back to log file when resultText is empty", () => {
    const logFile = path.join(tmpDir, "logs.json");
    fs.writeFileSync(
      logFile,
      JSON.stringify({ success: true, result: "log result", duration: 1000 })
    );

    expect(getSessionLastText(logFile, "")).toBe("log result");
  });

  it("returns null when both sources are empty", () => {
    expect(getSessionLastText(null, null)).toBeNull();
  });

  it("returns null when resultText is whitespace and no log file", () => {
    expect(getSessionLastText(null, "   \n  ")).toBeNull();
  });
});
