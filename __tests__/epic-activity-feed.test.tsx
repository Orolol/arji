/**
 * Tests for the unified epic activity feed: chronological interleaving of
 * comments and kanban transitions, actor styling, session links, and the
 * collapsing of consecutive system transitions.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import {
  EpicActivityFeed,
  buildActivityFeed,
  SYSTEM_GROUP_WINDOW_MS,
  feedItemKind,
  matchesActivityFilter,
  filterActivityFeed,
  isLongComment,
  commentPreview,
  LONG_COMMENT_THRESHOLD,
} from "@/components/kanban/epic-detail/EpicActivityFeed";
import type { TicketComment } from "@/hooks/useTicketComments";
import type { EpicActivityEntry } from "@/hooks/useEpicActivity";
import { MCP_CREATE_BUG_ACTIVITY_PREFIX } from "@/lib/mcp/create-bug-contract";

const mockUseEpicActivity = vi.hoisted(() => vi.fn());

vi.mock("@/hooks/useEpicActivity", () => ({
  useEpicActivity: (...args: unknown[]) => mockUseEpicActivity(...args),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/components/documents/MentionTextarea", () => ({
  MentionTextarea: (props: { value: string; placeholder?: string }) => (
    <textarea
      data-testid="mention-textarea"
      value={props.value}
      placeholder={props.placeholder}
      readOnly
    />
  ),
}));

vi.mock("@/components/chat/MarkdownContent", () => ({
  MarkdownContent: ({ content }: { content: string }) => <div>{content}</div>,
}));

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

function renderFeed(
  entries: EpicActivityEntry[],
  comments: TicketComment[] = []
) {
  mockUseEpicActivity.mockReturnValue({
    entries,
    loading: false,
    refresh: vi.fn(),
  });
  return render(
    <EpicActivityFeed
      projectId="p1"
      epicId="e1"
      comments={comments}
      commentsLoading={false}
      onAddComment={vi.fn()}
    />
  );
}

const FEED_ITEM_SELECTOR =
  '[data-testid="activity-comment"], [data-testid="activity-transition"], [data-testid="activity-bug-created"], [data-testid="activity-transition-group"]';

beforeEach(() => {
  vi.clearAllMocks();
});

/* ------------------------------------------------------------------ */
/* buildActivityFeed (pure)                                            */
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
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

describe("EpicActivityFeed", () => {
  it("renders comments and transitions interleaved in chronological order", () => {
    const { container } = renderFeed(
      [transition("t1", at(1000), { actor: "agent" })],
      [comment("c1", at(0)), comment("c2", at(2000))]
    );

    const kinds = Array.from(
      container.querySelectorAll(FEED_ITEM_SELECTOR)
    ).map((el) => el.getAttribute("data-testid"));
    expect(kinds).toEqual([
      "activity-comment",
      "activity-transition",
      "activity-comment",
    ]);
  });

  it("styles actors distinctly and shows status chips, reason and relative time", () => {
    renderFeed([
      transition("t1", at(0), { actor: "agent", reason: "Build started" }),
      transition("t2", at(SYSTEM_GROUP_WINDOW_MS * 5), {
        actor: "user",
        fromStatus: "in_progress",
        toStatus: "review",
      }),
    ]);

    const rows = screen.getAllByTestId("activity-transition");
    expect(rows.map((r) => r.getAttribute("data-actor"))).toEqual([
      "agent",
      "user",
    ]);
    expect(screen.getByText("Agent")).toBeInTheDocument();
    expect(screen.getByText("You")).toBeInTheDocument();
    expect(screen.getByText("Build started")).toBeInTheDocument();
    // Status chips use the kanban column labels
    expect(screen.getByText("To Do")).toBeInTheDocument();
    expect(screen.getAllByText("In Progress").length).toBeGreaterThan(0);
    expect(screen.getByText("Review")).toBeInTheDocument();
    // Relative timestamps
    expect(rows[0].textContent).toMatch(/ago|just now/);
  });

  it("links to the session when sessionId is set", () => {
    renderFeed([
      transition("t1", at(0), { actor: "agent", sessionId: "sess-42" }),
      transition("t2", at(SYSTEM_GROUP_WINDOW_MS * 5), { actor: "user" }),
    ]);

    const links = screen.getAllByTestId("activity-session-link");
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute(
      "href",
      "/projects/p1/sessions/sess-42"
    );
  });

  it("renders an agent-created bug as a sourced creation, not a no-op move", () => {
    const sessionId = "session-that-reported-the-bug";
    renderFeed([
      transition("created", at(0), {
        actor: "agent",
        fromStatus: "backlog",
        toStatus: "backlog",
        sessionId,
        reason: `${MCP_CREATE_BUG_ACTIVITY_PREFIX} reported from E-arij-014; source session ${sessionId}`,
      }),
    ]);

    const row = screen.getByTestId("activity-bug-created");
    expect(row).toHaveTextContent("Agent");
    expect(row).toHaveTextContent("created this bug");
    expect(row).toHaveTextContent("reported from E-arij-014");
    expect(row).not.toHaveTextContent("moved");
    expect(screen.queryByTestId("activity-transition")).not.toBeInTheDocument();
    expect(screen.getByText("View source session")).toHaveAttribute(
      "href",
      `/projects/p1/sessions/${sessionId}`,
    );
  });

  it("collapses consecutive system transitions and expands them on click", () => {
    renderFeed([
      transition("s1", at(0), { actor: "system" }),
      transition("s2", at(1000), { actor: "system" }),
      transition("s3", at(2000), { actor: "system" }),
    ]);

    expect(screen.queryAllByTestId("activity-transition")).toHaveLength(0);
    const group = screen.getByTestId("activity-transition-group");
    expect(group.textContent).toContain("3 automatic transitions");

    fireEvent.click(group);
    expect(screen.getAllByTestId("activity-transition")).toHaveLength(3);

    fireEvent.click(group);
    expect(screen.queryAllByTestId("activity-transition")).toHaveLength(0);
  });

  it("shows the total activity count and an empty state", () => {
    renderFeed([transition("t1", at(0))], [comment("c1", at(1000))]);
    expect(screen.getByText("Activity (2)")).toBeInTheDocument();
  });

  it("renders an empty state when there is no activity", () => {
    renderFeed([], []);
    expect(
      screen.getByText("No activity yet. Start the conversation.")
    ).toBeInTheDocument();
  });
});

