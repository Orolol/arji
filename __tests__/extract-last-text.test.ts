import { describe, expect, it, vi, beforeEach } from "vitest";
import { extractLastNonEmptyText } from "@/lib/utils/extract-last-text";
import fs from "fs";

vi.mock("fs");

const mockedFs = vi.mocked(fs);

describe("extractLastNonEmptyText", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns null for null logsPath", () => {
    expect(extractLastNonEmptyText(null)).toBeNull();
  });

  it("returns null for non-existent file", () => {
    mockedFs.existsSync.mockReturnValue(false);
    expect(extractLastNonEmptyText("/tmp/does-not-exist.json")).toBeNull();
  });

  it("extracts last non-empty text from JSON array with text field", () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(
      JSON.stringify([
        { text: "First message" },
        { text: "Second message" },
        { text: "" },
      ]),
    );

    expect(extractLastNonEmptyText("/tmp/log.json")).toBe("Second message");
  });

  it("extracts last non-empty text from JSON array with content field", () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(
      JSON.stringify([
        { content: "Hello" },
        { content: "World" },
      ]),
    );

    expect(extractLastNonEmptyText("/tmp/log.json")).toBe("World");
  });

  it("extracts last non-empty text from JSON array with message field", () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(
      JSON.stringify([
        { message: "Processing..." },
        { message: "Done!" },
      ]),
    );

    expect(extractLastNonEmptyText("/tmp/log.json")).toBe("Done!");
  });

  it("handles string entries in JSON array", () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(
      JSON.stringify(["First line", "Last line"]),
    );

    expect(extractLastNonEmptyText("/tmp/log.json")).toBe("Last line");
  });

  it("skips entries with empty or whitespace-only text", () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(
      JSON.stringify([
        { text: "Useful content" },
        { text: "" },
        { text: "   " },
      ]),
    );

    expect(extractLastNonEmptyText("/tmp/log.json")).toBe("Useful content");
  });

  it("returns null for empty JSON array", () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue("[]");

    expect(extractLastNonEmptyText("/tmp/log.json")).toBeNull();
  });

  it("returns null when JSON is not an array", () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue('{"key": "value"}');

    expect(extractLastNonEmptyText("/tmp/log.json")).toBeNull();
  });

  it("falls back to line-based parsing for invalid JSON", () => {
    mockedFs.existsSync.mockReturnValue(true);
    // First call fails JSON.parse, second call in fallback reads lines
    mockedFs.readFileSync.mockReturnValue(
      "first line\nsecond line\nlast line\n",
    );

    expect(extractLastNonEmptyText("/tmp/log.txt")).toBe("last line");
  });

  it("handles JSONL format in fallback", () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(
      '{"text":"line one"}\n{"text":"line two"}\n',
    );

    expect(extractLastNonEmptyText("/tmp/log.jsonl")).toBe("line two");
  });

  it("trims extracted text", () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(
      JSON.stringify([{ text: "  trimmed text  " }]),
    );

    expect(extractLastNonEmptyText("/tmp/log.json")).toBe("trimmed text");
  });
});
