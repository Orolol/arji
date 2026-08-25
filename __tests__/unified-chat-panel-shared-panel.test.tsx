import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { UnifiedChatPanel } from "@/components/chat/UnifiedChatPanel";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

vi.mock("@/hooks/useConversations", () => ({
  useConversations: () => ({
    conversations: [
      {
        id: "conv-1",
        projectId: "proj-1",
        type: "brainstorm",
        label: "Brainstorm",
        status: "active",
        epicId: null,
        provider: "claude-code",
        createdAt: "2026-02-01T00:00:00.000Z",
      },
    ],
    activeId: "conv-1",
    setActiveId: vi.fn(),
    createConversation: vi.fn(),
    updateConversation: vi.fn(),
    deleteConversation: vi.fn(),
    refresh: vi.fn(),
    loading: false,
  }),
}));

vi.mock("@/hooks/useChat", () => ({
  useChat: () => ({
    messages: [],
    loading: false,
    sending: false,
    pendingQuestions: null,
    streamStatus: null,
    sendMessage: vi.fn(),
    answerQuestions: vi.fn(),
    error: null,
  }),
}));

vi.mock("@/hooks/useEpicCreate", () => ({
  useEpicCreate: () => ({
    createEpic: vi.fn(),
    isLoading: false,
    error: null,
  }),
}));

vi.mock("@/components/chat/MessageList", () => ({
  MessageList: () => <div data-testid="message-list" />,
}));

vi.mock("@/components/chat/MessageInput", () => ({
  MessageInput: () => <div data-testid="message-input" />,
}));

vi.mock("@/components/chat/QuestionCards", () => ({
  QuestionCards: () => null,
}));

// Mock Sheet components for the mobile tests (same pattern as
// unified-chat-panel-mobile-persist.test.tsx): jsdom + Radix Dialog is
// flaky, and the layout contract under test is which branch renders and at
// what width, not Radix internals.
vi.mock("@/components/ui/sheet", () => ({
  Sheet: ({
    children,
    open,
    onOpenChange,
  }: {
    children: ReactNode;
    open: boolean;
    onOpenChange: (open: boolean) => void;
  }) =>
    open ? (
      <div data-testid="sheet-root">
        {children}
        <button
          data-testid="sheet-close-trigger"
          onClick={() => onOpenChange(false)}
        >
          Close
        </button>
      </div>
    ) : null,
  SheetContent: ({
    children,
    ...props
  }: {
    children: ReactNode;
    className?: string;
    [key: string]: unknown;
  }) => (
    <div
      data-testid={props["data-testid"] as string}
      className={props.className as string}
    >
      {children}
    </div>
  ),
}));

function BoardFixture() {
  const [clickCount, setClickCount] = useState(0);

  return (
    <button
      data-testid="board-interaction"
      onClick={() => setClickCount((count) => count + 1)}
    >
      board-{clickCount}
    </button>
  );
}

