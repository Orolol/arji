import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

let mockMessages: { id: string; role: string; content: string; projectId: string; createdAt: string }[] = [];
let mockSending = false;
const mockSendMessage = vi.fn();

vi.mock("@/hooks/useChat", () => ({
  useChat: () => ({
    messages: mockMessages,
    loading: false,
    sending: mockSending,
    pendingQuestions: null,
    streamStatus: null,
    sendMessage: mockSendMessage,
    answerQuestions: vi.fn(),
    refresh: vi.fn(),
  }),
}));

/** Shape of the rows `useConversations()` hands the panel, as the tests set them. */
type ConversationStub = {
  id: string;
  projectId: string;
  type: string;
  label: string;
  status: string;
  epicId: string | null;
  provider: string;
  namedAgentId: string | null;
  createdAt: string;
};

let mockConversations: ConversationStub[] = [
  {
    id: "conv1",
    projectId: "proj1",
    type: "brainstorm",
    label: "Brainstorm",
    status: "active",
    epicId: null,
    provider: "claude-code",
    namedAgentId: null,
    createdAt: "2024-01-01",
  },
];
let mockActiveId: string | null = "conv1";

const mockUpdateConversation = vi.fn(
  async (
    conversationId: string,
    updates: { namedAgentId?: string | null; provider?: string },
  ) => {
    const res = await fetch(`/api/projects/proj1/conversations/${conversationId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(updates),
    });
    const json = await res.json();
    return json.data;
  },
);

vi.mock("@/hooks/useConversations", () => ({
  useConversations: () => ({
    conversations: mockConversations,
    activeId: mockActiveId,
    setActiveId: vi.fn((id: string | null) => {
      mockActiveId = id;
    }),
    createConversation: vi.fn(),
    updateConversation: mockUpdateConversation,
    deleteConversation: vi.fn(),
    refresh: vi.fn(),
    loading: false,
  }),
}));

vi.mock("@/hooks/useEpicCreate", () => ({
  useEpicCreate: () => ({
    createEpic: vi.fn(async () => null),
    isLoading: false,
    error: null,
    createdEpic: null,
  }),
}));

vi.mock("@/hooks/useNamedAgentsList", () => ({
  useNamedAgentsList: () => ({
    agents: [
      { id: "agent-1", name: "Agent 1", provider: "claude-code", model: "opus" },
      { id: "agent-2", name: "Agent 2", provider: "gemini-cli", model: "flash" },
    ],
    loading: false,
    refresh: vi.fn(),
  }),
}));

// The header's picker is the shared `AgentSelectPill` (a Piscine SelectPill on
// a Radix dropdown). Radix portals its items on open; the inline stand-in lets
// these tests pick an option without driving a popper in jsdom.
vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="dropdown-content">{children}</div>
  ),
  DropdownMenuLabel: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuSeparator: () => <hr />,
  DropdownMenuItem: ({
    children,
    onSelect,
    ...rest
  }: {
    children: React.ReactNode;
    onSelect?: () => void;
  }) => (
    <button type="button" role="menuitem" onClick={() => onSelect?.()} {...rest}>
      {children}
    </button>
  ),
}));

vi.mock("@/components/chat/MessageList", () => ({
  MessageList: () => <div data-testid="message-list" />,
}));
vi.mock("@/components/chat/MessageInput", () => ({
  MessageInput: ({ onSend, disabled }: { onSend: (s: string) => void; disabled: boolean }) => (
    <button data-testid="send-btn" disabled={disabled} onClick={() => onSend("test")}>
      Send
    </button>
  ),
}));
vi.mock("@/components/chat/QuestionCards", () => ({
  QuestionCards: () => null,
}));

import { UnifiedChatPanel } from "@/components/chat/UnifiedChatPanel";

describe("UnifiedChatPanel named-agent toggle", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockMessages = [];
    mockSending = false;
    mockConversations = [
      {
        id: "conv1",
        projectId: "proj1",
        type: "brainstorm",
        label: "Brainstorm",
        status: "active",
        epicId: null,
        provider: "claude-code",
        namedAgentId: null,
        createdAt: "2024-01-01",
      },
    ];
    mockActiveId = "conv1";
    mockUpdateConversation.mockClear();
    window.localStorage.clear();

    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      writable: true,
      value: 1200,
    });

    global.fetch = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ data: {} }),
    });
  });

  function renderExpandedPanel() {
    render(
      <UnifiedChatPanel projectId="proj1">
        <div>board</div>
      </UnifiedChatPanel>,
    );
    const collapsedStrip = screen.queryByTestId("collapsed-chat-strip");
    if (collapsedStrip) {
      fireEvent.click(collapsedStrip);
    }
  }

  it("renders the agent picker in the unified chat header", () => {
    renderExpandedPanel();
    expect(screen.getByTestId("chat-agent-select")).toBeInTheDocument();
  });

  it("names the conversation's current named agent on the trigger", () => {
    mockConversations = [
      {
        id: "conv1",
        projectId: "proj1",
        type: "brainstorm",
        label: "Brainstorm",
        status: "active",
        epicId: null,
        provider: "gemini-cli",
        namedAgentId: "agent-2",
        createdAt: "2024-01-01",
      },
    ];

    renderExpandedPanel();
    expect(screen.getByTestId("chat-agent-select")).toHaveTextContent("Agent 2");
  });

  it("locks the picker when messages exist", () => {
    mockMessages = [
      {
        id: "m1",
        role: "user",
        content: "hello",
        projectId: "proj1",
        createdAt: "2024-01-01",
      },
    ];

    renderExpandedPanel();
    expect(screen.getByTestId("chat-agent-select")).toBeDisabled();
  });

  it("locks the picker while sending", () => {
    mockSending = true;
    renderExpandedPanel();
    expect(screen.getByTestId("chat-agent-select")).toBeDisabled();
  });

  /** Picks the option carrying `testId` in the header menu; returns the PATCH mock. */
  async function selectAndCapturePatch(testId: string) {
    const mockFetch = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ data: {} }),
    });
    global.fetch = mockFetch;

    renderExpandedPanel();
    fireEvent.click(screen.getByTestId(testId));

    await waitFor(() => expect(mockFetch).toHaveBeenCalled());
    return mockFetch;
  }

  it("calls PATCH API when named agent changes", async () => {
    const mockFetch = await selectAndCapturePatch("chat-option-agent-agent-1");

    // Exactly one write: a single selection must not fan out into competing
    // PATCHes that can undo each other.
    expect(mockFetch).toHaveBeenCalledTimes(1);
    // No provider: the route derives it from the agent row, so sending one
    // would only be a redundant field in the contract.
    expect(mockFetch).toHaveBeenCalledWith(
      "/api/projects/proj1/conversations/conv1",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ namedAgentId: "agent-1" }),
      }),
    );
  });

  it("PATCHes the direct API provider with the named-agent link cleared", async () => {
    const mockFetch = await selectAndCapturePatch("chat-option-openai-compatible");

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith(
      "/api/projects/proj1/conversations/conv1",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ provider: "openai-compatible", namedAgentId: null }),
      }),
    );
  });

  it("PATCHes a raw CLI provider with the named-agent link cleared", async () => {
    const mockFetch = await selectAndCapturePatch("chat-option-provider-codex");

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith(
      "/api/projects/proj1/conversations/conv1",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ provider: "codex", namedAgentId: null }),
      }),
    );
  });
});
