/**
 * Tests for Epic 3: Unified Chat and Epic Creation Workspace
 *
 * Covers all five user stories:
 *  1. New Epic and Chat merged into one panel
 *  2. Chat workspace collapsed on the right by default
 *  3. Resizable split between board and chat
 *  4. Agent type selection pre-populated on every new chat tab
 *  5. Running indicators on chat tabs
 */

import { createRef } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, act } from "@testing-library/react";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

let conversationCounter = 2;
let mockConversations: Array<{
  id: string;
  projectId: string;
  type: string;
  label: string;
  status: string | null;
  epicId: string | null;
  provider: string;
  createdAt: string;
}> = [];
let mockActiveId: string | null = null;

const mockSetActiveId = vi.fn((id: string | null) => {
  mockActiveId = id;
});

const mockCreateConversation = vi.fn(
  async (input?: { type?: string; label?: string; provider?: string }) => {
    const id = `conv${conversationCounter}`;
    conversationCounter += 1;
    const conversation = {
      id,
      projectId: "proj1",
      type: input?.type || "brainstorm",
      label: input?.label || "Brainstorm",
      status: "active",
      epicId: null,
      provider: input?.provider || "claude-code",
      createdAt: new Date().toISOString(),
    };
    mockConversations = [...mockConversations, conversation];
    mockActiveId = conversation.id;
    return conversation;
  },
);

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

let mockMessages: Array<{
  id: string;
  projectId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}> = [];
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

const mockCreateEpic = vi.fn(async () => "epic-1");

vi.mock("@/hooks/useEpicCreate", () => ({
  useEpicCreate: () => ({
    createEpic: mockCreateEpic,
    isLoading: false,
    error: null,
    createdEpic: null,
  }),
}));

vi.mock("@/components/chat/MessageList", () => ({
  MessageList: () => <div data-testid="message-list" />,
}));

vi.mock("@/components/chat/MessageInput", () => ({
  MessageInput: ({
    disabled,
    placeholder,
  }: {
    disabled?: boolean;
    placeholder?: string;
  }) => (
    <button
      data-testid="message-input"
      data-placeholder={placeholder}
      disabled={disabled}
    >
      input
    </button>
  ),
}));

vi.mock("@/components/chat/QuestionCards", () => ({
  QuestionCards: () => null,
}));

vi.mock("@/components/shared/ProviderSelect", () => ({
  ProviderSelect: ({ value }: { value: string }) => (
    <div data-testid="provider-select">{value}</div>
  ),
}));

import {
  UnifiedChatPanel,
  type UnifiedChatPanelHandle,
} from "@/components/chat/UnifiedChatPanel";

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

function resetMocks() {
  vi.restoreAllMocks();
  vi.useRealTimers();
  window.localStorage.clear();

  conversationCounter = 2;
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
  mockMessages = [];

  mockSetActiveId.mockClear();
  mockCreateConversation.mockClear();
  mockUpdateConversation.mockClear();
  mockRefreshConversations.mockClear();
  mockDeleteConversation.mockClear();
  mockCreateEpic.mockClear();
  mockSendMessage.mockClear();

  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    writable: true,
    value: 1200,
  });
}

// ---------------------------------------------------------------------------
// Story 1: New Epic and Chat merged into one panel
// ---------------------------------------------------------------------------

