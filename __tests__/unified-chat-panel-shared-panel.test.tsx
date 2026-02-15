import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { UnifiedChatPanel } from "@/components/chat/UnifiedChatPanel";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

vi.mock("@/hooks/useConversations", () => ({
  useConversations: () => ({
    conversations: [
      {
        id: "conv-1",
        projectId: "proj-1",
        type: "brainstorm",
        label: "Brainstorm",
        status: "active",
        epicId: null,
        provider: "claude-code",
        createdAt: "2026-02-01T00:00:00.000Z",
      },
    ],
    activeId: "conv-1",
    setActiveId: vi.fn(),
    createConversation: vi.fn(),
    updateConversation: vi.fn(),
    deleteConversation: vi.fn(),
    refresh: vi.fn(),
    loading: false,
  }),
}));

vi.mock("@/hooks/useChat", () => ({
  useChat: () => ({
    messages: [],
    loading: false,
    sending: false,
    pendingQuestions: null,
    streamStatus: null,
    sendMessage: vi.fn(),
    answerQuestions: vi.fn(),
    error: null,
  }),
}));

vi.mock("@/hooks/useEpicCreate", () => ({
  useEpicCreate: () => ({
    createEpic: vi.fn(),
    isLoading: false,
    error: null,
  }),
}));

vi.mock("@/components/chat/MessageList", () => ({
  MessageList: () => <div data-testid="message-list" />,
}));

vi.mock("@/components/chat/MessageInput", () => ({
  MessageInput: () => <div data-testid="message-input" />,
}));

vi.mock("@/components/chat/QuestionCards", () => ({
  QuestionCards: () => null,
}));

function BoardFixture() {
  const [clickCount, setClickCount] = useState(0);

  return (
    <button
      data-testid="board-interaction"
      onClick={() => setClickCount((count) => count + 1)}
    >
      board-{clickCount}
    </button>
  );
}

describe("UnifiedChatPanel shared panel mode", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    window.localStorage.clear();
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      writable: true,
      value: 1200,
    });
  });

  it("renders shared panel without a modal sheet and keeps board interactive", async () => {
    render(
      <UnifiedChatPanel
        projectId="proj-1"
        sharedPanelView={{
          panelId: "epic-1",
          label: "Ticket",
          content: <div data-testid="ticket-detail-content">Ticket detail</div>,
        }}
      >
        <BoardFixture />
      </UnifiedChatPanel>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("unified-panel-shared")).toBeInTheDocument();
    });

    expect(screen.queryByTestId("unified-panel-mobile-sheet")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("board-interaction"));
    expect(screen.getByText("board-1")).toBeInTheDocument();
    expect(screen.getByTestId("ticket-detail-content")).toBeInTheDocument();
  });

  it("stays non-modal on mobile when shared panel is active", async () => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      writable: true,
      value: 500,
    });

    render(
      <UnifiedChatPanel
        projectId="proj-1"
        sharedPanelView={{
          panelId: "epic-1",
          label: "Ticket",
          content: <div>Ticket detail</div>,
        }}
      >
        <BoardFixture />
      </UnifiedChatPanel>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("unified-panel-shared")).toBeInTheDocument();
    });

    expect(screen.queryByTestId("unified-panel-mobile-sheet")).not.toBeInTheDocument();
  });

  it("uses the target detail width behavior derived from clamp(420px, 34vw, 560px)", async () => {
    render(
      <UnifiedChatPanel
        projectId="proj-1"
        sharedPanelView={{
          panelId: "epic-1",
          label: "Ticket",
          content: <div>Ticket detail</div>,
        }}
      >
        <BoardFixture />
      </UnifiedChatPanel>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("unified-panel-shared")).toBeInTheDocument();
    });

    expect(screen.getByTestId("unified-panel-shared")).toHaveStyle({
      width: "420px",
    });
  });
});
