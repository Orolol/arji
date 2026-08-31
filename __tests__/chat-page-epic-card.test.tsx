/**
 * The drafted-epic card, in the thread (frame 11a).
 *
 * The point of the screen: a ticket the agent wrote arrives as an actionable
 * card, attached to the message that wrote it, and STAYS actionable — Send to
 * dev works from history, days later, on a card that is not the last message.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { DraftedEpicCard } from "@/components/chat-page/DraftedEpicCard";
import { ChatThread } from "@/components/chat-page/ChatThread";
import { epicsByMessageId } from "@/components/chat-page/message-epics";
import { longPlacement } from "@/components/chat-page/placement";
import type { ChatMessage } from "@/hooks/useChat";
import type { ParsedEpic } from "@/lib/epic-parsing";

const EPIC: ParsedEpic = {
  title: "Spec diff view before agent dispatch",
  description: "Snapshot the spec, guard the dispatch.",
  userStories: [
    {
      title: "Snapshot the spec hash on epic creation",
      description: null,
      acceptanceCriteria: "- [ ] hash stored\n- [ ] shown in the overlay",
    },
    {
      title: "Dispatch guard: diff snapshot vs current spec",
      description: null,
      acceptanceCriteria: "- [ ] diff computed\n- [ ] asks on drift\n- [ ] logged",
    },
    {
      title: "Full Auto: pause the ticket instead of asking",
      description: null,
      acceptanceCriteria: "- [ ] paused\n- [ ] logged",
    },
  ],
};

const fetchMock = vi.fn();

function renderCard(overrides: Partial<React.ComponentProps<typeof DraftedEpicCard>> = {}) {
  const props = {
    projectId: "p1",
    epic: EPIC,
    tone: 1 as const,
    epicId: null,
    readableId: null,
    placement: null,
    namedAgentId: null,
    onCreated: vi.fn(),
    onOpenTicket: vi.fn(),
    onToast: vi.fn(),
    ...overrides,
  };
  render(<DraftedEpicCard {...props} />);
  return props;
}

function ok(body: unknown, status = 200) {
  return { ok: true, status, json: () => Promise.resolve(body) };
}

/**
 * jsdom ships no ResizeObserver, and the Radix ScrollArea the thread mounts in
 * constructs one on layout. `useFeedAutoScroll` also observes both boxes — the
 * stub is what lets the thread render at all; the scroll behaviour itself is
 * pinned by `__tests__/use-feed-auto-scroll.test.tsx`.
 */
class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  globalThis.ResizeObserver ??=
    NoopResizeObserver as unknown as typeof ResizeObserver;
  vi.clearAllMocks();
  fetchMock.mockReset();
  global.fetch = fetchMock as unknown as typeof fetch;
});

describe("DraftedEpicCard — what it prints", () => {
  it("renders the stamp, the title, one row per story and the counters", () => {
    renderCard();

    expect(screen.getByText("EPIC · DRAFT")).toBeInTheDocument();
    expect(
      screen.getByText("Spec diff view before agent dispatch"),
    ).toBeInTheDocument();
    expect(screen.getAllByTestId("chat-epic-story")).toHaveLength(3);
    expect(screen.getByText("3 stories · 7 AC")).toBeInTheDocument();
    expect(screen.getAllByText("2 AC")).toHaveLength(2);
    expect(screen.getByText("3 AC")).toBeInTheDocument();
  });

  it("omits the AC counter rather than printing a zero", () => {
    renderCard({
      epic: {
        title: "One story, no criteria",
        description: "",
        userStories: [
          { title: "Do the thing", description: null, acceptanceCriteria: null },
        ],
      },
    });

    expect(screen.getByText("1 stories")).toBeInTheDocument();
    expect(screen.queryByText("0 AC")).toBeNull();
    expect(screen.queryByText(/· 0 AC/)).toBeNull();
  });

  it("shows an em-dash rather than inventing an id or a placement", () => {
    renderCard();
    // The id chip and the placement note are both unresolved here.
    expect(screen.getAllByText("—")).toHaveLength(2);
  });

  it("drops `· DRAFT` and prints the placement once an id exists", () => {
    renderCard({
      epicId: "e1",
      readableId: "ARJ-143",
      placement: longPlacement("todo", 3),
    });

    expect(screen.getByText("EPIC")).toBeInTheDocument();
    expect(screen.queryByText("EPIC · DRAFT")).toBeNull();
    expect(screen.getByText("ARJ-143")).toBeInTheDocument();
    expect(screen.getByText("créé dans To Do · #3")).toBeInTheDocument();
  });
});

