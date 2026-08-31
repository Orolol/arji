/**
 * The pure half of the LIVE LOG: the line grammar, the per-chunk elapsed
 * stamp and the mini-bar scale. No React, no fetch — these are the three
 * decisions the terminal card makes about data it is handed.
 */
import { describe, expect, it } from "vitest";

import {
  BAR_MAX_PX,
  classifyLogLine,
  elapsedStamp,
  scaleDiffBar,
  splitInlineDelta,
} from "@/components/session-live/log-lines";

describe("classifyLogLine", () => {
  it("reads a shell command off its $ prefix and strips it", () => {
    expect(classifyLogLine("$ npx vitest run sse")).toEqual({
      kind: "command",
      body: "npx vitest run sse",
    });
  });

  it("reads a completed step off its check glyph", () => {
    expect(classifyLogLine("✓ read spec.md")).toEqual({
      kind: "done",
      body: "read spec.md",
    });
  });

  it("reads a summary line off its middle dot", () => {
    expect(classifyLogLine("· 34 passed, 0 failed")).toEqual({
      kind: "summary",
      body: "34 passed, 0 failed",
    });
  });

  it("classifies failures, keeping the line whole", () => {
    expect(classifyLogLine("Error: ENOENT")).toEqual({
      kind: "error",
      body: "Error: ENOENT",
    });
    expect(classifyLogLine("✗ 2 failed")).toEqual({
      kind: "error",
      body: "✗ 2 failed",
    });
    expect(classifyLogLine("fatal: not a git repository").kind).toBe("error");
  });

  it("does not mistake a word that merely starts with 'error' for a failure", () => {
    expect(classifyLogLine("Errors: 0").kind).toBe("plain");
  });

  it("leaves anything it is not sure about plain, body unchanged", () => {
    expect(classifyLogLine("worker 2/4")).toEqual({
      kind: "plain",
      body: "worker 2/4",
    });
    expect(classifyLogLine("")).toEqual({ kind: "plain", body: "" });
  });

  it("tolerates leading whitespace", () => {
    expect(classifyLogLine("   ✓ read spec.md")).toEqual({
      kind: "done",
      body: "read spec.md",
    });
    expect(classifyLogLine("  $ ls").kind).toBe("command");
  });

  it("never returns the live kind — the caller assigns that", () => {
    for (const line of ["$ ls", "✓ ok", "· 1 passed", "Error: x", "plain"]) {
      expect(classifyLogLine(line).kind).not.toBe("live");
    }
  });
});

describe("elapsedStamp", () => {
  const START = "2026-08-28T14:02:11.000Z";

  function at(secondsLater: number): string {
    return new Date(Date.parse(START) + secondsLater * 1000).toISOString();
  }

  it("formats mm:ss, zero-padded on both halves", () => {
    expect(elapsedStamp(START, at(252))).toBe("04:12");
    expect(elapsedStamp(START, at(8))).toBe("00:08");
  });

  it("lets minutes run past two digits", () => {
    expect(elapsedStamp(START, at(6127))).toBe("102:07");
  });

  it("returns null when either end is missing or unparseable", () => {
    expect(elapsedStamp(null, at(10))).toBeNull();
    expect(elapsedStamp(START, null)).toBeNull();
    expect(elapsedStamp(START, "not a date")).toBeNull();
  });

  it("returns null for a negative delta rather than a bogus stamp", () => {
    expect(elapsedStamp(START, at(-5))).toBeNull();
  });

  it("reads SQLite's zone-less CURRENT_TIMESTAMP as UTC, not local", () => {
    // `agent_session_chunks.created_at` is written as "YYYY-MM-DD HH:MM:SS" in
    // UTC. Parsed as local time it would be a whole timezone offset away from
    // the session's ISO started_at, and east of Greenwich every stamp would
    // come out negative and disappear.
    expect(elapsedStamp(START, "2026-08-28 14:06:23")).toBe("04:12");
  });
});

describe("scaleDiffBar", () => {
  it("gives the largest file the full bar, split by its own ratio", () => {
    const { addedPx, removedPx } = scaleDiffBar(142, 18, 160);
    expect(addedPx + removedPx).toBeLessThanOrEqual(BAR_MAX_PX);
    expect(addedPx).toBeGreaterThan(removedPx * 4);
    expect(removedPx).toBeGreaterThan(0);
  });

  it("scales a smaller file against the largest total", () => {
    expect(scaleDiffBar(87, 0, 160)).toEqual({ addedPx: 28, removedPx: 0 });
  });

  it("draws nothing for a file with no counted change", () => {
    expect(scaleDiffBar(0, 0, 160)).toEqual({ addedPx: 0, removedPx: 0 });
  });

  it("never divides by zero when nothing in the list has a total", () => {
    expect(scaleDiffBar(0, 0, 0)).toEqual({ addedPx: 0, removedPx: 0 });
    expect(scaleDiffBar(12, 3, 0)).toEqual({ addedPx: 0, removedPx: 0 });
  });

  it("keeps a one-line change visible against a very large maximum", () => {
    const { addedPx, removedPx } = scaleDiffBar(1, 0, 5000);
    expect(addedPx).toBeGreaterThanOrEqual(1);
    expect(removedPx).toBe(0);
  });

  it("keeps both sides visible when each has a count", () => {
    const { addedPx, removedPx } = scaleDiffBar(1, 1, 5000);
    expect(addedPx).toBeGreaterThanOrEqual(1);
    expect(removedPx).toBeGreaterThanOrEqual(1);
    expect(addedPx + removedPx).toBeLessThanOrEqual(BAR_MAX_PX);
  });
});

describe("splitInlineDelta", () => {
  it("lifts a trailing +N off a log line", () => {
    expect(splitInlineDelta("edit lib/sse/stream.ts +96")).toEqual({
      text: "edit lib/sse/stream.ts",
      added: 96,
      removed: null,
    });
  });

  it("lifts a trailing +N −M pair, minus sign included", () => {
    expect(splitInlineDelta("edit lib/sse/stream.ts +46 −18")).toEqual({
      text: "edit lib/sse/stream.ts",
      added: 46,
      removed: 18,
    });
  });

  it("leaves a line with no trailing counts alone", () => {
    expect(splitInlineDelta("npx vitest run sse --reporter=dot")).toEqual({
      text: "npx vitest run sse --reporter=dot",
      added: null,
      removed: null,
    });
  });
});
