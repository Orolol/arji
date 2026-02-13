import { describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { AgentMonitor } from "@/components/monitor/AgentMonitor";

describe("AgentMonitor", () => {
  it("renders elapsed time and activity label for running activities", async () => {
    const startedAt = new Date(Date.now() - 65_000).toISOString();

    render(
      <AgentMonitor
        projectId="proj-1"
        activities={[
          {
            id: "sess-1",
            epicId: "epic-1",
            userStoryId: null,
            type: "build",
            label: "Building: Implement API",
            status: "running",
            mode: "code",
            provider: "codex",
            startedAt,
            source: "db",
            cancellable: true,
          },
        ]}
      />
    );

    await waitFor(() => {
      expect(
        screen.getByText((text) => /^1m \d+s$/.test(text))
      ).toBeInTheDocument();
    });
    expect(screen.getByText("Building: Implement API")).toBeInTheDocument();
    expect(screen.getByText("Codex")).toBeInTheDocument();
  });

  it("highlights only the linked activity row", () => {
    render(
      <AgentMonitor
        projectId="proj-1"
        highlightedActivityId="sess-2"
        activities={[
          {
            id: "sess-1",
            epicId: "epic-1",
            userStoryId: null,
            type: "build",
            label: "Building: A",
            status: "running",
            mode: "code",
            provider: "codex",
            startedAt: new Date().toISOString(),
            source: "db",
            cancellable: true,
          },
          {
            id: "sess-2",
            epicId: "epic-2",
            userStoryId: null,
            type: "review",
            label: "Reviewing: B",
            status: "running",
            mode: "plan",
            provider: "claude-code",
            startedAt: new Date().toISOString(),
            source: "db",
            cancellable: true,
          },
        ]}
      />
    );

    expect(screen.getByTestId("agent-monitor-activity-sess-2").className).toContain(
      "bg-primary/10"
    );
    expect(screen.getByTestId("agent-monitor-activity-sess-1").className).not.toContain(
      "bg-primary/10"
    );
  });
});
