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

let mockCodexAvailable = true;
vi.mock("@/hooks/useCodexAvailable", () => ({
  useCodexAvailable: () => ({
    codexAvailable: mockCodexAvailable,
    codexInstalled: mockCodexAvailable,
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
      onChange={(event) => onChange(event.target.value)}
      disabled={disabled}
      data-codex-available={String(codexAvailable)}
    >
      <option value="claude-code">Claude Code</option>
      {codexAvailable && <option value="codex">Codex</option>}
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

describe("UnifiedChatPanel provider toggle", () => {
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
        status: "active",
        epicId: null,
        provider: "claude-code",
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

  it("renders provider select in unified chat header", () => {
    renderExpandedPanel();
    expect(screen.getByTestId("chat-provider-select")).toBeInTheDocument();
  });

  it("shows current conversation provider", () => {
    renderExpandedPanel();
    const select = screen.getByTestId("chat-provider-select") as HTMLSelectElement;
    expect(select.value).toBe("claude-code");
  });

  it("provider select is enabled when no messages exist", () => {
    mockMessages = [];
    renderExpandedPanel();
    expect(screen.getByTestId("chat-provider-select")).not.toBeDisabled();
  });

  it("provider select is disabled when messages exist", () => {
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
    expect(screen.getByTestId("chat-provider-select")).toBeDisabled();
  });

  it("provider select is disabled while sending", () => {
    mockSending = true;
    renderExpandedPanel();
    expect(screen.getByTestId("chat-provider-select")).toBeDisabled();
  });

  it("calls PATCH API when provider changes", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ data: {} }),
    });
    global.fetch = mockFetch;

    renderExpandedPanel();
    fireEvent.change(screen.getByTestId("chat-provider-select"), {
      target: { value: "codex" },
    });

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        "/api/projects/proj1/conversations/conv1",
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({ provider: "codex" }),
        }),
      );
    });
  });

  it("does not call PATCH when messages exist", () => {
    mockMessages = [
      {
        id: "m1",
        role: "user",
        content: "hello",
        projectId: "proj1",
        createdAt: "2024-01-01",
      },
    ];
    const mockFetch = vi.fn();
    global.fetch = mockFetch;

    renderExpandedPanel();
    fireEvent.change(screen.getByTestId("chat-provider-select"), {
      target: { value: "codex" },
    });

    const patchCalls = mockFetch.mock.calls.filter(
      (call: unknown[]) =>
        typeof call[1] === "object" &&
        (call[1] as { method?: string }).method === "PATCH",
    );
    expect(patchCalls).toHaveLength(0);
  });

  it("shows codex provider when conversation uses codex", () => {
    mockConversations = [
      {
        id: "conv1",
        projectId: "proj1",
        type: "brainstorm",
        label: "Brainstorm",
        status: "active",
        epicId: null,
        provider: "codex",
        createdAt: "2024-01-01",
      },
    ];
    renderExpandedPanel();
    const select = screen.getByTestId("chat-provider-select") as HTMLSelectElement;
    expect(select.value).toBe("codex");
  });
});
