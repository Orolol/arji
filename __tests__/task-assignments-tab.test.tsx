import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

const hooks = vi.hoisted(() => ({
  assignAgent: vi.fn(),
}));

vi.mock("@/hooks/useAgentConfig", () => ({
  useAgentAssignments: () => ({
    data: [
      {
        agentType: "build",
        provider: "codex",
        namedAgentId: "builder-1",
        namedAgent: {
          id: "builder-1",
          name: "Fast builder",
          provider: "codex",
          model: "",
        },
        source: "global",
        scope: "global",
      },
    ],
    loading: false,
    assignAgent: hooks.assignAgent,
  }),
  useNamedAgents: () => ({
    data: [
      {
        id: "builder-1",
        name: "Fast builder",
        provider: "codex",
        model: "",
      },
      {
        id: "reviewer-1",
        name: "Careful reviewer",
        provider: "claude-code",
        model: "claude-opus-4-6",
      },
    ],
    loading: false,
  }),
}));

vi.mock("@/components/ui/select", () => ({
  Select: ({
    value,
    onValueChange,
    children,
  }: {
    value: string;
    onValueChange: (value: string) => void;
    children: ReactNode;
  }) => (
    <select value={value} onChange={(event) => onValueChange(event.target.value)}>
      {children}
    </select>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children: ReactNode }) => (
    <option value={value}>{typeof children === "string" ? children : value}</option>
  ),
}));

import { TaskAssignmentsTab } from "@/components/agent-config/TaskAssignmentsTab";

beforeEach(() => {
  vi.clearAllMocks();
  hooks.assignAgent.mockResolvedValue({ ok: true });
});

describe("task-to-agent assignments", () => {
  it("uses agent language and keeps provider controls out of the UI", () => {
    render(<TaskAssignmentsTab scope="global" />);

    expect(screen.getByText("Task assignments")).toBeTruthy();
    expect(screen.getByText("All projects")).toBeTruthy();
    expect(screen.queryByText(/^Providers?$/i)).toBeNull();
    expect(screen.getAllByText(/specific agent/i).length).toBeGreaterThan(0);
    expect(screen.getByText("Conversation Title")).toBeTruthy();
    expect(screen.getByText("Import Analysis")).toBeTruthy();
  });

  it("assigns a named agent to a role immediately", async () => {
    render(<TaskAssignmentsTab scope="global" />);

    const selects = screen.getAllByRole("combobox");
    fireEvent.change(selects[0], { target: { value: "reviewer-1" } });

    await waitFor(() =>
      expect(hooks.assignAgent).toHaveBeenCalledWith("build", "reviewer-1"),
    );
  });

  it("clears a project override back to the shared assignment", async () => {
    render(<TaskAssignmentsTab scope="project" projectId="project-1" />);

    const selects = screen.getAllByRole("combobox");
    fireEvent.change(selects[0], { target: { value: "__default__" } });

    await waitFor(() =>
      expect(hooks.assignAgent).toHaveBeenCalledWith("build", null),
    );
  });
});
