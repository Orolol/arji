import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { forwardRef, useImperativeHandle, useState, useCallback, type ReactNode } from "react";

// Mock next/navigation
vi.mock("next/navigation", () => ({
  useParams: () => ({ projectId: "proj1" }),
  useRouter: () => ({ replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

// Mock hooks
const mockAgentPolling = { activities: [] };
vi.mock("@/hooks/useAgentPolling", () => ({
  useAgentPolling: () => mockAgentPolling,
}));

// Mock useBatchSelection using React state so toggle/clear trigger re-renders
vi.mock("@/hooks/useBatchSelection", () => ({
  useBatchSelection: () => {
    const [selectedTicketIds, setSelectedTicketIds] = useState<string[]>([]);
    const userSelected = new Set(selectedTicketIds);
    const [autoIncluded] = useState<Set<string>>(new Set());
    const allSelected = new Set([...selectedTicketIds, ...autoIncluded]);

    const toggle = useCallback((epicId: string) => {
      setSelectedTicketIds((prev) => {
        if (prev.includes(epicId)) {
          return prev.filter((id) => id !== epicId);
        }
        return [...prev, epicId];
      });
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
      setSelectedTicketIds,
      toggle,
      clear,
      isAutoIncluded: (id: string) => autoIncluded.has(id),
      isUserSelected: (id: string) => userSelected.has(id),
    };
  },
}));

// Mock child components to simplify rendering
vi.mock("@/components/kanban/Board", () => ({
  Board: ({ selectedEpics, onToggleSelect }: {
    selectedEpics: Set<string>;
    onToggleSelect: (id: string) => void;
  }) => (
    <div data-testid="board">
      <button onClick={() => onToggleSelect("epic1")} data-testid="toggle-epic1">
        Toggle Epic 1
      </button>
      <button onClick={() => onToggleSelect("epic2")} data-testid="toggle-epic2">
        Toggle Epic 2
      </button>
      <button onClick={() => onToggleSelect("epic3")} data-testid="toggle-epic3">
        Toggle Epic 3
      </button>
    </div>
  ),
}));

vi.mock("@/components/kanban/EpicDetail", () => ({
  EpicDetail: () => null,
}));

const mockPanelOpenChat = vi.fn();
const mockPanelOpenNewEpic = vi.fn();

vi.mock("@/components/chat/UnifiedChatPanel", () => ({
  UnifiedChatPanel: forwardRef(
    ({ children }: { children: ReactNode }, ref) => {
      useImperativeHandle(ref, () => ({
        openChat: mockPanelOpenChat,
        openNewEpic: mockPanelOpenNewEpic,
        collapse: vi.fn(),
        hide: vi.fn(),
      }));

      return <div data-testid="unified-chat-panel">{children}</div>;
    }
  ),
}));

vi.mock("@/components/monitor/AgentMonitor", () => ({
  AgentMonitor: () => null,
}));

// Mock NamedAgentSelect (replaces old ProviderSelect)
vi.mock("@/components/shared/NamedAgentSelect", () => ({
  NamedAgentSelect: ({ value, onChange }: {
    value: string | null;
    onChange: (v: string) => void;
  }) => (
    <select
      data-testid="build-agent-select"
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">Default agent</option>
      <option value="agent-1">Claude Code</option>
      <option value="agent-2">Codex Agent</option>
    </select>
  ),
}));

import KanbanPage from "@/app/projects/[projectId]/page";

describe("Kanban Build Toolbar", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockPanelOpenChat.mockClear();
    mockPanelOpenNewEpic.mockClear();
    global.fetch = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ data: { count: 1 } }),
    });
  });

  it("chat toolbar button calls openChat on UnifiedChatPanel ref", () => {
    render(<KanbanPage />);
    fireEvent.click(screen.getByRole("button", { name: "Chat" }));
    expect(mockPanelOpenChat).toHaveBeenCalledTimes(1);
  });

  it("new epic toolbar button calls openNewEpic on UnifiedChatPanel ref", () => {
    render(<KanbanPage />);
    fireEvent.click(screen.getByRole("button", { name: "New Epic" }));
    expect(mockPanelOpenNewEpic).toHaveBeenCalledTimes(1);
  });

  it("does not show build toolbar when no epics selected", () => {
    render(<KanbanPage />);
    expect(screen.queryByText(/selected/)).not.toBeInTheDocument();
  });

  it("shows build toolbar when an epic is selected", () => {
    render(<KanbanPage />);
    fireEvent.click(screen.getByTestId("toggle-epic1"));
    expect(screen.getByText("1 epic selected")).toBeInTheDocument();
  });

  it("shows agent select in build toolbar", () => {
    render(<KanbanPage />);
    fireEvent.click(screen.getByTestId("toggle-epic1"));
    expect(screen.getByTestId("build-agent-select")).toBeInTheDocument();
  });

  it("does not show team mode checkbox with < 2 epics", () => {
    render(<KanbanPage />);
    fireEvent.click(screen.getByTestId("toggle-epic1"));
    expect(screen.queryByText("Team mode")).not.toBeInTheDocument();
  });

  it("shows team mode checkbox when 2+ epics selected", () => {
    render(<KanbanPage />);
    fireEvent.click(screen.getByTestId("toggle-epic1"));
    fireEvent.click(screen.getByTestId("toggle-epic2"));
    expect(screen.getByText("Team mode")).toBeInTheDocument();
  });

  it("team mode checkbox is enabled by default", () => {
    render(<KanbanPage />);
    fireEvent.click(screen.getByTestId("toggle-epic1"));
    fireEvent.click(screen.getByTestId("toggle-epic2"));
    const checkboxes = screen.getAllByRole("checkbox");
    const teamCheckbox = checkboxes.find(
      (cb) => cb.closest("label")?.textContent?.includes("Team mode")
    );
    expect(teamCheckbox).toBeTruthy();
    expect(teamCheckbox).not.toBeDisabled();
  });

  it("build button shows 'Build as Team' when team mode enabled", () => {
    render(<KanbanPage />);
    fireEvent.click(screen.getByTestId("toggle-epic1"));
    fireEvent.click(screen.getByTestId("toggle-epic2"));
    // Enable team mode
    const checkboxes = screen.getAllByRole("checkbox");
    const teamCheckbox = checkboxes.find(
      (cb) => cb.closest("label")?.textContent?.includes("Team mode")
    )!;
    fireEvent.click(teamCheckbox);
    expect(screen.getByText("Build as Team")).toBeInTheDocument();
  });

  it("build button shows 'Build all' when team mode disabled", () => {
    render(<KanbanPage />);
    fireEvent.click(screen.getByTestId("toggle-epic1"));
    expect(screen.getByText("Build all")).toBeInTheDocument();
  });

  it("sends team and namedAgentId in build request", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ data: { count: 1 } }),
    });
    global.fetch = mockFetch;

    render(<KanbanPage />);
    fireEvent.click(screen.getByTestId("toggle-epic1"));
    fireEvent.click(screen.getByTestId("toggle-epic2"));

    // Enable team mode
    const checkboxes = screen.getAllByRole("checkbox");
    const teamCheckbox = checkboxes.find(
      (cb) => cb.closest("label")?.textContent?.includes("Team mode")
    )!;
    fireEvent.click(teamCheckbox);

    // Click build
    fireEvent.click(screen.getByText("Build as Team"));

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        "/api/projects/proj1/build",
        expect.objectContaining({
          method: "POST",
          body: expect.any(String),
        })
      );
    });

    const call = mockFetch.mock.calls.find(
      (c: unknown[]) => typeof c[0] === "string" && c[0].includes("/build")
    );
    expect(call).toBeTruthy();
    const body = JSON.parse(call![1].body);
    expect(body.team).toBe(true);
    expect(body.namedAgentId).toBe(null);
    expect(body.epicIds).toHaveLength(2);
  });

  it("clear button deselects all epics", () => {
    render(<KanbanPage />);
    fireEvent.click(screen.getByTestId("toggle-epic1"));
    fireEvent.click(screen.getByTestId("toggle-epic2"));
    expect(screen.getByText("2 epics selected")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Clear"));
    expect(screen.queryByText(/selected/)).not.toBeInTheDocument();
  });

  it("shows auto-fix checkbox when 2+ epics selected", () => {
    render(<KanbanPage />);
    fireEvent.click(screen.getByTestId("toggle-epic1"));
    fireEvent.click(screen.getByTestId("toggle-epic2"));
    expect(screen.getByText("Auto-fix")).toBeInTheDocument();
    expect(screen.getByTestId("auto-merge-agent-checkbox")).toBeInTheDocument();
  });

  it("does not show auto-fix checkbox with < 2 epics", () => {
    render(<KanbanPage />);
    fireEvent.click(screen.getByTestId("toggle-epic1"));
    expect(screen.queryByText("Auto-fix")).not.toBeInTheDocument();
  });

  it("sends autoAgent in merge request when auto-fix is enabled", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: { merged: true } }),
    });
    global.fetch = mockFetch;

    render(<KanbanPage />);
    fireEvent.click(screen.getByTestId("toggle-epic1"));
    fireEvent.click(screen.getByTestId("toggle-epic2"));

    // Enable auto-fix
    fireEvent.click(screen.getByTestId("auto-merge-agent-checkbox"));

    // Click Merge all
    fireEvent.click(screen.getByText("Merge all"));

    await waitFor(() => {
      const mergeCalls = mockFetch.mock.calls.filter(
        (c: unknown[]) => typeof c[0] === "string" && c[0].includes("/merge")
      );
      expect(mergeCalls.length).toBeGreaterThan(0);
      const body = JSON.parse(mergeCalls[0][1].body);
      expect(body.autoAgent).toBe(true);
    });
  });
});
