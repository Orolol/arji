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

vi.mock("@/components/ui/select", () => ({
  Select: ({
    value,
    onValueChange,
    children,
    disabled,
  }: {
    value: string | undefined;
    onValueChange?: (v: string) => void;
    children: React.ReactNode;
    disabled?: boolean;
  }) => (
    <select
      data-testid="chat-agent-select"
      value={value ?? ""}
      disabled={disabled}
      onChange={(e) => onValueChange?.(e.target.value)}
    >
      {children}
    </select>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectGroup: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectLabel: ({ children }: { children: React.ReactNode }) => <optgroup label={String(children)} />,
  SelectItem: ({
    value,
    children,
  }: {
    value: string;
    children: React.ReactNode;
  }) => <option value={value}>{children}</option>,
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

  it("renders named-agent select in unified chat header", () => {
    renderExpandedPanel();
    expect(screen.getByTestId("chat-agent-select")).toBeInTheDocument();
  });

  it("shows current conversation namedAgentId", () => {
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
    const select = screen.getByTestId("chat-agent-select") as HTMLSelectElement;
    expect(select.value).toBe("agent-2");
  });

  it("named-agent select is disabled when messages exist", () => {
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

  it("named-agent select is disabled while sending", () => {
    mockSending = true;
    renderExpandedPanel();
    expect(screen.getByTestId("chat-agent-select")).toBeDisabled();
  });

  /** Selects `value` in the header dropdown, returns the PATCH mock. */
  async function selectAndCapturePatch(value: string) {
    const mockFetch = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ data: {} }),
    });
    global.fetch = mockFetch;

    renderExpandedPanel();
    fireEvent.change(screen.getByTestId("chat-agent-select"), {
      target: { value },
    });

    await waitFor(() => expect(mockFetch).toHaveBeenCalled());
    return mockFetch;
  }

  it("calls PATCH API when named agent changes", async () => {
    const mockFetch = await selectAndCapturePatch("agent-1");

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
    const mockFetch = await selectAndCapturePatch("openai-compatible");

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
    const mockFetch = await selectAndCapturePatch("codex");

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
