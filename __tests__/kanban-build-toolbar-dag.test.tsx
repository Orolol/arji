/**
 * Toolbar tests for the third batch build mode ("Waves (DAG)"): option
 * rendering, the explainer hint, and the request body it produces.
 *
 * The shadcn Select is mocked as a native <select> — Radix's popper cannot
 * be driven from jsdom — mapping value/onValueChange straight through, so
 * the page's real state wiring is still what's under test.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import {
  forwardRef,
  useImperativeHandle,
  useState,
  useCallback,
  type ReactNode,
} from "react";

// Mock EventSource (used by useProjectEvents)
class MockEventSource {
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  close() {}
}
(globalThis as Record<string, unknown>).EventSource = MockEventSource;

vi.mock("next/navigation", () => ({
  useParams: () => ({ projectId: "proj1" }),
  useRouter: () => ({ replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

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
      setSelectedTicketIds((prev) =>
        prev.includes(epicId)
          ? prev.filter((id) => id !== epicId)
          : [...prev, epicId]
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
      setSelectedTicketIds,
      toggle,
      clear,
      isAutoIncluded: (id: string) => autoIncluded.has(id),
      isUserSelected: (id: string) => userSelected.has(id),
    };
  },
}));

// Native-select stand-in for the shadcn Select (Radix popper is not
// drivable from jsdom). SelectItem -> <option>, trigger/value render nothing.
vi.mock("@/components/ui/select", () => ({
  Select: ({
    value,
    onValueChange,
    children,
  }: {
    value: string;
    onValueChange: (v: string) => void;
    children: ReactNode;
  }) => (
    <select
      data-testid="build-mode-select"
      value={value}
      onChange={(e) => onValueChange(e.target.value)}
    >
      {children}
    </select>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectItem: ({
    value,
    children,
  }: {
    value: string;
    children: ReactNode;
  }) => <option value={value}>{children}</option>,
}));

vi.mock("@/components/kanban/Board", () => ({
  Board: ({
    onToggleSelect,
  }: {
    onToggleSelect: (id: string) => void;
  }) => (
    <div data-testid="board">
      <button onClick={() => onToggleSelect("epic1")} data-testid="toggle-epic1">
        Toggle Epic 1
      </button>
      <button onClick={() => onToggleSelect("epic2")} data-testid="toggle-epic2">
        Toggle Epic 2
      </button>
    </div>
  ),
}));

vi.mock("@/components/kanban/EpicDetail", () => ({
  EpicDetail: () => null,
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
      return <div data-testid="unified-chat-panel">{children}</div>;
    }
  ),
}));

vi.mock("@/components/monitor/AgentMonitor", () => ({
  AgentMonitor: () => null,
}));

vi.mock("@/components/shared/NamedAgentSelect", () => ({
  NamedAgentSelect: () => null,
}));

import KanbanPage from "@/app/projects/[projectId]/page";

function selectDagMode() {
  fireEvent.change(screen.getByTestId("build-mode-select"), {
    target: { value: "dag" },
  });
}

describe("Kanban Build Toolbar — Waves (DAG) mode", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          data: { count: 1, orchestrationMode: "dag", waves: 3 },
        }),
    });
  });

  it("offers all three build modes, parallel still the default", () => {
    render(<KanbanPage />);
    fireEvent.click(screen.getByTestId("toggle-epic1"));

    const select = screen.getByTestId("build-mode-select") as HTMLSelectElement;
    expect(select.value).toBe("parallel");
    const labels = Array.from(select.options).map((o) => o.textContent);
    expect(labels).toEqual(["Parallel", "Sequential", "Waves (DAG)"]);
  });

  it("shows the waves explainer hint only when dag mode is selected", () => {
    render(<KanbanPage />);
    fireEvent.click(screen.getByTestId("toggle-epic1"));

    expect(screen.queryByTestId("dag-mode-hint")).not.toBeInTheDocument();
    selectDagMode();
    expect(screen.getByTestId("dag-mode-hint")).toBeInTheDocument();

    fireEvent.change(screen.getByTestId("build-mode-select"), {
      target: { value: "sequential" },
    });
    expect(screen.queryByTestId("dag-mode-hint")).not.toBeInTheDocument();
  });

  it("sends mode 'dag' in the build request", async () => {
    const mockFetch = global.fetch as ReturnType<typeof vi.fn>;

    render(<KanbanPage />);
    fireEvent.click(screen.getByTestId("toggle-epic1"));
    fireEvent.click(screen.getByTestId("toggle-epic2"));
    selectDagMode();

    fireEvent.click(screen.getByText("Build all"));

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        "/api/projects/proj1/build",
        expect.objectContaining({ method: "POST" })
      );
    });

    // endsWith, not includes: the page also polls /build/night-runs.
    const call = mockFetch.mock.calls.find(
      (c: unknown[]) => typeof c[0] === "string" && c[0].endsWith("/build")
    )!;
    const body = JSON.parse(call[1].body);
    expect(body.mode).toBe("dag");
    expect(body.team).toBe(false);
    expect(body.epicIds).toHaveLength(2);
  });

  it("leaves the existing modes untouched: parallel request body is unchanged", async () => {
    const mockFetch = global.fetch as ReturnType<typeof vi.fn>;

    render(<KanbanPage />);
    fireEvent.click(screen.getByTestId("toggle-epic1"));
    fireEvent.click(screen.getByText("Build all"));

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalled();
    });

    // endsWith, not includes: the page also polls /build/night-runs.
    const call = mockFetch.mock.calls.find(
      (c: unknown[]) => typeof c[0] === "string" && c[0].endsWith("/build")
    )!;
    const body = JSON.parse(call[1].body);
    expect(body.mode).toBe("parallel");
  });

  it("announces the wave launch in the success toast", async () => {
    render(<KanbanPage />);
    fireEvent.click(screen.getByTestId("toggle-epic1"));
    selectDagMode();
    fireEvent.click(screen.getByText("Build all"));

    await waitFor(() => {
      expect(
        screen.getByText(/Launched wave 1\/3/)
      ).toBeInTheDocument();
    });
  });
});
