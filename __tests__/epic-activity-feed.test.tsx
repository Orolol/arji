/**
 * Ticket activity feed — the PURE half.
 *
 * The `EpicActivityFeed` component was removed with the rest of the old
 * three-tab ticket panel when frame 6a landed; its logic was rescued verbatim
 * into `lib/kanban/activity-feed.ts` and is what this file now covers:
 * chronological interleaving of comments and transitions, the collapsing of
 * consecutive system transitions, the kind filter, and long-comment previews
 * (which the overlay's CommentBubble uses).
 *
 * The render-only cases (actor styling, session links, the filter chrome, the
 * pinned composer) went with the component they described.
 */
import { describe, it, expect } from "vitest";
import {
  buildActivityFeed,
  SYSTEM_GROUP_WINDOW_MS,
  feedItemKind,
  matchesActivityFilter,
  filterActivityFeed,
  isLongComment,
  commentPreview,
  LONG_COMMENT_THRESHOLD,
} from "@/lib/kanban/activity-feed";
import type { TicketComment } from "@/hooks/useTicketComments";
import type { EpicActivityEntry } from "@/hooks/useEpicActivity";

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

function comment(
  id: string,
  createdAt: string,
  overrides: Partial<TicketComment> = {}
): TicketComment {
  return {
    id,
    epicId: "e1",
    author: "user",
    content: `comment ${id}`,
    agentSessionId: null,
    createdAt,
    ...overrides,
  };
}

function transition(
  id: string,
  createdAt: string,
  overrides: Partial<EpicActivityEntry> = {}
): EpicActivityEntry {
  return {
    id,
    projectId: "p1",
    epicId: "e1",
    fromStatus: "todo",
    toStatus: "in_progress",
    actor: "user",
    reason: null,
    sessionId: null,
    createdAt,
    ...overrides,
  };
}

/** ISO timestamp `offsetMs` after a fixed base instant. */
function at(offsetMs: number): string {
  return new Date(
    new Date("2026-08-16T10:00:00.000Z").getTime() + offsetMs
  ).toISOString();
}

/* ------------------------------------------------------------------ */
/* buildActivityFeed                                                   */
/* ------------------------------------------------------------------ */

describe("buildActivityFeed", () => {
  it("interleaves comments and transitions oldest first", () => {
    const feed = buildActivityFeed(
      [comment("c1", at(1000)), comment("c2", at(3000))],
      // API order is newest first; the feed must still sort chronologically
      [transition("t2", at(2000)), transition("t1", at(0))]
    );

    expect(feed.map((i) => i.kind)).toEqual([
      "transition",
      "comment",
      "transition",
      "comment",
    ]);
    expect(
      feed.map((i) => (i.kind === "comment" ? i.comment.id : (i as { entry: { id: string } }).entry.id))
    ).toEqual(["t1", "c1", "t2", "c2"]);
  });

  it("collapses 2+ consecutive system transitions within the window", () => {
    const feed = buildActivityFeed(
      [],
      [
        transition("s1", at(0), { actor: "system" }),
        transition("s2", at(1000), { actor: "system" }),
        transition("s3", at(2000), { actor: "system" }),
      ]
    );

    expect(feed).toHaveLength(1);
    expect(feed[0].kind).toBe("transition-group");
    expect(
      (feed[0] as { entries: EpicActivityEntry[] }).entries.map((e) => e.id)
    ).toEqual(["s1", "s2", "s3"]);
  });

  it("does not group a single system transition", () => {
    const feed = buildActivityFeed([], [transition("s1", at(0), { actor: "system" })]);
    expect(feed.map((i) => i.kind)).toEqual(["transition"]);
  });

  it("breaks a system run when the gap exceeds the window", () => {
    const feed = buildActivityFeed(
      [],
      [
        transition("s1", at(0), { actor: "system" }),
        transition("s2", at(1000), { actor: "system" }),
        transition("s3", at(1000 + SYSTEM_GROUP_WINDOW_MS + 1), {
          actor: "system",
        }),
      ]
    );

    expect(feed.map((i) => i.kind)).toEqual(["transition-group", "transition"]);
  });

  it("breaks a system run when a comment or non-system transition interleaves", () => {
    const feed = buildActivityFeed(
      [comment("c1", at(500))],
      [
        transition("s1", at(0), { actor: "system" }),
        transition("s2", at(1000), { actor: "system" }),
        transition("a1", at(2000), { actor: "agent" }),
        transition("s3", at(3000), { actor: "system" }),
      ]
    );

    // s1 / s2 are split by the comment, so no run reaches length 2
    expect(feed.map((i) => i.kind)).toEqual([
      "transition",
      "comment",
      "transition",
      "transition",
      "transition",
    ]);
  });
});

/* ------------------------------------------------------------------ */
/* Kind classification and filtering                                   */
/* ------------------------------------------------------------------ */

describe("activity feed kinds", () => {
  it("classifies feed items by kind for the filter", () => {
    const feed = buildActivityFeed(
      [comment("c1", at(0))],
      [
        transition("t1", at(1000), { actor: "system" }),
        transition("t2", at(2000), {
          actor: "system",
          reason: "Pipeline finished: review passed, awaiting approval",
        }),
      ]
    );
    expect(feed.map(feedItemKind)).toEqual(["comment", "system", "system"]);
  });

  it("filters feed items by kind without reordering", () => {
    const feed = buildActivityFeed(
      [comment("c1", at(1000))],
      [
        transition("t1", at(0), { actor: "system" }),
        transition("t2", at(2000), { actor: "user" }),
      ]
    );

    expect(filterActivityFeed(feed, "all")).toHaveLength(3);
    expect(filterActivityFeed(feed, "comments").map(feedItemKind)).toEqual([
      "comment",
    ]);
    expect(
      filterActivityFeed(feed, "system").map((item) =>
        item.kind === "transition" ? item.entry.id : item.kind
      )
    ).toEqual(["t1", "t2"]);
    expect(matchesActivityFilter(feed[0], "comments")).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* Long entry collapsing                                               */
/* ------------------------------------------------------------------ */

describe("long comment helpers", () => {
  it("treats content at the threshold as long and below it as short", () => {
    expect(isLongComment("x".repeat(LONG_COMMENT_THRESHOLD))).toBe(true);
    expect(isLongComment("x".repeat(LONG_COMMENT_THRESHOLD - 1))).toBe(false);
  });

  it("truncates on a word boundary with an ellipsis, without mid-word cuts", () => {
    const content = `aaa bbb ccc ddd ${"word ".repeat(100)}END`;
    const preview = commentPreview(content);

    expect(preview.length).toBeLessThan(content.length);
    expect(preview.endsWith("…")).toBe(true);
    // No fragment of a cut word: the preview is whole words plus the dot.
    const body = preview.slice(0, -1).trimEnd();
    expect(body.endsWith(" ")).toBe(false);
    const lastWord = body.split(" ").at(-1);
    expect(content).toContain(lastWord);
  });

  it("returns short content unchanged", () => {
    expect(commentPreview("small note")).toBe("small note");
  });
});
