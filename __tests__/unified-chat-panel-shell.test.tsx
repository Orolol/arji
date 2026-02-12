import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

let conversationCounter = 2;
let mockConversations = [
  {
    id: "conv1",
    projectId: "proj1",
    type: "brainstorm",
    label: "This is a very long brainstorm conversation title",
    status: "active",
    epicId: null,
    provider: "claude-code",
    createdAt: "2024-01-01",
  },
];
let mockActiveId: string | null = "conv1";
const mockSetActiveId = vi.fn((id: string | null) => {
  mockActiveId = id;
});
const mockCreateConversation = vi.fn(async (input?: { type?: string; label?: string }) => {
  const id = `conv${conversationCounter}`;
  conversationCounter += 1;
  const conversation = {
    id,
    projectId: "proj1",
    type: input?.type || "brainstorm",
    label: input?.label || "Brainstorm",
    status: "active",
    epicId: null,
    provider: "claude-code",
    createdAt: new Date().toISOString(),
  };
  mockConversations = [...mockConversations, conversation];
  mockActiveId = conversation.id;
  return conversation;
});
const mockUpdateConversation = vi.fn();
const mockRefreshConversations = vi.fn();
const mockDeleteConversation = vi.fn();

vi.mock("@/hooks/useConversations", () => ({
  useConversations: () => ({
    conversations: mockConversations,
    activeId: mockActiveId,
    setActiveId: mockSetActiveId,
    createConversation: mockCreateConversation,
    updateConversation: mockUpdateConversation,
    deleteConversation: mockDeleteConversation,
    refresh: mockRefreshConversations,
    loading: false,
  }),
}));

let mockMessages: Array<{ id: string; projectId: string; role: "user" | "assistant"; content: string; createdAt: string }> = [];
const mockSendMessage = vi.fn();

vi.mock("@/hooks/useChat", () => ({
  useChat: () => ({
    messages: mockMessages,
    loading: false,
    sending: false,
    pendingQuestions: null,
    streamStatus: null,
    sendMessage: mockSendMessage,
    answerQuestions: vi.fn(),
  }),
}));

vi.mock("@/hooks/useCodexAvailable", () => ({
  useCodexAvailable: () => ({ codexAvailable: true, codexInstalled: true }),
}));

vi.mock("@/components/chat/MessageList", () => ({
  MessageList: () => <div data-testid="message-list" />,
}));

vi.mock("@/components/chat/MessageInput", () => ({
  MessageInput: ({ disabled }: { disabled?: boolean }) => (
    <button data-testid="message-input" disabled={disabled}>
      input
    </button>
  ),
}));

vi.mock("@/components/chat/QuestionCards", () => ({
  QuestionCards: () => null,
}));

vi.mock("@/components/shared/ProviderSelect", () => ({
  ProviderSelect: ({ value }: { value: string }) => <div data-testid="provider-select">{value}</div>,
}));

import { UnifiedChatPanel } from "@/components/chat/UnifiedChatPanel";

