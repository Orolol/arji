import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { forwardRef, useCallback, useImperativeHandle, useState, type ReactNode } from "react";

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

vi.mock("@/components/kanban/Board", () => ({
  Board: ({
    onEpicClick,
    onToggleSelect,
    selectedEpics,
  }: {
    onEpicClick: (id: string) => void;
    onToggleSelect?: (id: string) => void;
    selectedEpics: Set<string>;
  }) => (
    <div data-testid="board">
      <button data-testid="primary-epic-1" onClick={() => onEpicClick("epic-1")}>
        Open Epic 1
      </button>
      <button data-testid="primary-epic-2" onClick={() => onEpicClick("epic-2")}>
        Open Epic 2
      </button>
      <button data-testid="toggle-epic-1" onClick={() => onToggleSelect?.("epic-1")}>
        Toggle Epic 1
      </button>
      <button data-testid="toggle-epic-2" onClick={() => onToggleSelect?.("epic-2")}>
        Toggle Epic 2
      </button>
      <span data-testid="board-selected-count">{selectedEpics.size}</span>
    </div>
  ),
}));

vi.mock("@/components/kanban/EpicDetail", () => ({
  EpicDetail: ({
    epicId,
    onClose,
  }: {
    epicId: string;
    onClose: () => void;
  }) => (
    <div data-testid="epic-detail">
      Detail: {epicId}
      <button data-testid="close-detail" onClick={onClose}>
        Close
      </button>
    </div>
  ),
}));

vi.mock("@/components/chat/UnifiedChatPanel", () => ({
  UnifiedChatPanel: forwardRef(
    (
      {
        children,
        sharedPanelView,
      }: {
        children: ReactNode;
        sharedPanelView?: {
          content: ReactNode;
          onClose?: () => void;
        } | null;
      },
      ref
    ) => {
      useImperativeHandle(ref, () => ({
        openChat: vi.fn(),
        openNewEpic: vi.fn(),
        collapse: vi.fn(),
        hide: vi.fn(),
      }));

      return (
        <div data-testid="unified-chat-panel">
          <div>{children}</div>
          {sharedPanelView ? (
            <aside data-testid="shared-panel">
              {sharedPanelView.content}
              <button
                data-testid="shared-panel-close"
                onClick={() => sharedPanelView.onClose?.()}
              >
                Close Shared
              </button>
            </aside>
          ) : null}
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

import KanbanPage from "@/app/projects/[projectId]/page";

describe("kanban ticket detail selection flow", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("primary click selects ticket and opens detail panel in one action", () => {
    render(<KanbanPage />);

    fireEvent.click(screen.getByTestId("primary-epic-1"));

    expect(screen.getByText("1 epic selected")).toBeInTheDocument();
    expect(screen.getByTestId("shared-panel")).toBeInTheDocument();
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
    expect(screen.queryByTestId("shared-panel")).not.toBeInTheDocument();
    expect(screen.queryByText(/epic selected/)).not.toBeInTheDocument();
  });

  it("keeps board controls interactive while details are open", () => {
    render(<KanbanPage />);

    fireEvent.click(screen.getByTestId("primary-epic-1"));
    fireEvent.click(screen.getByTestId("toggle-epic-2"));

    expect(screen.getByTestId("board-selected-count")).toHaveTextContent("2");
    expect(screen.getByText("Detail: epic-1")).toBeInTheDocument();
  });

  it("closing shared panel clears selection without navigating away from board", () => {
    render(<KanbanPage />);

    fireEvent.click(screen.getByTestId("primary-epic-1"));
    fireEvent.click(screen.getByTestId("shared-panel-close"));

    expect(screen.queryByTestId("shared-panel")).not.toBeInTheDocument();
    expect(screen.queryByText(/epic selected/)).not.toBeInTheDocument();
    expect(screen.getByTestId("board")).toBeInTheDocument();
  });
});
