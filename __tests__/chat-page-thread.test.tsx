/**
 * The chat page's transcript (frame 11a, centre column).
 *
 * Two things here are guards rather than assertions about pixels: the thread
 * MUST live inside a Radix ScrollArea (`useFeedAutoScroll` is a silent no-op
 * outside one, and the feed would open on its oldest message with nothing
 * failing anywhere), and an empty assistant placeholder MUST render as the
 * typing bubble rather than as an empty white card.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

import { ChatThread } from "@/components/chat-page/ChatThread";
import type { ChatMessage } from "@/hooks/useChat";
import type { QuestionData } from "@/lib/claude/spawn";

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  // jsdom has no ResizeObserver; the Radix ScrollArea constructs one.
  globalThis.ResizeObserver ??=
    NoopResizeObserver as unknown as typeof ResizeObserver;
  vi.clearAllMocks();
});

function message(overrides: Partial<ChatMessage> & { id: string }): ChatMessage {
  return {
    projectId: "p1",
    role: "user",
    content: "",
    createdAt: "2026-08-30T09:00:00.000Z",
    ...overrides,
  };
}

function renderThread(
  overrides: Partial<React.ComponentProps<typeof ChatThread>> = {},
) {
  const props: React.ComponentProps<typeof ChatThread> = {
    projectId: "p1",
    messages: [],
    loading: false,
    sending: false,
    streamStatus: null,
    agentLabel: "Opus Planner",
    sendStartedAt: null,
    epicsByMessage: new Map(),
    epicIdByMessage: new Map(),
    resolveTicket: () => ({ readableId: null, placement: null }),
    tone: 1,
    namedAgentId: null,
    onEpicCreated: vi.fn(),
    onOpenTicket: vi.fn(),
    onToast: vi.fn(),
    pendingQuestions: null,
    onAnswerQuestions: vi.fn(),
    busy: false,
    emptyMessage: "Start a conversation to brainstorm your project with Claude",
    ...overrides,
  };
  return render(<ChatThread {...props} />);
}

describe("ChatThread", () => {
  it("puts your words on the pool ground and the agent's on a white card", () => {
    const { container } = renderThread({
      messages: [
        message({ id: "m1", role: "user", content: "Avant de dispatcher…" }),
        message({ id: "m2", role: "assistant", content: "Bonne friction." }),
      ],
    });

    const user = container.querySelector('[data-role="user"]');
    const assistant = container.querySelector('[data-role="assistant"]');

    expect(user).not.toBeNull();
    expect(user?.className).toContain("bg-strata-next");
    expect(assistant).not.toBeNull();
    expect(assistant?.className).toContain("bg-card");
  });

  it("names the agent in the bubble kicker, uppercased", () => {
    renderThread({
      messages: [message({ id: "m1", role: "assistant", content: "Voici." })],
      agentLabel: "Opus Planner",
    });

    expect(screen.getByText("OPUS PLANNER")).toBeInTheDocument();
  });

  it("renders the typing bubble — not an empty card — for the streaming placeholder", () => {
    const { container } = renderThread({
      sending: true,
      sendStartedAt: "2026-08-30T09:00:00.000Z",
      messages: [
        message({ id: "m1", role: "user", content: "Ajoute une story." }),
        // The empty assistant placeholder `useChat` pushes for the delta
        // accumulator to target.
        message({ id: "m2", role: "assistant", content: "" }),
      ],
    });

    const typing = screen.getByTestId("chat-typing");
    expect(typing).toBeInTheDocument();
    expect(typing).toHaveTextContent("Opus Planner rédige…");
    expect(
      typing.querySelector('[data-slot="breathing-dot"]'),
    ).not.toBeNull();
    // Exactly one assistant node: the typing bubble, and no empty white card.
    expect(container.querySelectorAll('[data-role="assistant"]')).toHaveLength(1);
  });

  it("prefers the server's own status line when the stream sent one", () => {
    renderThread({
      sending: true,
      streamStatus: "Analyse de la spec…",
      messages: [message({ id: "m2", role: "assistant", content: "" })],
    });

    expect(screen.getByTestId("chat-typing")).toHaveTextContent(
      "Analyse de la spec…",
    );
  });

  it("drops the placeholder entirely once the stream is closed", () => {
    const { container } = renderThread({
      sending: false,
      messages: [message({ id: "m2", role: "assistant", content: "" })],
    });

    expect(screen.queryByTestId("chat-typing")).toBeNull();
    expect(container.querySelectorAll('[data-role="assistant"]')).toHaveLength(0);
  });

  it("renders the question cards, disabled while the conversation is busy", () => {
    const questions: QuestionData[] = [
      {
        header: "Scope",
        question: "Which surface?",
        multiSelect: false,
        options: [
          { label: "Board", description: "the kanban" },
          { label: "Chat", description: "the thread" },
        ],
      },
    ];

    renderThread({ pendingQuestions: questions, busy: true });

    expect(screen.getByTestId("chat-questions")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Board/ })).toBeDisabled();
  });

  it("collapses epic, spec and chat errors into one coral hairline", () => {
    renderThread({ error: "Stream request failed" });

    const errors = screen.getAllByTestId("chat-error");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toHaveTextContent("Stream request failed");
    expect(errors[0].className).toContain("border-destructive/50");
  });

  it("says the empty-conversation line rather than nothing at all", () => {
    renderThread({
      emptyMessage:
        "Describe your epic idea and I'll help you structure it with user stories and acceptance criteria.",
    });

    expect(
      screen.getByText(
        "Describe your epic idea and I'll help you structure it with user stories and acceptance criteria.",
      ),
    ).toBeInTheDocument();
  });

  it("mounts the feed inside a Radix scroll viewport", () => {
    // The guard against silently breaking `useFeedAutoScroll`: it walks up to
    // this attribute and does nothing at all when it is not there.
    const { container } = renderThread({
      messages: [message({ id: "m1", role: "user", content: "hello" })],
    });

    const viewport = container.querySelector(
      "[data-radix-scroll-area-viewport]",
    );
    const content = screen.getByTestId("chat-thread-content");

    expect(viewport).not.toBeNull();
    expect(viewport?.contains(content)).toBe(true);
  });
});