describe("UnifiedChatPanel shell + tabs", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    window.localStorage.clear();

    conversationCounter = 2;
    mockConversations = [
      {
        id: "conv1",
        projectId: "proj1",
        type: "brainstorm",
        label: "This is a very long brainstorm conversation title",
        status: "active",
        epicId: null,
        provider: "claude-code",
        createdAt: "2024-01-01",
      },
    ];
    mockActiveId = "conv1";
    mockMessages = [];

    mockSetActiveId.mockClear();
    mockCreateConversation.mockClear();
    mockUpdateConversation.mockClear();
    mockRefreshConversations.mockClear();
    mockDeleteConversation.mockClear();

    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      writable: true,
      value: 1200,
    });
  });

  it("defaults to collapsed state with a visible chat strip", () => {
    render(
      <UnifiedChatPanel projectId="proj1">
        <div data-testid="board-content">board</div>
      </UnifiedChatPanel>,
    );

    expect(screen.getByTestId("board-content")).toBeInTheDocument();
    expect(screen.getByTestId("collapsed-chat-strip")).toBeInTheDocument();
    expect(screen.queryByTestId("unified-panel-expanded")).not.toBeInTheDocument();
  });

  it("expands when collapsed strip is clicked", () => {
    render(
      <UnifiedChatPanel projectId="proj1">
        <div>board</div>
      </UnifiedChatPanel>,
    );

    fireEvent.click(screen.getByTestId("collapsed-chat-strip"));

    expect(screen.getByTestId("unified-panel-expanded")).toBeInTheDocument();
    expect(screen.getByTestId("chat-tab-bar")).toBeInTheDocument();
    expect(screen.getByTestId("panel-divider")).toBeInTheDocument();
  });

  it("allows resizing via divider and persists ratio in localStorage", () => {
    render(
      <UnifiedChatPanel projectId="proj1">
        <div>board</div>
      </UnifiedChatPanel>,
    );

    fireEvent.click(screen.getByTestId("collapsed-chat-strip"));

    const divider = screen.getByTestId("panel-divider");
    fireEvent.mouseDown(divider);
    fireEvent.mouseMove(window, { clientX: 820 });
    fireEvent.mouseUp(window);

    const saved = window.localStorage.getItem("arij.unified-chat-panel.ratio.proj1");
    expect(saved).not.toBeNull();
    expect(Number(saved)).toBeGreaterThan(0.3);
    expect(Number(saved)).toBeLessThan(0.35);
  });

  it("resets divider ratio to default on double-click", () => {
    render(
      <UnifiedChatPanel projectId="proj1">
        <div>board</div>
      </UnifiedChatPanel>,
    );

    fireEvent.click(screen.getByTestId("collapsed-chat-strip"));

    const divider = screen.getByTestId("panel-divider");
    fireEvent.mouseDown(divider);
    fireEvent.mouseMove(window, { clientX: 880 });
    fireEvent.mouseUp(window);

    fireEvent.doubleClick(divider);

    const saved = window.localStorage.getItem("arij.unified-chat-panel.ratio.proj1");
    expect(saved).toBe("0.4000");
  });

  it("collapses panel when Escape is pressed", () => {
    render(
      <UnifiedChatPanel projectId="proj1">
        <div>board</div>
      </UnifiedChatPanel>,
    );

    fireEvent.click(screen.getByTestId("collapsed-chat-strip"));
    expect(screen.getByTestId("unified-panel-expanded")).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "Escape" });

    expect(screen.queryByTestId("unified-panel-expanded")).not.toBeInTheDocument();
    expect(screen.getByTestId("collapsed-chat-strip")).toBeInTheDocument();
  });

  it("renders tab bar with truncated title", () => {
    render(
      <UnifiedChatPanel projectId="proj1">
        <div>board</div>
      </UnifiedChatPanel>,
    );

    fireEvent.click(screen.getByTestId("collapsed-chat-strip"));

    expect(screen.getByTestId("conversation-tab-conv1")).toBeInTheDocument();
    expect(screen.getByText("This is a very long ...")).toBeInTheDocument();
    expect(screen.getByTestId("new-conversation-tab")).toBeInTheDocument();
  });

  it("creates a new tab with plus button and keeps newest tab on the right", async () => {
    render(
      <UnifiedChatPanel projectId="proj1">
        <div>board</div>
      </UnifiedChatPanel>,
    );

    fireEvent.click(screen.getByTestId("collapsed-chat-strip"));

    fireEvent.click(screen.getByTestId("new-conversation-tab"));

    await waitFor(() => {
      expect(mockCreateConversation).toHaveBeenCalledTimes(1);
    });

    const tabs = screen.getAllByTestId(/conversation-tab-/);
    expect(tabs).toHaveLength(2);
    expect(tabs[0].getAttribute("data-testid")).toBe("conversation-tab-conv1");
    expect(tabs[1].getAttribute("data-testid")).toBe("conversation-tab-conv2");
  });

  it("switches active conversation when tab is clicked", async () => {
    render(
      <UnifiedChatPanel projectId="proj1">
        <div>board</div>
      </UnifiedChatPanel>,
    );

    fireEvent.click(screen.getByTestId("collapsed-chat-strip"));
    fireEvent.click(screen.getByTestId("new-conversation-tab"));

    await waitFor(() => {
      expect(screen.getByTestId("conversation-tab-conv2")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId("conversation-tab-conv1"));

    expect(mockSetActiveId).toHaveBeenCalledWith("conv1");
  });

  it("closes tabs without deleting conversations and never allows closing the last tab", async () => {
    render(
      <UnifiedChatPanel projectId="proj1">
        <div>board</div>
      </UnifiedChatPanel>,
    );

    fireEvent.click(screen.getByTestId("collapsed-chat-strip"));
    fireEvent.click(screen.getByTestId("new-conversation-tab"));

    await waitFor(() => {
      expect(screen.getByTestId("close-tab-conv1")).toBeInTheDocument();
      expect(screen.getByTestId("close-tab-conv2")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId("close-tab-conv2"));

    await waitFor(() => {
      expect(screen.queryByTestId("conversation-tab-conv2")).not.toBeInTheDocument();
    });

    expect(mockDeleteConversation).not.toHaveBeenCalled();
    expect(screen.queryByTestId("close-tab-conv1")).not.toBeInTheDocument();
  });

  it("shows active agent indicator on tabs and collapsed strip", () => {
    mockConversations = [
      {
        id: "conv1",
        projectId: "proj1",
        type: "brainstorm",
        label: "Brainstorm",
        status: "generating",
        epicId: null,
        provider: "claude-code",
        createdAt: "2024-01-01",
      },
    ];

    render(
      <UnifiedChatPanel projectId="proj1">
        <div>board</div>
      </UnifiedChatPanel>,
    );

    expect(screen.getByTestId("collapsed-active-badge")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("collapsed-chat-strip"));

    expect(screen.getByTestId("active-indicator-conv1")).toBeInTheDocument();
  });

  it("polls conversation status every 3 seconds", async () => {
    vi.useFakeTimers();

    render(
      <UnifiedChatPanel projectId="proj1">
        <div>board</div>
      </UnifiedChatPanel>,
    );

    await vi.advanceTimersByTimeAsync(9000);

    expect(mockRefreshConversations).toHaveBeenCalledTimes(3);
  });
});
