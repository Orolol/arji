/**
 * Opening the chat panel before the conversations fetch has landed must not
 * create a duplicate "Brainstorm".
 *
 * `openChatConversation()` used to infer "this project has no conversation"
 * from an empty `conversations` list. The list is also empty while the mount
 * fetch is still in flight, so a click on the collapsed strip (or `openChat()`
 * on the imperative handle) during that window created a second, permanent
 * Brainstorm next to the one the project already had.
 *
 * The mock exposes the hook's own `loading` flag independently of the list so
 * the loading state and the genuinely-empty state are two different fixtures:
 * asserting on the list alone would reproduce the blind spot the code had.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createRef } from "react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

interface MockConversation {
  id: string;
  projectId: string;
  type: string;
  label: string;
  status: string;
  epicId: null;
  provider: string;
  createdAt: string;
}

const existingBrainstorm: MockConversation = {
  id: "conv1",
  projectId: "proj1",
  type: "brainstorm",
  label: "Brainstorm",
  status: "active",
  epicId: null,
  provider: "claude-code",
  createdAt: "2024-01-01",
};

let mockLoading = true;
let mockConversations: MockConversation[] = [];
let mockActiveId: string | null = null;
const mockSetActiveId = vi.fn((id: string | null) => {
  mockActiveId = id;
});
const mockCreateConversation = vi.fn(async (input?: { type?: string; label?: string }) => {
  const conversation: MockConversation = {
    id: "conv-created",
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

vi.mock("@/hooks/useConversations", () => ({
  useConversations: () => ({
    conversations: mockConversations,
    activeId: mockActiveId,
    setActiveId: mockSetActiveId,
    loading: mockLoading,
    createConversation: mockCreateConversation,
    updateConversation: vi.fn(),
    deleteConversation: vi.fn(),
    restartPersistentSession: vi.fn(),
    refresh: vi.fn(),
  }),
}));

vi.mock("@/hooks/useChat", () => ({
  useChat: () => ({
    messages: [],
    loading: false,
    sending: false,
    error: null,
    pendingQuestions: null,
    streamStatus: null,
    sendMessage: vi.fn(),
    answerQuestions: vi.fn(),
  }),
}));

vi.mock("@/hooks/useProvidersAvailable", () => ({
  useProvidersAvailable: () => ({ codexAvailable: true, codexInstalled: true }),
}));

vi.mock("@/hooks/useEpicCreate", () => ({
  useEpicCreate: () => ({
    createEpic: vi.fn(async () => "epic-1"),
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

import { UnifiedChatPanel, type UnifiedChatPanelHandle } from "@/components/chat/UnifiedChatPanel";

function renderPanel(ref?: React.Ref<UnifiedChatPanelHandle>) {
  return render(
    <UnifiedChatPanel projectId="proj1" ref={ref}>
      <div data-testid="board-content">board</div>
    </UnifiedChatPanel>,
  );
}

/** Lets the async `openChatConversation` settle before asserting on calls. */
async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

describe("UnifiedChatPanel: opening before the conversations fetch lands", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    window.localStorage.clear();

    mockLoading = true;
    mockConversations = [];
    mockActiveId = null;
    mockSetActiveId.mockClear();
    mockCreateConversation.mockClear();

    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      writable: true,
      value: 1200,
    });
  });

  it("clicking the strip while the fetch is in flight expands the panel but creates nothing", async () => {
    renderPanel();

    fireEvent.click(screen.getByTestId("collapsed-chat-strip"));
    await flush();

    // The click is honoured...
    expect(screen.getByTestId("unified-panel-expanded")).toBeInTheDocument();
    // ...but an empty list that merely has not arrived is not an empty project.
    expect(mockCreateConversation).not.toHaveBeenCalled();
  });

  it("openChat() on the imperative handle while the fetch is in flight creates nothing", async () => {
    const ref = createRef<UnifiedChatPanelHandle>();
    renderPanel(ref);

    await act(async () => {
      ref.current?.openChat();
    });
    await flush();

    expect(screen.getByTestId("unified-panel-expanded")).toBeInTheDocument();
    expect(mockCreateConversation).not.toHaveBeenCalled();
  });

  it("shows the project's existing Brainstorm once the fetch lands, still without creating", async () => {
    const view = renderPanel();

    fireEvent.click(screen.getByTestId("collapsed-chat-strip"));
    await flush();

    // The fetch lands: the hook applies the payload and selects the first row.
    mockLoading = false;
    mockConversations = [existingBrainstorm];
    mockActiveId = existingBrainstorm.id;
    view.rerender(
      <UnifiedChatPanel projectId="proj1">
        <div data-testid="board-content">board</div>
      </UnifiedChatPanel>,
    );

    expect(screen.getByTestId("conversation-tab-conv1")).toBeInTheDocument();
    expect(screen.getAllByTestId(/^conversation-tab-/)).toHaveLength(1);
    expect(mockCreateConversation).not.toHaveBeenCalled();
  });

  // --- Controls: pass with and without the fix -------------------------------

  it("still creates exactly one Brainstorm once the fetch has settled on a genuinely empty project", async () => {
    mockLoading = false;

    renderPanel();

    fireEvent.click(screen.getByTestId("collapsed-chat-strip"));

    await waitFor(() => {
      expect(mockCreateConversation).toHaveBeenCalledTimes(1);
    });
    expect(mockCreateConversation).toHaveBeenCalledWith({
      type: "brainstorm",
      label: "Brainstorm",
    });
  });

  it("selects the existing conversation instead of creating once the fetch has settled", async () => {
    mockLoading = false;
    mockConversations = [existingBrainstorm];

    renderPanel();

    fireEvent.click(screen.getByTestId("collapsed-chat-strip"));
    await flush();

    expect(screen.getByTestId("conversation-tab-conv1")).toBeInTheDocument();
    expect(mockCreateConversation).not.toHaveBeenCalled();
  });

  it("openNewEpic() keeps creating unconditionally, even while the fetch is in flight", async () => {
    const ref = createRef<UnifiedChatPanelHandle>();
    renderPanel(ref);

    await act(async () => {
      ref.current?.openNewEpic();
    });

    await waitFor(() => {
      expect(mockCreateConversation).toHaveBeenCalledTimes(1);
    });
    expect(mockCreateConversation).toHaveBeenCalledWith({
      type: "epic_creation",
      label: "New Epic",
    });
  });
});
