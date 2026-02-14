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

let mockConversations = [
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
  async (conversationId: string, updates: { namedAgentId?: string | null }) => {
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

vi.mock("@/components/shared/NamedAgentSelect", () => ({
  NamedAgentSelect: ({
    value,
    onChange,
    disabled,
  }: {
    value: string | null;
    onChange: (v: string) => void;
    disabled: boolean;
  }) => (
    <select
      data-testid="chat-agent-select"
      value={value ?? ""}
      onChange={(event) => onChange(event.target.value)}
      disabled={disabled}
    >
      <option value="">Select</option>
      <option value="agent-1">Agent 1</option>
      <option value="agent-2">Agent 2</option>
    </select>
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

  it("calls PATCH API when named agent changes", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ data: {} }),
    });
    global.fetch = mockFetch;

    renderExpandedPanel();
    fireEvent.change(screen.getByTestId("chat-agent-select"), {
      target: { value: "agent-1" },
    });

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        "/api/projects/proj1/conversations/conv1",
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({ namedAgentId: "agent-1" }),
        }),
      );
    });
  });
});
