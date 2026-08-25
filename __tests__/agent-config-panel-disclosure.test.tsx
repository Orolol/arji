import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";

vi.mock("@/hooks/useAgentConfig", () => ({
  useNamedAgents: () => ({
    data: [
      {
        id: "agent-1",
        name: "Fast builder",
        provider: "claude-code",
        model: "",
        createdAt: null,
      },
    ],
    loading: false,
    createNamedAgent: vi.fn(async () => ({ ok: true })),
    updateNamedAgent: vi.fn(async () => ({ ok: true })),
    deleteNamedAgent: vi.fn(async () => true),
  }),
}));

vi.mock("@/hooks/useProvidersAvailable", () => ({
  useProvidersAvailable: () => ({
    providers: new Proxy({}, { get: () => true }),
    loading: false,
  }),
}));

// Radix popper is not drivable from jsdom — same stand-in as the
// NamedAgentSelect test: trigger/value render nothing.
vi.mock("@/components/ui/select", () => ({
  Select: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectTrigger: ({ id }: { id?: string }) => <button id={id} type="button" />,
  SelectValue: () => null,
  SelectContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectItem: ({
    value,
    children,
  }: {
    value: string;
    children: ReactNode;
  }) => <div data-value={value}>{children}</div>,
}));

// Markers for the advanced tabs, so expansion is observable without
// mounting the real (fetch-driven) tabs.
vi.mock("@/components/agent-config/AgentPromptsTab", () => ({
  AgentPromptsTab: () => <div>prompts-tab-marker</div>,
}));
vi.mock("@/components/agent-config/ReviewAgentsTab", () => ({
  ReviewAgentsTab: () => <div>review-tab-marker</div>,
}));
vi.mock("@/components/agent-config/TaskAssignmentsTab", () => ({
  TaskAssignmentsTab: () => <div>assignments-tab-marker</div>,
}));
vi.mock("@/components/agent-config/RuntimeSettingsTab", () => ({
  RuntimeSettingsTab: () => <div>runtime-tab-marker</div>,
}));
vi.mock("@/components/agent-config/StatsTab", () => ({
  StatsTab: () => <div>stats-tab-marker</div>,
}));

import { AgentConfigPanel } from "@/components/agent-config/AgentConfigPanel";

describe("AgentConfigPanel progressive disclosure", () => {
  it("shows the core agents screen and keeps advanced collapsed by default", () => {
    render(<AgentConfigPanel />);

    expect(screen.getByText("Agents")).toBeTruthy();
    expect(screen.getByDisplayValue("Fast builder")).toBeTruthy();

    const toggle = screen.getByTestId("advanced-settings-toggle");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.getAttribute("aria-controls")).toBe("advanced-agent-settings");
    expect(screen.queryByText("Instructions")).toBeNull();
    expect(screen.queryByText("prompts-tab-marker")).toBeNull();
  });

  it("reveals the advanced tabs when expanded explicitly", () => {
    render(<AgentConfigPanel />);

    act(() => {
      fireEvent.click(screen.getByTestId("advanced-settings-toggle"));
    });

    expect(
      screen.getByTestId("advanced-settings-toggle").getAttribute("aria-expanded")
    ).toBe("true");
    expect(screen.getByText("Instructions")).toBeTruthy();
    expect(screen.getByText("prompts-tab-marker")).toBeTruthy();
    expect(document.getElementById("advanced-agent-settings")).toBeTruthy();
    expect(screen.queryByDisplayValue("Fast builder")).toBeNull();
  });

  it("collapses the advanced section again on a second click", () => {
    render(<AgentConfigPanel />);

    const toggle = screen.getByTestId("advanced-settings-toggle");
    act(() => {
      fireEvent.click(toggle);
      fireEvent.click(toggle);
    });

    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("prompts-tab-marker")).toBeNull();
  });

  it("labels every field with a visible label and a hint, without internal jargon", () => {
    render(<AgentConfigPanel />);

    // Core fields are reachable through their labels, not just placeholders.
    expect(screen.getAllByLabelText("Name").length).toBeGreaterThan(0);
    expect(screen.getAllByLabelText("CLI").length).toBeGreaterThan(0);
    expect(screen.getAllByLabelText("Model").length).toBeGreaterThan(0);

    // Hints are present for the fields that need one.
    expect(screen.getAllByText(/leave empty to use the CLI's own default/i).length).toBeGreaterThan(0);

    // No raw internal field names leak into the core screen.
    expect(screen.queryByText(/provider/i)).toBeNull();
    expect(screen.queryByText(/named agent/i)).toBeNull();
  });
});
