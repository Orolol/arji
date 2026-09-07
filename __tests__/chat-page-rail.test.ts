/**
 * The pure derivations behind the chat page's roster line and its CONTEXTE
 * rail (frame 11a).
 *
 * The rule they all serve: a figure we do not have is an em-dash, never a zero,
 * and never a number this page did not measure.
 */

import { describe, expect, it } from "vitest";
import { createTranslator } from "next-intl";

import {
  citedDocuments,
  formatTokens,
  mentionedNames,
  tokensOf,
} from "@/components/chat-page/chat-context-tokens";
import { shortPlacement } from "@/components/chat-page/placement";
import { messagesFor } from "@/lib/i18n";
import { formatRelative } from "@/lib/i18n/format";

/**
 * The rail's note is composed outside React from full dotted KEY REFERENCES,
 * so `shortPlacement` takes the NAMESPACE-LESS translator as an argument
 * (lib/i18n/catalogue.ts) — here a bare `createTranslator` over the same
 * catalogue the page reads through `useTranslations()`.
 */
const t = createTranslator({ locale: "en", messages: messagesFor("en") });

const NOW = Date.parse("2026-08-30T12:00:00.000Z");

function ago(ms: number): string {
  return new Date(NOW - ms).toISOString();
}

/**
 * The roster's age is the shared `formatRelative` now (the local French
 * `relativeAge` is gone). Under the French seed it prints the same
 * `il y a 4 min` / `il y a 3 h` / `à l'instant` as before; the ONE deliberate
 * change is the day band, where the roster used to say `hier` / `3d` while
 * every other screen said `il y a 1 j` / `2d ago` — one family, one shape.
 */
describe("roster age (formatRelative, fr)", () => {
  const fr = (iso: string | null) => formatRelative(iso, { locale: "fr", now: NOW });

  it("prints the frame's own shapes", () => {
    expect(fr(ago(4 * 60_000))).toBe("il y a 4 min");
    expect(fr(ago(26 * 3_600_000))).toBe("il y a 1 j");
    expect(fr(ago(3 * 86_400_000))).toBe("il y a 3 j");
  });

  it("degrades to `à l'instant` under a minute", () => {
    expect(fr(ago(5_000))).toBe("à l'instant");
  });

  it("says hours between one hour and one day", () => {
    expect(fr(ago(3 * 3_600_000))).toBe("il y a 3 h");
  });

  it("treats clock skew as `just now`, never a negative age", () => {
    expect(fr(new Date(NOW + 30_000).toISOString())).toBe("à l'instant");
  });

  it("is empty — an em-dash upstream — for a timestamp it cannot read", () => {
    expect(fr(null)).toBe("");
    expect(fr("not a date")).toBe("");
  });

  it("prints the English family under en", () => {
    expect(formatRelative(ago(4 * 60_000), { locale: "en", now: NOW })).toBe("4m ago");
    expect(formatRelative(ago(3 * 86_400_000), { locale: "en", now: NOW })).toBe("3d ago");
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
    expect(shortPlacement("todo", 4, t)).toBe("To Do #4");
    expect(shortPlacement("backlog", null, t)).toBe("Backlog");
  });

  it("is null — an em-dash — when nothing resolved", () => {
    expect(shortPlacement(null, null, t)).toBeNull();
  });
});
