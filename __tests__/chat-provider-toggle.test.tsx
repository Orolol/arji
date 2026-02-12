import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// Mock next/navigation
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

// Mock hooks
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
    epicId: null,
    provider: "claude-code",
    createdAt: "2024-01-01",
  },
];
let mockActiveId: string | null = "conv1";
const mockUpdateConversation = vi.fn(
  async (conversationId: string, updates: { provider?: string }) => {
    const res = await fetch(`/api/projects/proj1/conversations/${conversationId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(updates),
    });
    const json = await res.json();
    return json.data;
  }
);

vi.mock("@/hooks/useConversations", () => ({
  useConversations: () => ({
    conversations: mockConversations,
    activeId: mockActiveId,
    setActiveId: vi.fn(),
    createConversation: vi.fn(),
    updateConversation: mockUpdateConversation,
    deleteConversation: vi.fn(),
    refresh: vi.fn(),
    loading: false,
  }),
}));

let mockCodexAvailable = true;
vi.mock("@/hooks/useCodexAvailable", () => ({
  useCodexAvailable: () => ({ codexAvailable: mockCodexAvailable, loading: false }),
}));

// Mock ProviderSelect
vi.mock("@/components/shared/ProviderSelect", () => ({
  ProviderSelect: ({
    value,
    onChange,
    disabled,
    codexAvailable,
  }: {
    value: string;
    onChange: (v: string) => void;
    disabled: boolean;
    codexAvailable: boolean;
  }) => (
    <select
      data-testid="chat-provider-select"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
      data-codex-available={String(codexAvailable)}
    >
      <option value="claude-code">Claude Code</option>
      {codexAvailable && <option value="codex">Codex</option>}
    </select>
  ),
}));

// Mock child components
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

import { ChatPanel } from "@/components/chat/ChatPanel";

describe("ChatPanel Provider Toggle", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockMessages = [];
    mockSending = false;
    mockCodexAvailable = true;
    mockConversations = [
      {
        id: "conv1",
        projectId: "proj1",
        type: "brainstorm",
        label: "Brainstorm",
        epicId: null,
        provider: "claude-code",
        createdAt: "2024-01-01",
      },
    ];
    mockActiveId = "conv1";
    mockUpdateConversation.mockClear();
    global.fetch = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ data: {} }),
    });
  });

  it("renders provider select in chat header", () => {
    render(<ChatPanel projectId="proj1" />);
    expect(screen.getByTestId("chat-provider-select")).toBeInTheDocument();
  });

  it("shows current conversation provider", () => {
    render(<ChatPanel projectId="proj1" />);
    const select = screen.getByTestId("chat-provider-select") as HTMLSelectElement;
    expect(select.value).toBe("claude-code");
  });

  it("provider select is enabled when no messages exist", () => {
    mockMessages = [];
    render(<ChatPanel projectId="proj1" />);
    const select = screen.getByTestId("chat-provider-select");
    expect(select).not.toBeDisabled();
  });

  it("provider select is disabled when messages exist (locked)", () => {
    mockMessages = [
      { id: "m1", role: "user", content: "hello", projectId: "proj1", createdAt: "2024-01-01" },
    ];
    render(<ChatPanel projectId="proj1" />);
    const select = screen.getByTestId("chat-provider-select");
    expect(select).toBeDisabled();
  });

  it("provider select is disabled when sending", () => {
    mockSending = true;
    render(<ChatPanel projectId="proj1" />);
    const select = screen.getByTestId("chat-provider-select");
    expect(select).toBeDisabled();
  });

  it("calls PATCH API when provider is changed", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ data: {} }),
    });
    global.fetch = mockFetch;

    render(<ChatPanel projectId="proj1" />);
    const select = screen.getByTestId("chat-provider-select");
    fireEvent.change(select, { target: { value: "codex" } });

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        "/api/projects/proj1/conversations/conv1",
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({ provider: "codex" }),
        })
      );
    });
  });

  it("does not call PATCH when messages exist", () => {
    mockMessages = [
      { id: "m1", role: "user", content: "hello", projectId: "proj1", createdAt: "2024-01-01" },
    ];
    const mockFetch = vi.fn();
    global.fetch = mockFetch;

    render(<ChatPanel projectId="proj1" />);
    const select = screen.getByTestId("chat-provider-select");
    // Even if we somehow trigger onChange, the handler should bail out
    fireEvent.change(select, { target: { value: "codex" } });

    // No PATCH calls should have been made
    const patchCalls = mockFetch.mock.calls.filter(
      (c: unknown[]) =>
        typeof c[1] === "object" &&
        (c[1] as { method?: string }).method === "PATCH"
    );
    expect(patchCalls).toHaveLength(0);
  });

  it("shows codex provider when conversation has codex", () => {
    mockConversations = [
      {
        id: "conv1",
        projectId: "proj1",
        type: "brainstorm",
        label: "Brainstorm",
        epicId: null,
        provider: "codex",
        createdAt: "2024-01-01",
      },
    ];
    render(<ChatPanel projectId="proj1" />);
    const select = screen.getByTestId("chat-provider-select") as HTMLSelectElement;
    expect(select.value).toBe("codex");
  });
});