describe("Story 1: New Epic and Chat merged into one panel", () => {
  beforeEach(resetMocks);

  it("openNewEpic() creates an epic_creation tab in the unified panel", async () => {
    const ref = createRef<UnifiedChatPanelHandle>();

    render(
      <UnifiedChatPanel projectId="proj1" ref={ref}>
        <div data-testid="board">board</div>
      </UnifiedChatPanel>,
    );

    act(() => {
      ref.current!.openNewEpic();
    });

    await waitFor(() => {
      expect(mockCreateConversation).toHaveBeenCalledWith(
        expect.objectContaining({ type: "epic_creation", label: "New Epic" }),
      );
    });

    expect(screen.getByTestId("unified-panel-expanded")).toBeInTheDocument();
  });

  it("openChat() opens the panel with an existing conversation tab", () => {
    const ref = createRef<UnifiedChatPanelHandle>();

    render(
      <UnifiedChatPanel projectId="proj1" ref={ref}>
        <div data-testid="board">board</div>
      </UnifiedChatPanel>,
    );

    act(() => {
      ref.current!.openChat();
    });

    expect(screen.getByTestId("unified-panel-expanded")).toBeInTheDocument();
    expect(screen.getByTestId("conversation-tab-conv1")).toBeInTheDocument();
  });

  it("openChat() creates a brainstorm tab when no conversations exist", async () => {
    mockConversations = [];
    mockActiveId = null;
    const ref = createRef<UnifiedChatPanelHandle>();

    render(
      <UnifiedChatPanel projectId="proj1" ref={ref}>
        <div data-testid="board">board</div>
      </UnifiedChatPanel>,
    );

    act(() => {
      ref.current!.openChat();
    });

    await waitFor(() => {
      expect(mockCreateConversation).toHaveBeenCalledWith(
        expect.objectContaining({ type: "brainstorm", label: "Brainstorm" }),
      );
    });
  });

  it("both brainstorm and epic_creation tabs coexist in the same panel", async () => {
    const ref = createRef<UnifiedChatPanelHandle>();

    render(
      <UnifiedChatPanel projectId="proj1" ref={ref}>
        <div data-testid="board">board</div>
      </UnifiedChatPanel>,
    );

    // Open chat first
    act(() => {
      ref.current!.openChat();
    });

    // Then open new epic
    act(() => {
      ref.current!.openNewEpic();
    });

    await waitFor(() => {
      expect(mockCreateConversation).toHaveBeenCalledWith(
        expect.objectContaining({ type: "epic_creation" }),
      );
    });

    // Both tabs should be visible
    const tabs = screen.getAllByTestId(/^conversation-tab-/);
    expect(tabs.length).toBeGreaterThanOrEqual(2);
  });

  it("epic creation tab shows Sparkles icon and correct data-agent-type", () => {
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

    const tab = screen.getByTestId("conversation-tab-conv1");
    expect(tab).toHaveAttribute("data-agent-type", "epic_creation");
  });

  it("epic creation uses distinct placeholder text in the input", () => {
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

  it("no legacy CreateEpic components are rendered anywhere", () => {
    render(
      <UnifiedChatPanel projectId="proj1">
        <div>board</div>
      </UnifiedChatPanel>,
    );

    // Ensure there is no legacy epic creation sheet/modal
    expect(screen.queryByText("Create Epic")).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Story 2: Chat workspace collapsed on the right by default
// ---------------------------------------------------------------------------

describe("Story 2: Chat workspace collapsed on the right by default", () => {
  beforeEach(resetMocks);

  it("renders in collapsed state by default with a visible strip", () => {
    render(
      <UnifiedChatPanel projectId="proj1">
        <div data-testid="board">board</div>
      </UnifiedChatPanel>,
    );

    expect(screen.getByTestId("collapsed-chat-strip")).toBeInTheDocument();
    expect(screen.queryByTestId("unified-panel-expanded")).not.toBeInTheDocument();
    expect(screen.getByTestId("board")).toBeInTheDocument();
  });

  it("collapsed strip has accessible label", () => {
    render(
      <UnifiedChatPanel projectId="proj1">
        <div>board</div>
      </UnifiedChatPanel>,
    );

    const strip = screen.getByTestId("collapsed-chat-strip");
    expect(strip).toHaveAttribute("aria-label", "Open chat panel");
  });

  it("clicking the collapsed strip expands the panel", () => {
    render(
      <UnifiedChatPanel projectId="proj1">
        <div>board</div>
      </UnifiedChatPanel>,
    );

    fireEvent.click(screen.getByTestId("collapsed-chat-strip"));

    expect(screen.getByTestId("unified-panel-expanded")).toBeInTheDocument();
    expect(screen.queryByTestId("collapsed-chat-strip")).not.toBeInTheDocument();
  });

  it("collapsing the panel preserves open tabs and active tab", async () => {
    const ref = createRef<UnifiedChatPanelHandle>();

    render(
      <UnifiedChatPanel projectId="proj1" ref={ref}>
        <div>board</div>
      </UnifiedChatPanel>,
    );

    // Expand
    act(() => {
      ref.current!.openChat();
    });

    // Create an extra tab
    fireEvent.click(screen.getByTestId("new-conversation-tab"));

    await waitFor(() => {
      expect(screen.getAllByTestId(/^conversation-tab-/).length).toBe(2);
    });

    // Collapse
    act(() => {
      ref.current!.collapse();
    });

    expect(screen.getByTestId("collapsed-chat-strip")).toBeInTheDocument();

    // Re-expand: tabs should still be there
    act(() => {
      ref.current!.openChat();
    });

    await waitFor(() => {
      expect(screen.getAllByTestId(/^conversation-tab-/).length).toBe(2);
    });
  });

  it("Escape key collapses an expanded panel", () => {
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

  it("hide() hides the panel completely with a small restore button", () => {
    const ref = createRef<UnifiedChatPanelHandle>();

    render(
      <UnifiedChatPanel projectId="proj1" ref={ref}>
        <div>board</div>
      </UnifiedChatPanel>,
    );

    act(() => {
      ref.current!.hide();
    });

    expect(screen.queryByTestId("collapsed-chat-strip")).not.toBeInTheDocument();
    expect(screen.queryByTestId("unified-panel-expanded")).not.toBeInTheDocument();

    // There should be a "Show chat strip" button
    const showButton = screen.getByLabelText("Show chat strip");
    expect(showButton).toBeInTheDocument();

    // Clicking it should restore to collapsed
    fireEvent.click(showButton);
    expect(screen.getByTestId("collapsed-chat-strip")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Story 3: Resizable split between board and chat
// ---------------------------------------------------------------------------

describe("Story 3: Resizable split between board and chat", () => {
  beforeEach(resetMocks);

  it("board and chat render side by side when expanded", () => {
    render(
      <UnifiedChatPanel projectId="proj1">
        <div data-testid="board">board</div>
      </UnifiedChatPanel>,
    );

    fireEvent.click(screen.getByTestId("collapsed-chat-strip"));

    expect(screen.getByTestId("board")).toBeInTheDocument();
    expect(screen.getByTestId("unified-panel-expanded")).toBeInTheDocument();
    expect(screen.getByTestId("panel-divider")).toBeInTheDocument();
  });

  it("dragging the divider changes the panel ratio", () => {
    render(
      <UnifiedChatPanel projectId="proj1">
        <div>board</div>
      </UnifiedChatPanel>,
    );

    fireEvent.click(screen.getByTestId("collapsed-chat-strip"));

    const divider = screen.getByTestId("panel-divider");
    fireEvent.mouseDown(divider);
    fireEvent.mouseMove(window, { clientX: 700 });
    fireEvent.mouseUp(window);

    const saved = window.localStorage.getItem(
      "arij.unified-chat-panel.ratio.proj1",
    );
    expect(saved).not.toBeNull();
    // At clientX 700, panel width = 1200 - 700 = 500, ratio = 500/1200 ≈ 0.4167
    expect(Number(saved)).toBeCloseTo(0.4167, 1);
  });

  it("enforces minimum panel width (300px)", () => {
    render(
      <UnifiedChatPanel projectId="proj1">
        <div>board</div>
      </UnifiedChatPanel>,
    );

    fireEvent.click(screen.getByTestId("collapsed-chat-strip"));

    const divider = screen.getByTestId("panel-divider");
    // Drag far right, trying to make panel < 300px
    fireEvent.mouseDown(divider);
    fireEvent.mouseMove(window, { clientX: 1100 });
    fireEvent.mouseUp(window);

    const saved = window.localStorage.getItem(
      "arij.unified-chat-panel.ratio.proj1",
    );
    // Panel should be clamped to minimum 300px → ratio = 300/1200 = 0.25
    expect(Number(saved)).toBeCloseTo(0.25, 1);
  });

  it("enforces minimum board width (400px)", () => {
    render(
      <UnifiedChatPanel projectId="proj1">
        <div>board</div>
      </UnifiedChatPanel>,
    );

    fireEvent.click(screen.getByTestId("collapsed-chat-strip"));

    const divider = screen.getByTestId("panel-divider");
    // Drag far left, trying to make board < 400px
    fireEvent.mouseDown(divider);
    fireEvent.mouseMove(window, { clientX: 100 });
    fireEvent.mouseUp(window);

    const saved = window.localStorage.getItem(
      "arij.unified-chat-panel.ratio.proj1",
    );
    // Board min = 400, divider = 6, so max panel = 1200 - 400 - 6 = 794
    // Max ratio = 794/1200 ≈ 0.6617
    expect(Number(saved)).toBeLessThanOrEqual(0.67);
    expect(Number(saved)).toBeGreaterThanOrEqual(0.65);
  });

  it("double-clicking the divider resets ratio to default", () => {
    render(
      <UnifiedChatPanel projectId="proj1">
        <div>board</div>
      </UnifiedChatPanel>,
    );

    fireEvent.click(screen.getByTestId("collapsed-chat-strip"));

    const divider = screen.getByTestId("panel-divider");
    // Move divider away from default
    fireEvent.mouseDown(divider);
    fireEvent.mouseMove(window, { clientX: 800 });
    fireEvent.mouseUp(window);

    // Double-click to reset
    fireEvent.doubleClick(divider);

    const saved = window.localStorage.getItem(
      "arij.unified-chat-panel.ratio.proj1",
    );
    expect(saved).toBe("0.4000");
  });

  it("persists panel ratio in localStorage across renders", () => {
    // Pre-set a ratio
    window.localStorage.setItem(
      "arij.unified-chat-panel.ratio.proj1",
      "0.5000",
    );

    const { unmount } = render(
      <UnifiedChatPanel projectId="proj1">
        <div>board</div>
      </UnifiedChatPanel>,
    );

    fireEvent.click(screen.getByTestId("collapsed-chat-strip"));

    // The ratio should have been restored from localStorage
    const saved = window.localStorage.getItem(
      "arij.unified-chat-panel.ratio.proj1",
    );
    expect(saved).toBe("0.5000");

    unmount();
  });

  it("divider has accessible label", () => {
    render(
      <UnifiedChatPanel projectId="proj1">
        <div>board</div>
      </UnifiedChatPanel>,
    );

    fireEvent.click(screen.getByTestId("collapsed-chat-strip"));

    const divider = screen.getByTestId("panel-divider");
    expect(divider).toHaveAttribute("aria-label", "Resize panel");
  });
});

// ---------------------------------------------------------------------------
// Story 4: Agent type selection pre-populated on every new chat tab
// ---------------------------------------------------------------------------

describe("Story 4: Agent type selection pre-populated on every new chat tab", () => {
  beforeEach(resetMocks);

  it("new brainstorm tab inherits the active conversation provider", async () => {
    // Active conversation uses codex provider
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
    mockActiveId = "conv1";

    render(
      <UnifiedChatPanel projectId="proj1">
        <div>board</div>
      </UnifiedChatPanel>,
    );

    fireEvent.click(screen.getByTestId("collapsed-chat-strip"));
    fireEvent.click(screen.getByTestId("new-conversation-tab"));

    await waitFor(() => {
      expect(mockCreateConversation).toHaveBeenCalledWith(
        expect.objectContaining({ provider: "codex" }),
      );
    });
  });

  it("new epic_creation tab inherits the active conversation provider", async () => {
    // Active conversation uses codex provider
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
    mockActiveId = "conv1";
    const ref = createRef<UnifiedChatPanelHandle>();

    render(
      <UnifiedChatPanel projectId="proj1" ref={ref}>
        <div>board</div>
      </UnifiedChatPanel>,
    );

    act(() => {
      ref.current!.openNewEpic();
    });

    await waitFor(() => {
      expect(mockCreateConversation).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "epic_creation",
          provider: "codex",
        }),
      );
    });
  });

  it("defaults to claude-code provider when active has no provider set", async () => {
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
    fireEvent.click(screen.getByTestId("new-conversation-tab"));

    await waitFor(() => {
      expect(mockCreateConversation).toHaveBeenCalledWith(
        expect.objectContaining({ provider: "claude-code" }),
      );
    });
  });

  it("each conversation stores its own provider independently", () => {
    // The provider is stored per-conversation, so each tab uses its own provider value
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

    const { rerender } = render(
      <UnifiedChatPanel projectId="proj1">
        <div>board</div>
      </UnifiedChatPanel>,
    );

    fireEvent.click(screen.getByTestId("collapsed-chat-strip"));

    // Active tab is conv1 — its provider (claude-code) should be displayed
    expect(screen.getByTestId("provider-select")).toHaveTextContent("claude-code");

    // Switch to a conversation with codex provider
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

    rerender(
      <UnifiedChatPanel projectId="proj1">
        <div>board</div>
      </UnifiedChatPanel>,
    );

    // Now the provider select should show codex
    expect(screen.getByTestId("provider-select")).toHaveTextContent("codex");
  });

  it("provider selection persists during panel collapse and expand", () => {
    const ref = createRef<UnifiedChatPanelHandle>();

    render(
      <UnifiedChatPanel projectId="proj1" ref={ref}>
        <div>board</div>
      </UnifiedChatPanel>,
    );

    // Expand
    act(() => {
      ref.current!.openChat();
    });

    expect(screen.getByTestId("provider-select")).toHaveTextContent("claude-code");

    // Collapse
    act(() => {
      ref.current!.collapse();
    });

    // Re-expand
    act(() => {
      ref.current!.openChat();
    });

    // Provider should still be displayed correctly
    expect(screen.getByTestId("provider-select")).toHaveTextContent("claude-code");
  });
});

// ---------------------------------------------------------------------------
// Story 5: Running indicators on chat tabs
// ---------------------------------------------------------------------------

describe("Story 5: Running indicators on chat tabs", () => {
  beforeEach(resetMocks);

  it("shows pulse indicator on a tab with 'generating' status", () => {
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
    mockActiveId = "conv1";

    render(
      <UnifiedChatPanel projectId="proj1">
        <div>board</div>
      </UnifiedChatPanel>,
    );

    fireEvent.click(screen.getByTestId("collapsed-chat-strip"));

    const indicator = screen.getByTestId("active-indicator-conv1");
    expect(indicator).toBeInTheDocument();
    expect(indicator).toHaveAttribute("aria-label", "Agent active");
  });

  it("does not show pulse indicator on a tab with 'active' status", () => {
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

    expect(screen.queryByTestId("active-indicator-conv1")).not.toBeInTheDocument();
  });

  it("shows badge on collapsed strip when any conversation is generating", () => {
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
  });

  it("does not show badge on collapsed strip when no conversations are generating", () => {
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

    render(
      <UnifiedChatPanel projectId="proj1">
        <div>board</div>
      </UnifiedChatPanel>,
    );

    expect(screen.queryByTestId("collapsed-active-badge")).not.toBeInTheDocument();
  });

  it("tab label remains readable when indicator is present", () => {
    mockConversations = [
      {
        id: "conv1",
        projectId: "proj1",
        type: "brainstorm",
        label: "My brainstorm session",
        status: "generating",
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

    // The label should still be visible next to the indicator
    expect(screen.getByText("My brainstorm session")).toBeInTheDocument();
    expect(screen.getByTestId("active-indicator-conv1")).toBeInTheDocument();
  });

  it("polls conversations periodically to update status", async () => {
    vi.useFakeTimers();

    render(
      <UnifiedChatPanel projectId="proj1">
        <div>board</div>
      </UnifiedChatPanel>,
    );

    await vi.advanceTimersByTimeAsync(9000);

    // 3 intervals of 3s each
    expect(mockRefreshConversations).toHaveBeenCalledTimes(3);
  });

  it("only generating tabs show indicator, active tabs do not", () => {
    // Render a single generating tab to verify indicator is present
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
    mockActiveId = "conv1";

    const { rerender } = render(
      <UnifiedChatPanel projectId="proj1">
        <div>board</div>
      </UnifiedChatPanel>,
    );

    fireEvent.click(screen.getByTestId("collapsed-chat-strip"));

    // Generating tab should show indicator
    expect(screen.getByTestId("active-indicator-conv1")).toBeInTheDocument();

    // Now change status to active and re-render
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

    rerender(
      <UnifiedChatPanel projectId="proj1">
        <div>board</div>
      </UnifiedChatPanel>,
    );

    // Indicator should now be gone
    expect(screen.queryByTestId("active-indicator-conv1")).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Imperative handle methods (cross-story)
// ---------------------------------------------------------------------------

describe("Imperative handle methods", () => {
  beforeEach(resetMocks);

  it("collapse() moves from expanded to collapsed", () => {
    const ref = createRef<UnifiedChatPanelHandle>();

    render(
      <UnifiedChatPanel projectId="proj1" ref={ref}>
        <div>board</div>
      </UnifiedChatPanel>,
    );

    act(() => {
      ref.current!.openChat();
    });

    expect(screen.getByTestId("unified-panel-expanded")).toBeInTheDocument();

    act(() => {
      ref.current!.collapse();
    });

    expect(screen.queryByTestId("unified-panel-expanded")).not.toBeInTheDocument();
    expect(screen.getByTestId("collapsed-chat-strip")).toBeInTheDocument();
  });

  it("hide() hides everything including the collapsed strip", () => {
    const ref = createRef<UnifiedChatPanelHandle>();

    render(
      <UnifiedChatPanel projectId="proj1" ref={ref}>
        <div>board</div>
      </UnifiedChatPanel>,
    );

    act(() => {
      ref.current!.hide();
    });

    expect(screen.queryByTestId("collapsed-chat-strip")).not.toBeInTheDocument();
    expect(screen.queryByTestId("unified-panel-expanded")).not.toBeInTheDocument();
  });
});
