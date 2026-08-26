/**
 * The activity chip shows the named agent's name (agentName), not the
 * provider label. The provider label is secondary detail in the tooltip.
 * Previously the chip rendered providerLabel(provider) instead of agentName
 * (bug: "On affiche le nom du provider au lieu du nom de l'agent").
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("@dnd-kit/sortable", () => ({
  useSortable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: () => {},
    transform: null,
    transition: null,
    isDragging: false,
  }),
}));

vi.mock("@dnd-kit/utilities", () => ({
  CSS: { Transform: { toString: () => null } },
}));

import { EpicCard } from "@/components/kanban/EpicCard";

const baseEpic = {
  id: "epic-1",
  projectId: "proj-1",
  title: "Test Epic",
  description: null,
  priority: 1,
  status: "in_progress",
  position: 0,
  branchName: null,
  prNumber: null,
  prUrl: null,
  prStatus: null,
  confidence: null,
  evidence: null,
  createdAt: "2026-08-19T00:00:00.000Z",
  updatedAt: "2026-08-19T00:00:00.000Z",
  usCount: 3,
  usDone: 1,
  type: "feature" as const,
  linkedEpicId: null,
  images: null,
  readableId: null,
  releaseId: null,
};

function renderWithActivity(provider: string, agentName = "agent 123abc") {
  render(
    <EpicCard
      epic={baseEpic}
      view={{
        activity: {
          sessionId: "sess-1",
          actionType: "build",
          agentName,
          provider,
        },
      }}
    />,
  );
  return screen.getByTestId("epic-activity-epic-1");
}

describe("EpicCard agent name (not provider label) on activity chip", () => {
  it("shows the agent name for an Oh My Pi session, not Oh My Pi", () => {
    const indicator = renderWithActivity("oh-my-pi", "FlashOMP");
    expect(indicator).toHaveTextContent("FlashOMP");
    expect(indicator).toHaveTextContent("Build \u00b7 FlashOMP");
  });

  it("shows the agent name for a Codex session", () => {
    const indicator = renderWithActivity("codex", "Atlas");
    expect(indicator).toHaveTextContent("Atlas");
    expect(indicator).toHaveTextContent("Build \u00b7 Atlas");
  });

  it("shows the agent name for a Claude Code session", () => {
    const indicator = renderWithActivity("claude-code", "Sparrow");
    expect(indicator).toHaveTextContent("Sparrow");
    expect(indicator).toHaveTextContent("Build \u00b7 Sparrow");
  });

  it("shows the agent name for a legacy gemini-cli row", () => {
    const indicator = renderWithActivity("gemini-cli", "GeminiAgent");
    expect(indicator).toHaveTextContent("GeminiAgent");
    expect(indicator).toHaveTextContent("Build \u00b7 GeminiAgent");
  });

  it("shows the agent name for removed pi provider", () => {
    const indicator = renderWithActivity("pi", "NinferOMP");
    expect(indicator).toHaveTextContent("NinferOMP");
    expect(indicator).toHaveTextContent("Build \u00b7 NinferOMP");
  });

  it("shows the agent name for removed opencode provider", () => {
    const indicator = renderWithActivity("opencode", "CustomAgent");
    expect(indicator).toHaveTextContent("CustomAgent");
    expect(indicator).toHaveTextContent("Build \u00b7 CustomAgent");
  });

  it("shows the agent name for an unknown provider", () => {
    const indicator = renderWithActivity("some-future-cli", "FutureAgent");
    expect(indicator).toHaveTextContent("FutureAgent");
    expect(indicator).not.toHaveTextContent("some-future-cli");
  });
});