/* ------------------------------------------------------------------ */
/* System vs. comment distinction (ticket-display overhaul, story 3)   */
/* ------------------------------------------------------------------ */

describe("EpicActivityFeed — system vs comment distinction", () => {
  it("tags comments and system events with a machine-readable kind", () => {
    const { container } = renderFeed(
      [transition("t1", at(1000), { actor: "system" })],
      [comment("c1", at(0))]
    );

    expect(
      container
        .querySelector('[data-testid="activity-comment"]')
        ?.getAttribute("data-kind")
    ).toBe("comment");
    expect(
      container
        .querySelector('[data-testid="activity-transition"]')
        ?.getAttribute("data-kind")
    ).toBe("system");
  });

  it("tags pipeline rows and collapsed transition groups as system", () => {
    const { container } = renderFeed([
      transition("s1", at(0), { actor: "system" }),
      transition("s2", at(1000), { actor: "system" }),
      transition("s3", at(2000), {
        actor: "system",
        reason: "Pipeline finished: review passed, awaiting approval",
      }),
    ]);

    expect(
      container
        .querySelector('[data-testid="activity-pipeline"]')
        ?.getAttribute("data-kind")
    ).toBe("system");
    // The 2-transition burst collapsed into a group that is system-kind.
    const group = container.querySelector(
      '[data-testid="activity-transition-group"]'
    );
    expect(group?.closest('[data-kind="system"]')).toBe(group?.parentElement);
  });

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
});

/* ------------------------------------------------------------------ */
/* Kind filter                                                         */
/* ------------------------------------------------------------------ */

