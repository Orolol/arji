/**
 * The pure derivations behind the chat page's roster line and its CONTEXTE
 * rail (frame 11a).
 *
 * The rule they all serve: a figure we do not have is an em-dash, never a zero,
 * and never a number this page did not measure.
 */

import { describe, expect, it } from "vitest";

import {
  citedDocuments,
  formatTokens,
  mentionedNames,
  tokensOf,
} from "@/components/chat-page/chat-context-tokens";
import { relativeAge } from "@/components/chat-page/relative-age";
import { shortPlacement } from "@/components/chat-page/placement";

const NOW = Date.parse("2026-08-30T12:00:00.000Z");

function ago(ms: number): string {
  return new Date(NOW - ms).toISOString();
}

describe("relativeAge", () => {
  it("prints the frame's own shapes", () => {
    expect(relativeAge(ago(4 * 60_000), NOW)).toBe("il y a 4 min");
    expect(relativeAge(ago(26 * 3_600_000), NOW)).toBe("hier");
    expect(relativeAge(ago(3 * 86_400_000), NOW)).toBe("3d");
  });

  it("degrades to `à l'instant` under a minute", () => {
    expect(relativeAge(ago(5_000), NOW)).toBe("à l'instant");
  });

  it("says hours between one hour and one day", () => {
    expect(relativeAge(ago(3 * 3_600_000), NOW)).toBe("il y a 3 h");
  });

  it("treats clock skew as `just now`, never a negative age", () => {
    expect(relativeAge(new Date(NOW + 30_000).toISOString(), NOW)).toBe(
      "à l'instant",
    );
  });

  it("returns null — an em-dash upstream — for a timestamp it cannot read", () => {
    expect(relativeAge(null, NOW)).toBeNull();
    expect(relativeAge("not a date", NOW)).toBeNull();
  });
});

describe("token figures", () => {
  it("formats the frame's `3.1k` / `0.8k`", () => {
    expect(formatTokens(3100)).toBe("3.1k");
    expect(formatTokens(800)).toBe("0.8k");
  });

  it("is an em-dash for a gap, never `0.0k`", () => {
    expect(formatTokens(null)).toBe("—");
    expect(formatTokens(0)).toBe("—");
  });

  it("treats absent and empty content as the same data gap", () => {
    expect(tokensOf(null)).toBeNull();
    expect(tokensOf("")).toBeNull();
    expect(tokensOf("   \n ")).toBeNull();
    expect(tokensOf("a".repeat(400))).toBe(100);
  });
});

describe("which documents a conversation cites", () => {
  it("reads both mention shapes the composer writes", () => {
    expect(mentionedNames("regarde @dispatch-flow.md et @{mon doc.md}")).toEqual([
      "dispatch-flow.md",
      "mon doc.md",
    ]);
  });

  it("ignores an e-mail-looking run that is not a mention", () => {
    expect(mentionedNames("écris à moi@example.com")).toEqual([]);
  });

  const documents = [
    { id: "d1", originalFilename: "dispatch-flow.md", markdownContent: "x".repeat(3200) },
    { id: "d2", originalFilename: "notes.md", markdownContent: "y" },
  ];

  it("counts only the docs the USER cited", () => {
    const cited = citedDocuments(
      [
        { role: "user", content: "voir @dispatch-flow.md" },
        // The agent quoting a doc back did not add it to the prompt.
        { role: "assistant", content: "je regarde @notes.md" },
      ],
      documents,
    );

    expect(cited.map((doc) => doc.id)).toEqual(["d1"]);
  });

  it("matches the filename case-insensitively", () => {
    const cited = citedDocuments(
      [{ role: "user", content: "voir @Dispatch-Flow.md" }],
      documents,
    );
    expect(cited.map((doc) => doc.id)).toEqual(["d1"]);
  });

  it("returns nothing when the conversation cites nothing", () => {
    expect(citedDocuments([{ role: "user", content: "rien" }], documents)).toEqual(
      [],
    );
  });
});

describe("the rail's short placement", () => {
  it("prints the frame's `To Do #4` and `Backlog`", () => {
    expect(shortPlacement("todo", 4)).toBe("To Do #4");
    expect(shortPlacement("backlog", null)).toBe("Backlog");
  });

  it("is null — an em-dash — when nothing resolved", () => {
    expect(shortPlacement(null, null)).toBeNull();
  });
});