describe("DraftedEpicCard — the three actions", () => {
  it("Send to dev creates the ticket in To Do, then dispatches the build", async () => {
    const props = renderCard();
    fetchMock
      .mockResolvedValueOnce(ok({ data: { id: "e9", readableId: "ARJ-9" } }, 201))
      .mockResolvedValueOnce(ok({ data: { sessionId: "s1" } }));

    await userEvent.click(screen.getByRole("button", { name: "Send to dev" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    expect(fetchMock.mock.calls[0][0]).toBe("/api/projects/p1/epics");
    const created = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(created.status).toBe("todo");
    expect(created.title).toBe("Spec diff view before agent dispatch");
    expect(created.userStories).toHaveLength(3);

    // Create THEN dispatch: the builder's prompt must see the ticket.
    expect(fetchMock.mock.calls[1][0]).toBe("/api/projects/p1/epics/e9/build");

    expect(props.onCreated).toHaveBeenCalledWith({
      epicId: "e9",
      readableId: "ARJ-9",
      status: "todo",
    });
    expect(props.onToast).toHaveBeenCalledWith("success", "Envoyé en dev");
  });

  it("a card already bound to a ticket skips the create and only dispatches", async () => {
    renderCard({ epicId: "e1", readableId: "ARJ-1" });
    fetchMock.mockResolvedValueOnce(ok({ data: { sessionId: "s1" } }));

    await userEvent.click(screen.getByRole("button", { name: "Send to dev" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0][0]).toBe("/api/projects/p1/epics/e1/build");
  });

  it("forwards the composer's named agent to the build dispatch", async () => {
    renderCard({ epicId: "e1", namedAgentId: "agent-7" });
    fetchMock.mockResolvedValueOnce(ok({ data: { sessionId: "s1" } }));

    await userEvent.click(screen.getByRole("button", { name: "Send to dev" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      namedAgentId: "agent-7",
    });
  });

  it("a rejected create raises the route's error and leaves the card actionable", async () => {
    const props = renderCard();
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: () => Promise.resolve({ error: "Title is required" }),
    });

    await userEvent.click(screen.getByRole("button", { name: "Send to dev" }));

    await waitFor(() =>
      expect(props.onToast).toHaveBeenCalledWith("error", "Title is required"),
    );
    // No dispatch on a failed create, and a retry must cost one click.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Send to dev" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Backlog" })).toBeEnabled();
  });

  it("Backlog creates in the backlog and never dispatches a build", async () => {
    const props = renderCard();
    fetchMock.mockResolvedValueOnce(ok({ data: { id: "e4" } }, 201));

    await userEvent.click(screen.getByRole("button", { name: "Backlog" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0][0]).toBe("/api/projects/p1/epics");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).status).toBe("backlog");
    expect(
      fetchMock.mock.calls.some((call) => String(call[0]).endsWith("/build")),
    ).toBe(false);
    expect(props.onToast).toHaveBeenCalledWith(
      "success",
      "Epic créé dans le backlog",
    );
  });

  it("Backlog is refused once the card is bound to a ticket", () => {
    renderCard({ epicId: "e1" });
    expect(screen.getByRole("button", { name: "Backlog" })).toBeDisabled();
  });

  it("Edit stories opens the ticket overlay on the bound epic", async () => {
    const props = renderCard({ epicId: "e1" });

    await userEvent.click(screen.getByRole("button", { name: "Edit stories" }));

    expect(props.onOpenTicket).toHaveBeenCalledWith("e1");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("Edit stories creates the ticket first when there is none", async () => {
    const props = renderCard();
    fetchMock.mockResolvedValueOnce(ok({ data: { id: "e5" } }, 201));

    await userEvent.click(screen.getByRole("button", { name: "Edit stories" }));

    await waitFor(() => expect(props.onOpenTicket).toHaveBeenCalledWith("e5"));
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).status).toBe("backlog");
  });
});

describe("the card stays actionable from history", () => {
  const JSON_EPIC = `\`\`\`json
{
  "title": "Spec diff view before agent dispatch",
  "userStories": [
    { "title": "Snapshot the spec hash", "acceptanceCriteria": ["stored"] }
  ]
}
\`\`\``;

  const messages: ChatMessage[] = [
    {
      id: "m1",
      projectId: "p1",
      role: "user",
      content: "Je veux un diff de la spec.",
      createdAt: "2026-08-30T09:00:00.000Z",
    },
    {
      id: "m2",
      projectId: "p1",
      role: "assistant",
      content: JSON_EPIC,
      createdAt: "2026-08-30T09:01:00.000Z",
    },
    {
      id: "m3",
      projectId: "p1",
      role: "user",
      content: "Parfait, ajoute une story.",
      createdAt: "2026-08-30T09:02:00.000Z",
    },
    {
      id: "m4",
      projectId: "p1",
      role: "assistant",
      content: "Je mets à jour l'epic.",
      createdAt: "2026-08-30T09:03:00.000Z",
    },
  ];

  it("dispatches from a card whose message is not the last one", async () => {
    fetchMock
      .mockResolvedValueOnce(ok({ data: { id: "e9" } }, 201))
      .mockResolvedValueOnce(ok({ data: { sessionId: "s1" } }));

    render(
      <ChatThread
        projectId="p1"
        messages={messages}
        loading={false}
        sending={false}
        streamStatus={null}
        agentLabel="Opus Planner"
        sendStartedAt={null}
        epicsByMessage={epicsByMessageId(messages)}
        epicIdByMessage={new Map()}
        resolveTicket={() => ({ readableId: null, placement: null })}
        tone={1}
        namedAgentId={null}
        onEpicCreated={vi.fn()}
        onOpenTicket={vi.fn()}
        onToast={vi.fn()}
        pendingQuestions={null}
        onAnswerQuestions={vi.fn()}
        busy={false}
        emptyMessage="empty"
      />,
    );

    const card = screen.getByTestId("chat-epic-card");
    await userEvent.click(
      within(card).getByRole("button", { name: "Send to dev" }),
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls[0][0]).toBe("/api/projects/p1/epics");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).status).toBe("todo");
    expect(fetchMock.mock.calls[1][0]).toBe("/api/projects/p1/epics/e9/build");
  });
});

describe("placement notes", () => {
  it("prints the queue rank when the desk has one", () => {
    expect(longPlacement("todo", 3)).toBe("créé dans To Do · #3");
    expect(longPlacement("backlog", null)).toBe("créé dans Backlog");
  });

  it("is null — an em-dash — when the desk has no row", () => {
    expect(longPlacement(null, null)).toBeNull();
    expect(longPlacement(undefined, 3)).toBeNull();
  });

  it("never prints a rank it does not have", () => {
    expect(longPlacement("todo", null)).toBe("créé dans To Do");
  });
});
