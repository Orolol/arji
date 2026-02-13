import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

let mockConversations = [
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
  {
    id: "conv2",
    projectId: "proj1",
    type: "brainstorm",
    label: "Second chat",
    status: "active",
    epicId: null,
    provider: "claude-code",
    createdAt: "2024-01-02",
  },
];
let mockActiveId: string | null = "conv2";

vi.mock("@/hooks/useConversations", () => ({
  useConversations: () => ({
    conversations: mockConversations,
    activeId: mockActiveId,
    setActiveId: vi.fn((id: string) => {
      mockActiveId = id;
    }),
    createConversation: vi.fn(),
    updateConversation: vi.fn(),
    deleteConversation: vi.fn(),
    refresh: vi.fn(),
    loading: false,
  }),
}));

let mockSending = false;

vi.mock("@/hooks/useChat", () => ({
  useChat: () => ({
    messages: [],
    loading: false,
    sending: mockSending,
    pendingQuestions: null,
    streamStatus: null,
    sendMessage: vi.fn(),
    answerQuestions: vi.fn(),
  }),
}));

vi.mock("@/hooks/useCodexAvailable", () => ({
  useCodexAvailable: () => ({ codexAvailable: false, codexInstalled: false }),
}));

vi.mock("@/hooks/useEpicCreate", () => ({
  useEpicCreate: () => ({
    createEpic: vi.fn(),
    isLoading: false,
    error: null,
    createdEpic: null,
  }),
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
  ProviderSelect: ({ disabled }: { disabled?: boolean }) => (
    <div data-testid="provider-select" data-disabled={disabled} />
  ),
}));

import { UnifiedChatPanel } from "@/components/chat/UnifiedChatPanel";

describe("Chat concurrency — one generating conversation should not block others", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    window.localStorage.clear();

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
      {
        id: "conv2",
        projectId: "proj1",
        type: "brainstorm",
        label: "Second chat",
        status: "active",
        epicId: null,
        provider: "claude-code",
        createdAt: "2024-01-02",
      },
    ];
    mockActiveId = "conv2";
    mockSending = false;

    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      writable: true,
      value: 1200,
    });
  });

  it("input is enabled for an active conversation even when another is generating", () => {
    render(
      <UnifiedChatPanel projectId="proj1">
        <div>board</div>
      </UnifiedChatPanel>,
    );

    // Expand the panel
    fireEvent.click(screen.getByTestId("collapsed-chat-strip"));

    // conv2 is active with status "active" and sending=false
    // conv1 has status "generating" but it's NOT the active conversation
    const input = screen.getByTestId("message-input");
    expect(input).not.toBeDisabled();
  });

  it("input is disabled for the active conversation when it is generating", () => {
    // Switch active to conv1 which is "generating"
    mockActiveId = "conv1";

    render(
      <UnifiedChatPanel projectId="proj1">
        <div>board</div>
      </UnifiedChatPanel>,
    );

    fireEvent.click(screen.getByTestId("collapsed-chat-strip"));

    const input = screen.getByTestId("message-input");
    expect(input).toBeDisabled();
  });

  it("collapsed strip shows activity badge when any conversation is generating", () => {
    render(
      <UnifiedChatPanel projectId="proj1">
        <div>board</div>
      </UnifiedChatPanel>,
    );

    // Even though the active conversation (conv2) is "active", the badge
    // should show because conv1 is "generating" — this is a global indicator
    expect(screen.getByTestId("collapsed-active-badge")).toBeInTheDocument();
  });

  it("collapsed strip has no activity badge when no conversation is generating", () => {
    mockConversations = mockConversations.map((c) => ({
      ...c,
      status: "active",
    }));

    render(
      <UnifiedChatPanel projectId="proj1">
        <div>board</div>
      </UnifiedChatPanel>,
    );

    expect(screen.queryByTestId("collapsed-active-badge")).not.toBeInTheDocument();
  });

  it("input is disabled when useChat sending=true regardless of DB status", () => {
    // conv2 has status "active" in DB, but useChat is actively sending
    mockSending = true;

    render(
      <UnifiedChatPanel projectId="proj1">
        <div>board</div>
      </UnifiedChatPanel>,
    );

    fireEvent.click(screen.getByTestId("collapsed-chat-strip"));

    const input = screen.getByTestId("message-input");
    expect(input).toBeDisabled();
  });
});
