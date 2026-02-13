import { describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { AgentMonitor } from "@/components/monitor/AgentMonitor";

describe("AgentMonitor", () => {
  it("renders elapsed time and lastNonEmptyText for running sessions", async () => {
    const startedAt = new Date(Date.now() - 65_000).toISOString();

    render(
      <AgentMonitor
        projectId="proj-1"
        sessions={[
          {
            id: "sess-1",
            epicId: "epic-1",
            status: "running",
            mode: "code",
            provider: "codex",
            startedAt,
            lastNonEmptyText: "Implementing API route",
          },
        ]}
      />
    );

    await waitFor(() => {
      expect(
        screen.getByText((text) => /^1m \d+s$/.test(text))
      ).toBeInTheDocument();
    });
    expect(screen.getByText("Implementing API route")).toBeInTheDocument();
  });
});
