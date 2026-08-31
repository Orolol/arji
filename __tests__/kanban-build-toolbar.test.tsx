import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { forwardRef, useImperativeHandle, useState, useCallback, type ReactNode } from "react";

// Mock EventSource (used by useProjectEvents)
class MockEventSource {
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  close() {}
}
(globalThis as Record<string, unknown>).EventSource = MockEventSource;

// Mock next/navigation. The header actions moved to the project chrome and
// reach this page through `?panel=`, so the search params are per-test state.
const routerReplace = vi.fn();
let searchParams = new URLSearchParams();

vi.mock("next/navigation", () => ({
  useParams: () => ({ projectId: "proj1" }),
  useRouter: () => ({ replace: routerReplace }),
  useSearchParams: () => searchParams,
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
    function UnifiedChatPanelMock({ children }: { children: ReactNode }, ref) {
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

// Mock NamedAgentSelect
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
  const teamCheckbox = () =>
    screen
      .getAllByRole("checkbox")
      .find((cb) => cb.closest("label")?.textContent?.includes("Team mode"))!;

  beforeEach(() => {
    vi.restoreAllMocks();
    mockPanelOpenChat.mockClear();
    mockPanelOpenNewEpic.mockClear();
    routerReplace.mockClear();
    searchParams = new URLSearchParams();
    global.fetch = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ data: { count: 1 } }),
    });
  });

  it("?panel=chat calls openChat on UnifiedChatPanel ref and strips the param", async () => {
    searchParams = new URLSearchParams("panel=chat");
    render(<KanbanPage />);

    await waitFor(() => expect(mockPanelOpenChat).toHaveBeenCalledTimes(1));
    expect(mockPanelOpenNewEpic).not.toHaveBeenCalled();
    expect(routerReplace).toHaveBeenCalledWith("/projects/proj1");
  });

  it("?panel=new-epic calls openNewEpic on UnifiedChatPanel ref", async () => {
    searchParams = new URLSearchParams("panel=new-epic");
    render(<KanbanPage />);

    await waitFor(() => expect(mockPanelOpenNewEpic).toHaveBeenCalledTimes(1));
    expect(mockPanelOpenChat).not.toHaveBeenCalled();
  });

  it("?panel=new-epic-manual opens the manual epic dialog and strips the param", async () => {
    searchParams = new URLSearchParams("panel=new-epic-manual");
    render(<KanbanPage />);

    // The menu that pushes this param lives in the project chrome, a layout
    // that outlives this page, so the param string is the only contract
    // between them. Without this, either side could be renamed and the whole
    // manual entry would go dead with every other test still green.
    await screen.findByTestId("epic-create-dialog");
    expect(routerReplace).toHaveBeenCalledWith("/projects/proj1");
  });

  it("?panel=new-epic-manual never reaches for the chat panel", async () => {
    searchParams = new URLSearchParams("panel=new-epic-manual");
    render(<KanbanPage />);
    await screen.findByTestId("epic-create-dialog");

    // Manual creation exists to skip the agent round-trip: touching the chat
    // panel here — even to warm it up or pre-create a conversation — is the
    // exact cost this path promises not to pay.
    expect(mockPanelOpenChat).not.toHaveBeenCalled();
    expect(mockPanelOpenNewEpic).not.toHaveBeenCalled();
  });

  it("reopens the manual epic dialog when the entry is picked a second time", async () => {
    // Writing several epics back to back is the whole point of the manual
    // path, and the New menu can only reach this page through ?panel=, which
    // is consumed once per value. So the strip landing has to *release* the
    // guard: without that, the second pick of the same entry is silently dead
    // for the life of the mount — the menu navigates, nothing opens, and the
    // chat entry still works, so it reads as a bug in manual creation alone.
    searchParams = new URLSearchParams("panel=new-epic-manual");
    const { rerender } = render(<KanbanPage />);
    await screen.findByTestId("epic-create-dialog");

    // The user cancels, and the replace() asserted above lands: no param.
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    searchParams = new URLSearchParams();
    rerender(<KanbanPage />);
    await waitFor(() =>
      expect(screen.queryByTestId("epic-create-dialog")).not.toBeInTheDocument()
    );

    // Same entry, same param string, same board mount.
    searchParams = new URLSearchParams("panel=new-epic-manual");
    rerender(<KanbanPage />);

    await screen.findByTestId("epic-create-dialog");
  });

  it("does not touch the panel without a panel param", async () => {
    render(<KanbanPage />);
    await screen.findByTestId("board");
    expect(mockPanelOpenChat).not.toHaveBeenCalled();
    expect(mockPanelOpenNewEpic).not.toHaveBeenCalled();
    expect(screen.queryByTestId("epic-create-dialog")).not.toBeInTheDocument();
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

  it("retires team mode when the selection drops below two", () => {
    render(<KanbanPage />);
    fireEvent.click(screen.getByTestId("toggle-epic1"));
    fireEvent.click(screen.getByTestId("toggle-epic2"));
    fireEvent.click(teamCheckbox());
    expect(screen.getByText("Build as Team")).toBeInTheDocument();

    // Deselecting hides the control, which on its own only *masks* the choice.
    fireEvent.click(screen.getByTestId("toggle-epic2"));
    expect(screen.queryByText("Team mode")).not.toBeInTheDocument();

    // Re-selecting a second epic must not resurrect a decision the user made
    // about a selection that no longer exists.
    fireEvent.click(screen.getByTestId("toggle-epic2"));
    expect(teamCheckbox()).not.toBeChecked();
    expect(screen.getByText("Build all")).toBeInTheDocument();
  });

  it("does not send team: true after a retired team mode is re-selected into range", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ data: { count: 2 } }),
    });
    global.fetch = mockFetch;

    render(<KanbanPage />);
    fireEvent.click(screen.getByTestId("toggle-epic1"));
    fireEvent.click(screen.getByTestId("toggle-epic2"));
    fireEvent.click(teamCheckbox());

    // Down to one epic and back up to two, without ever re-checking the box.
    fireEvent.click(screen.getByTestId("toggle-epic2"));
    fireEvent.click(screen.getByTestId("toggle-epic3"));

    // Matched loosely on purpose: the label is the symptom, the request body
    // below is the defect.
    fireEvent.click(screen.getByRole("button", { name: /Build (all|as Team)/ }));

    await waitFor(() => {
      const call = mockFetch.mock.calls.find(
        (c: unknown[]) => typeof c[0] === "string" && c[0].endsWith("/build")
      );
      expect(call).toBeTruthy();
      expect(JSON.parse(call![1].body).team).toBe(false);
    });
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

    // endsWith, not includes: the page also polls /build/night-runs.
    const call = mockFetch.mock.calls.find(
      (c: unknown[]) => typeof c[0] === "string" && c[0].endsWith("/build")
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