describe("UnifiedChatPanel shared panel mode", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    window.localStorage.clear();
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      writable: true,
      value: 1200,
    });
  });

  it("renders shared panel without a modal sheet and keeps board interactive", async () => {
    render(
      <UnifiedChatPanel
        projectId="proj-1"
        sharedPanelView={{
          panelId: "epic-1",
          label: "Ticket",
          content: <div data-testid="ticket-detail-content">Ticket detail</div>,
        }}
      >
        <BoardFixture />
      </UnifiedChatPanel>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("unified-panel-shared")).toBeInTheDocument();
    });

    expect(screen.queryByTestId("unified-panel-mobile-sheet")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("board-interaction"));
    expect(screen.getByText("board-1")).toBeInTheDocument();
    expect(screen.getByTestId("ticket-detail-content")).toBeInTheDocument();
  });

  it("uses the full-width mobile Sheet for the shared panel on narrow viewports", async () => {
    // 500px is below the 768px mobile breakpoint. The desktop split layout
    // must NOT render here: with the shared width its clamps would compute a
    // ~94px panel (and a negative one below 400px), pushing the ticket out
    // of the board row. The ticket must instead get the full-width Sheet.
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      writable: true,
      value: 500,
    });

    render(
      <UnifiedChatPanel
        projectId="proj-1"
        sharedPanelView={{
          panelId: "epic-1",
          label: "Ticket",
          content: <div data-testid="ticket-detail-content">Ticket detail</div>,
        }}
      >
        <BoardFixture />
      </UnifiedChatPanel>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("unified-panel-mobile-sheet")).toBeInTheDocument();
    });

    // Width: the Sheet takes the full 500px container width (w-full, no
    // sm:max-w-sm cap), so the ticket is readable instead of squeezed into
    // a 94px aside.
    const sheet = screen.getByTestId("unified-panel-mobile-sheet");
    expect(sheet).toHaveClass("w-full");
    expect(sheet).toHaveClass("max-w-none");

    // The desktop split layout (board + divider + aside) is not rendered.
    expect(screen.queryByTestId("unified-panel-shared")).not.toBeInTheDocument();
    expect(screen.queryByTestId("panel-divider")).not.toBeInTheDocument();

    // The ticket content and the board behind the Sheet are both present,
    // and the board stays interactive.
    expect(screen.getByTestId("ticket-detail-content")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("board-interaction"));
    expect(screen.getByText("board-1")).toBeInTheDocument();
  });

  it("closes the ticket view (not the chat panel) when the mobile Sheet is dismissed in shared mode", async () => {
    const onClose = vi.fn();
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      writable: true,
      value: 500,
    });

    render(
      <UnifiedChatPanel
        projectId="proj-1"
        sharedPanelView={{
          panelId: "epic-1",
          label: "Ticket",
          onClose,
          content: <div data-testid="ticket-detail-content">Ticket detail</div>,
        }}
      >
        <BoardFixture />
      </UnifiedChatPanel>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("unified-panel-mobile-sheet")).toBeInTheDocument();
    });

    // Dismissing the Sheet in shared mode must mirror the desktop Escape
    // handling: close the ticket (parent's onClose), which syncs back to
    // chat and collapses the panel.
    fireEvent.click(screen.getByTestId("sheet-close-trigger"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("renders the shared ticket panel at the same width as the chat panel", async () => {
    render(
      <UnifiedChatPanel
        projectId="proj-1"
        sharedPanelView={{
          panelId: "epic-1",
          label: "Ticket",
          content: <div>Ticket detail</div>,
        }}
      >
        <BoardFixture />
      </UnifiedChatPanel>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("unified-panel-shared")).toBeInTheDocument();
    });

    // Default ratio 0.4 on a 1200px container → 480px.
    expect(screen.getByTestId("unified-panel-shared")).toHaveStyle({
      width: "480px",
    });

    // Switching to the chat view must not change the container width:
    // the ticket and chat panels are the same container.
    fireEvent.click(screen.getByRole("button", { name: "Chat" }));
    await waitFor(() => {
      expect(screen.getByTestId("unified-panel-expanded")).toBeInTheDocument();
    });
    expect(screen.getByTestId("unified-panel-expanded")).toHaveStyle({
      width: "480px",
    });
  });

  it("keeps chat and ticket panels at the same width at the smallest supported desktop size", async () => {
    // 768px is the mobile breakpoint boundary: the desktop layout (board +
    // divider + panel) must still render, and both views share its width.
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      writable: true,
      value: 768,
    });

    render(
      <UnifiedChatPanel
        projectId="proj-1"
        sharedPanelView={{
          panelId: "epic-1",
          label: "Ticket",
          content: <div>Ticket detail</div>,
        }}
      >
        <BoardFixture />
      </UnifiedChatPanel>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("unified-panel-shared")).toBeInTheDocument();
    });

    // 0.4 × 768 = 307.2 → 307px, inside the [300px panel min, board ≥ 400px]
    // bounds, so no clamping — but the width must be identical in both views.
    const sharedWidth = screen
      .getByTestId("unified-panel-shared")
      .style.width;
    expect(sharedWidth).toBe("307px");

    fireEvent.click(screen.getByRole("button", { name: "Chat" }));
    await waitFor(() => {
      expect(screen.getByTestId("unified-panel-expanded")).toBeInTheDocument();
    });
    expect(screen.getByTestId("unified-panel-expanded").style.width).toBe(
      sharedWidth,
    );

    // The board keeps rendering next to the panel at this size.
    expect(screen.getByTestId("board-interaction")).toBeInTheDocument();
    expect(screen.getByTestId("panel-divider")).toBeInTheDocument();
  });

  it("exposes the resize divider in the shared view, like the chat view", async () => {
    render(
      <UnifiedChatPanel
        projectId="proj-1"
        sharedPanelView={{
          panelId: "epic-1",
          label: "Ticket",
          content: <div>Ticket detail</div>,
        }}
      >
        <BoardFixture />
      </UnifiedChatPanel>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("unified-panel-shared")).toBeInTheDocument();
    });

    expect(screen.getByTestId("panel-divider")).toBeInTheDocument();
  });
});
