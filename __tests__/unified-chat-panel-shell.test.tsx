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
const mockDeleteConversation = vi.fn(async (conversationId: string) => {
  mockConversations = mockConversations.filter((conversation) => conversation.id !== conversationId);
  if (mockActiveId === conversationId) {
    mockActiveId = mockConversations[0]?.id || null;
  }
});

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

let mockEpicCreateLoading = false;
const mockCreateEpic = vi.fn(async () => "epic-1");

vi.mock("@/hooks/useEpicCreate", () => ({
  useEpicCreate: () => ({
    createEpic: mockCreateEpic,
    isLoading: mockEpicCreateLoading,
    error: null,
    createdEpic: null,
  }),
}));

vi.mock("@/components/chat/MessageList", () => ({
  MessageList: () => <div data-testid="message-list" />,
}));

vi.mock("@/components/chat/MessageInput", () => ({
  MessageInput: ({ disabled, placeholder }: { disabled?: boolean; placeholder?: string }) => (
    <button data-testid="message-input" data-placeholder={placeholder} disabled={disabled}>
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
    mockEpicCreateLoading = false;

    mockSetActiveId.mockClear();
    mockCreateConversation.mockClear();
    mockUpdateConversation.mockClear();
    mockRefreshConversations.mockClear();
    mockDeleteConversation.mockClear();
    mockCreateEpic.mockClear();

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

  it("close tab deletes the conversation and keeps the last tab non-closable", async () => {
    const { unmount } = render(
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
      expect(mockDeleteConversation).toHaveBeenCalledWith("conv2");
    });

    unmount();
    render(
      <UnifiedChatPanel projectId="proj1">
        <div>board</div>
      </UnifiedChatPanel>,
    );

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

  it("marks tabs with conversation type metadata", () => {
    mockConversations = [
      {
        id: "conv1",
        projectId: "proj1",
        type: "epic_creation",
        label: "Epic refinement",
        status: "active",
        epicId: null,
        provider: "claude-code",
        createdAt: "2024-01-01",
      },
    ];
    mockActiveId = "conv1";

    render(
      <UnifiedChatPanel projectId="proj1">
        <div>board</div>
      </UnifiedChatPanel>,
    );

    fireEvent.click(screen.getByTestId("collapsed-chat-strip"));
    expect(screen.getByTestId("conversation-tab-conv1")).toHaveAttribute(
      "data-agent-type",
      "epic_creation",
    );
  });

  it("shows epic creation empty-state hint for new epic tabs", () => {
    mockConversations = [
      {
        id: "conv1",
        projectId: "proj1",
        type: "epic_creation",
        label: "New Epic",
        status: "active",
        epicId: null,
        provider: "claude-code",
        createdAt: "2024-01-01",
      },
    ];
    mockActiveId = "conv1";
    mockMessages = [];

    render(
      <UnifiedChatPanel projectId="proj1">
        <div>board</div>
      </UnifiedChatPanel>,
    );

    fireEvent.click(screen.getByTestId("collapsed-chat-strip"));
    expect(
      screen.getByText(
        "Describe your epic idea and I'll help you structure it with user stories and acceptance criteria.",
      ),
    ).toBeInTheDocument();
  });

  it("shows create epic action for epic conversations and triggers onEpicCreated callback", async () => {
    mockConversations = [
      {
        id: "conv1",
        projectId: "proj1",
        type: "epic_creation",
        label: "Epic refinement",
        status: "active",
        epicId: null,
        provider: "claude-code",
        createdAt: "2024-01-01",
      },
    ];
    mockActiveId = "conv1";
    mockMessages = [
      {
        id: "m1",
        projectId: "proj1",
        role: "user",
        content: "I want an auth epic",
        createdAt: "2024-01-01",
      },
      {
        id: "m2",
        projectId: "proj1",
        role: "assistant",
        content: "Here is a refined epic proposal",
        createdAt: "2024-01-01",
      },
    ];
    const onEpicCreated = vi.fn();

    render(
      <UnifiedChatPanel projectId="proj1" onEpicCreated={onEpicCreated}>
        <div>board</div>
      </UnifiedChatPanel>,
    );

    fireEvent.click(screen.getByTestId("collapsed-chat-strip"));
    fireEvent.click(screen.getByText("Create Epic & Generate Stories"));

    await waitFor(() => {
      expect(mockCreateEpic).toHaveBeenCalledTimes(1);
      expect(onEpicCreated).toHaveBeenCalledTimes(1);
    });
  });

  it("disables create epic action while epic creation is loading", () => {
    mockConversations = [
      {
        id: "conv1",
        projectId: "proj1",
        type: "epic_creation",
        label: "Epic refinement",
        status: "active",
        epicId: null,
        provider: "claude-code",
        createdAt: "2024-01-01",
      },
    ];
    mockActiveId = "conv1";
    mockMessages = [
      {
        id: "m1",
        projectId: "proj1",
        role: "user",
        content: "I want an auth epic",
        createdAt: "2024-01-01",
      },
      {
        id: "m2",
        projectId: "proj1",
        role: "assistant",
        content: "Here is a refined epic proposal",
        createdAt: "2024-01-01",
      },
    ];
    mockEpicCreateLoading = true;

    render(
      <UnifiedChatPanel projectId="proj1">
        <div>board</div>
      </UnifiedChatPanel>,
    );

    fireEvent.click(screen.getByTestId("collapsed-chat-strip"));
    expect(screen.getByText("Create Epic & Generate Stories")).toBeDisabled();
  });

  it("hides create epic action for brainstorm conversations", () => {
    mockConversations = [
      {
        id: "conv1",
        projectId: "proj1",
        type: "brainstorm",
        label: "Brainstorm",
        status: "active",
        epicId: null,
        provider: "claude-code",
        createdAt: "2024-01-01",
      },
    ];
    mockActiveId = "conv1";
    mockMessages = [
      {
        id: "m1",
        projectId: "proj1",
        role: "user",
        content: "Hi",
        createdAt: "2024-01-01",
      },
      {
        id: "m2",
        projectId: "proj1",
        role: "assistant",
        content: "Hello",
        createdAt: "2024-01-01",
      },
    ];

    render(
      <UnifiedChatPanel projectId="proj1">
        <div>board</div>
      </UnifiedChatPanel>,
    );

    fireEvent.click(screen.getByTestId("collapsed-chat-strip"));
    expect(screen.queryByText("Create Epic & Generate Stories")).not.toBeInTheDocument();
  });

  it("passes brainstorm placeholder text to MessageInput", () => {
    mockConversations = [
      {
        id: "conv1",
        projectId: "proj1",
        type: "brainstorm",
        label: "Brainstorm",
        status: "active",
        epicId: null,
        provider: "claude-code",
        createdAt: "2024-01-01",
      },
    ];
    mockActiveId = "conv1";

    render(
      <UnifiedChatPanel projectId="proj1">
        <div>board</div>
      </UnifiedChatPanel>,
    );

    fireEvent.click(screen.getByTestId("collapsed-chat-strip"));
    expect(screen.getByTestId("message-input")).toHaveAttribute(
      "data-placeholder",
      "Ask a question...",
    );
  });

  it("passes epic placeholder text to MessageInput", () => {
    mockConversations = [
      {
        id: "conv1",
        projectId: "proj1",
        type: "epic_creation",
        label: "New Epic",
        status: "active",
        epicId: null,
        provider: "claude-code",
        createdAt: "2024-01-01",
      },
    ];
    mockActiveId = "conv1";

    render(
      <UnifiedChatPanel projectId="proj1">
        <div>board</div>
      </UnifiedChatPanel>,
    );

    fireEvent.click(screen.getByTestId("collapsed-chat-strip"));
    expect(screen.getByTestId("message-input")).toHaveAttribute(
      "data-placeholder",
      "Describe your epic idea...",
    );
  });
});
