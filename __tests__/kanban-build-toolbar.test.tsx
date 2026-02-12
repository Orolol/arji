import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// Mock next/navigation
vi.mock("next/navigation", () => ({
  useParams: () => ({ projectId: "proj1" }),
}));

// Mock hooks
const mockAgentPolling = { activeSessions: [] };
vi.mock("@/hooks/useAgentPolling", () => ({
  useAgentPolling: () => mockAgentPolling,
}));

let mockCodexAvailable = false;
vi.mock("@/hooks/useCodexAvailable", () => ({
  useCodexAvailable: () => ({ codexAvailable: mockCodexAvailable, loading: false }),
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

vi.mock("@/components/kanban/CreateEpicSheet", () => ({
  CreateEpicSheet: () => null,
}));

vi.mock("@/components/chat/UnifiedChatPanel", () => ({
  UnifiedChatPanel: ({ children }: { children: unknown }) => (
    <div data-testid="unified-chat-panel">{children}</div>
  ),
}));

vi.mock("@/components/monitor/AgentMonitor", () => ({
  AgentMonitor: () => null,
}));

vi.mock("@/components/shared/ProviderSelect", () => ({
  ProviderSelect: ({ value, onChange, codexAvailable }: {
    value: string;
    onChange: (v: string) => void;
    codexAvailable: boolean;
  }) => (
    <select
      data-testid="build-provider-select"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="claude-code">Claude Code</option>
      {codexAvailable && <option value="codex">Codex</option>}
    </select>
  ),
}));

import KanbanPage from "@/app/projects/[projectId]/page";

describe("Kanban Build Toolbar", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockCodexAvailable = false;
    global.fetch = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ data: { count: 1 } }),
    });
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

  it("shows provider select in build toolbar", () => {
    render(<KanbanPage />);
    fireEvent.click(screen.getByTestId("toggle-epic1"));
    expect(screen.getByTestId("build-provider-select")).toBeInTheDocument();
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

  it("team mode checkbox is enabled with claude-code provider", () => {
    render(<KanbanPage />);
    fireEvent.click(screen.getByTestId("toggle-epic1"));
    fireEvent.click(screen.getByTestId("toggle-epic2"));
    const checkbox = screen.getByRole("checkbox");
    expect(checkbox).not.toBeDisabled();
  });

  it("team mode checkbox is disabled with codex provider", () => {
    mockCodexAvailable = true;
    render(<KanbanPage />);
    fireEvent.click(screen.getByTestId("toggle-epic1"));
    fireEvent.click(screen.getByTestId("toggle-epic2"));
    // Switch to codex
    const select = screen.getByTestId("build-provider-select");
    fireEvent.change(select, { target: { value: "codex" } });
    const checkbox = screen.getByRole("checkbox");
    expect(checkbox).toBeDisabled();
  });

  it("build button shows 'Build as Team' when team mode enabled", () => {
    render(<KanbanPage />);
    fireEvent.click(screen.getByTestId("toggle-epic1"));
    fireEvent.click(screen.getByTestId("toggle-epic2"));
    // Enable team mode
    const checkbox = screen.getByRole("checkbox");
    fireEvent.click(checkbox);
    expect(screen.getByText("Build as Team")).toBeInTheDocument();
  });

  it("build button shows provider name when team mode disabled", () => {
    render(<KanbanPage />);
    fireEvent.click(screen.getByTestId("toggle-epic1"));
    expect(screen.getByText("Build with Claude Code")).toBeInTheDocument();
  });

  it("sends team and provider in build request", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ data: { count: 1 } }),
    });
    global.fetch = mockFetch;

    render(<KanbanPage />);
    fireEvent.click(screen.getByTestId("toggle-epic1"));
    fireEvent.click(screen.getByTestId("toggle-epic2"));

    // Enable team mode
    const checkbox = screen.getByRole("checkbox");
    fireEvent.click(checkbox);

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
    expect(body.provider).toBe("claude-code");
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
});