describe("EpicActivityFeed — kind filter", () => {
  it("shows counts per kind and filters comments / system events separately", () => {
    renderFeed(
      [
        transition("t1", at(1000), { actor: "user" }),
        transition("t2", at(2000), { actor: "system" }),
      ],
      [comment("c1", at(0))]
    );

    expect(screen.getByTestId("activity-filter-all")).toHaveTextContent("All (3)");
    expect(screen.getByTestId("activity-filter-comments")).toHaveTextContent(
      "Comments (1)"
    );
    expect(screen.getByTestId("activity-filter-system")).toHaveTextContent(
      "System (2)"
    );

    // Comments only.
    fireEvent.click(screen.getByTestId("activity-filter-comments"));
    expect(screen.getAllByTestId("activity-comment")).toHaveLength(1);
    expect(screen.queryAllByTestId("activity-transition")).toHaveLength(0);

    // System only.
    fireEvent.click(screen.getByTestId("activity-filter-system"));
    expect(screen.queryAllByTestId("activity-comment")).toHaveLength(0);
    expect(screen.getAllByTestId("activity-transition")).toHaveLength(2);

    // Back to everything.
    fireEvent.click(screen.getByTestId("activity-filter-all"));
    expect(screen.getAllByTestId("activity-comment")).toHaveLength(1);
    expect(screen.getAllByTestId("activity-transition")).toHaveLength(2);
  });

  it("shows an explanatory empty state when the filter matches nothing", () => {
    renderFeed([transition("t1", at(0))], []);

    fireEvent.click(screen.getByTestId("activity-filter-comments"));
    expect(screen.getByTestId("activity-filter-empty")).toBeInTheDocument();
    expect(
      screen.queryByText("No activity yet. Start the conversation.")
    ).not.toBeInTheDocument();
  });

  it("keeps chronological order inside the filtered view", () => {
    const { container } = renderFeed(
      [transition("t1", at(3000), { actor: "system" })],
      [
        comment("c1", at(0)),
        comment("c2", at(1000)),
        comment("c3", at(2000)),
      ]
    );

    fireEvent.click(screen.getByTestId("activity-filter-comments"));
    const order = Array.from(
      container.querySelectorAll('[data-testid="activity-comment"]')
    ).map((el) => el.textContent);
    expect(order[0]).toContain("comment c1");
    expect(order[1]).toContain("comment c2");
    expect(order[2]).toContain("comment c3");
  });

  it("computes grouping on the full feed, then filters (heavy bursts stay collapsed)", () => {
    // 10 system transitions + 1 comment placed before the burst.
    const entries = Array.from({ length: 10 }, (_, i) =>
      transition(`s${i}`, at(i * 1000), { actor: "system" })
    );
    const { container } = renderFeed(entries, [comment("c1", at(-1000))]);

    // 10 transitions collapse into one group; the burst stays one row even
    // under the system filter.
    fireEvent.click(screen.getByTestId("activity-filter-system"));
    const rows = container.querySelectorAll(FEED_ITEM_SELECTOR);
    expect(rows).toHaveLength(1);
    expect(
      container.querySelector('[data-testid="activity-transition-group"]')
    ).toHaveTextContent("10 automatic transitions");
  });
});

/* ------------------------------------------------------------------ */
/* Long entry collapsing                                               */
/* ------------------------------------------------------------------ */

const LONG_COMMENT = `HEAD-MARKER ${"lorem ipsum dolor sit amet ".repeat(20)}TAIL-MARKER`;

describe("EpicActivityFeed — long entry collapsing", () => {
  it("collapses a long comment behind a word-boundary preview, expandable on demand", () => {
    renderFeed([], [comment("c1", at(0), { content: LONG_COMMENT })]);

    // The preview shows the head and hides the tail.
    expect(screen.getByTestId("activity-comment")).toHaveTextContent(
      "HEAD-MARKER"
    );
    expect(screen.queryByText(/TAIL-MARKER/)).toBeNull();

    const expand = screen.getByTestId("activity-comment-expand");
    expect(expand).toHaveTextContent("Show more");
    fireEvent.click(expand);

    expect(screen.getByText(/TAIL-MARKER/)).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("activity-comment-collapse"));
    expect(screen.queryByText(/TAIL-MARKER/)).toBeNull();
  });

  it("leaves short comments fully visible without an expand control", () => {
    renderFeed([], [comment("c1", at(0), { content: "short build note" })]);

    expect(screen.getByTestId("activity-comment")).toHaveTextContent(
      "short build note"
    );
    expect(screen.queryByTestId("activity-comment-expand")).toBeNull();
  });

  it("keeps the comment composer pinned outside the scrolling feed", () => {
    renderFeed(
      Array.from({ length: 30 }, (_, i) =>
        transition(`t${i}`, at(i * 1000), { actor: "system" })
      ),
      [comment("c1", at(-1000))]
    );

    const textarea = screen.getByTestId("mention-textarea");
    const viewport = document.querySelector(
      '[data-slot="scroll-area-viewport"]'
    );
    expect(viewport).not.toBeNull();
    expect(viewport).not.toContainElement(textarea);
  });
});

describe("long comment helpers (pure)", () => {
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
