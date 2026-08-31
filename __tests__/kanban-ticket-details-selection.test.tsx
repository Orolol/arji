import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { forwardRef, useCallback, useImperativeHandle, useState, type ReactNode } from "react";

// Mock EventSource (used by useProjectEvents)
class MockEventSource {
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  close() {}
}
(globalThis as Record<string, unknown>).EventSource = MockEventSource;

vi.mock("next/navigation", () => ({
  useParams: () => ({ projectId: "proj-1" }),
  useRouter: () => ({ replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/hooks/useAgentPolling", () => ({
  useAgentPolling: () => ({ activities: [] }),
}));

vi.mock("@/hooks/useBatchSelection", () => ({
  useBatchSelection: () => {
    const [selectedTicketIds, setSelectedTicketIds] = useState<string[]>([]);
    const userSelected = new Set(selectedTicketIds);
    const autoIncluded = new Set<string>();
    const allSelected = new Set(selectedTicketIds);

    const toggle = useCallback((ticketId: string) => {
      setSelectedTicketIds((prev) =>
        prev.includes(ticketId)
          ? prev.filter((id) => id !== ticketId)
          : [...prev, ticketId]
      );
    }, []);

    const clear = useCallback(() => {
      setSelectedTicketIds([]);
    }, []);

    return {
      allSelected,
      userSelected,
      autoIncluded,
      selectedTicketIds,
      loading: false,
      selectPrimary: (ticketId: string) => setSelectedTicketIds([ticketId]),
      setSelectedTicketIds: (ticketIds: string[]) => setSelectedTicketIds(ticketIds),
      toggle,
      clear,
      isAutoIncluded: (id: string) => autoIncluded.has(id),
      isUserSelected: (id: string) => userSelected.has(id),
    };
  },
}));

// The board is gone; the route renders the project-filtered control desk.
// `onOpenTicket` is the desk's plain ticket click and `onToggleSelect` its
// ⌘/Ctrl-click — the same two gestures the board exposed, same page contract.
vi.mock("@/components/desk/NowDesk", () => ({
  NowDesk: ({
    onOpenTicket,
    onToggleSelect,
    selectedEpicIds,
  }: {
    onOpenTicket: (id: string) => void;
    onToggleSelect?: (id: string) => void;
    selectedEpicIds: ReadonlySet<string>;
  }) => (
    <div data-testid="board">
      <button data-testid="primary-epic-1" onClick={() => onOpenTicket("epic-1")}>
        Open Epic 1
      </button>
      <button data-testid="primary-epic-2" onClick={() => onOpenTicket("epic-2")}>
        Open Epic 2
      </button>
      <button data-testid="toggle-epic-1" onClick={() => onToggleSelect?.("epic-1")}>
        Toggle Epic 1
      </button>
      <button data-testid="toggle-epic-2" onClick={() => onToggleSelect?.("epic-2")}>
        Toggle Epic 2
      </button>
      <span data-testid="board-selected-count">{selectedEpicIds.size}</span>
    </div>
  ),
}));

// The ticket is a modal overlay now (frame 6a), not a column inside the chat
// panel — but the page contract is unchanged: the batch selection's active
// ticket is what opens, and closing clears the selection.
vi.mock("@/components/ticket/TicketOverlay", () => ({
  TicketOverlay: ({
    epicId,
    onClose,
  }: {
    epicId: string;
    onClose: () => void;
  }) => (
    <div data-testid="ticket-overlay">
      Detail: {epicId}
      <button data-testid="ticket-overlay-close" onClick={onClose}>
        Close
      </button>
    </div>
  ),
}));

vi.mock("@/components/chat/UnifiedChatPanel", () => ({
  UnifiedChatPanel: forwardRef(
    function UnifiedChatPanelMock({ children }: { children: ReactNode }, ref) {
      useImperativeHandle(ref, () => ({
        openChat: vi.fn(),
        openNewEpic: vi.fn(),
        collapse: vi.fn(),
        hide: vi.fn(),
      }));

      return (
        <div data-testid="unified-chat-panel">
          <div>{children}</div>
        </div>
      );
    }
  ),
}));

vi.mock("@/components/monitor/AgentMonitor", () => ({
  AgentMonitor: () => null,
}));

vi.mock("@/components/shared/NamedAgentSelect", () => ({
  NamedAgentSelect: () => <div data-testid="named-agent-select" />,
}));

vi.mock("@/components/kanban/BugCreateDialog", () => ({
  BugCreateDialog: () => null,
}));

vi.mock("@/components/auto-mode/AutoModeToggle", () => ({
  AutoModeToggle: () => null,
}));
vi.mock("@/components/kanban/RefinementButton", () => ({
  RefinementButton: () => null,
}));

import KanbanPage from "@/app/projects/[projectId]/page";

describe("kanban ticket detail selection flow", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("primary click selects ticket and opens the ticket overlay in one action", () => {
    render(<KanbanPage />);

    fireEvent.click(screen.getByTestId("primary-epic-1"));

    expect(screen.getByText("1 epic selected")).toBeInTheDocument();
    expect(screen.getByTestId("ticket-overlay")).toBeInTheDocument();
    expect(screen.getByText("Detail: epic-1")).toBeInTheDocument();
  });

  it("additive selection keeps details anchored to the first-selected ticket", () => {
    render(<KanbanPage />);

    fireEvent.click(screen.getByTestId("primary-epic-1"));
    fireEvent.click(screen.getByTestId("toggle-epic-2"));

    expect(screen.getByText("2 epics selected")).toBeInTheDocument();
    expect(screen.getByText("Detail: epic-1")).toBeInTheDocument();
  });

  it("promotes next-oldest selection when first-selected ticket is removed", () => {
    render(<KanbanPage />);

    fireEvent.click(screen.getByTestId("primary-epic-1"));
    fireEvent.click(screen.getByTestId("toggle-epic-2"));
    fireEvent.click(screen.getByTestId("toggle-epic-1"));

    expect(screen.getByText("1 epic selected")).toBeInTheDocument();
    expect(screen.getByText("Detail: epic-2")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("toggle-epic-2"));
    expect(screen.queryByTestId("ticket-overlay")).not.toBeInTheDocument();
    expect(screen.queryByText(/epic selected/)).not.toBeInTheDocument();
  });

  it("keeps desk controls interactive while the overlay is open", () => {
    render(<KanbanPage />);

    fireEvent.click(screen.getByTestId("primary-epic-1"));
    fireEvent.click(screen.getByTestId("toggle-epic-2"));

    expect(screen.getByTestId("board-selected-count")).toHaveTextContent("2");
    expect(screen.getByText("Detail: epic-1")).toBeInTheDocument();
  });

  it("closing the overlay clears selection without navigating away from the desk", () => {
    render(<KanbanPage />);

    fireEvent.click(screen.getByTestId("primary-epic-1"));
    fireEvent.click(screen.getByTestId("ticket-overlay-close"));

    expect(screen.queryByTestId("ticket-overlay")).not.toBeInTheDocument();
    expect(screen.queryByText(/epic selected/)).not.toBeInTheDocument();
    expect(screen.getByTestId("board")).toBeInTheDocument();
  });
});
