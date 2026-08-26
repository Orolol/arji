/**
 * The activity chip resolves the provider through PROVIDER_LABELS for the
 * registered providers (claude-code, codex, oh-my-pi, openai-compatible),
 * keeps the legacy "Gemini" abbreviation for old gemini-cli rows, and falls
 * back to the raw provider string for anything else — including providers
 * removed in the 2026-08 MCP cleanup — instead of mislabeling them as
 * Claude Code.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("@dnd-kit/sortable", () => ({
  useSortable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: vi.fn(),
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
  type: "feature",
  linkedEpicId: null,
  images: null,
  readableId: null,
  releaseId: null,
};

function renderWithProvider(provider: string) {
  render(
    <EpicCard
      epic={baseEpic}
      view={{
        activity: {
          sessionId: "sess-1",
          actionType: "build",
          agentName: "agent 123abc",
          provider,
        },
      }}
    />,
  );
  return screen.getByTestId("epic-activity-epic-1");
}

describe("EpicCard provider label", () => {
  it("labels an Oh My Pi session as Oh My Pi", () => {
    expect(renderWithProvider("oh-my-pi")).toHaveTextContent("Oh My Pi");
  });

  it("labels a Codex session as Codex", () => {
    expect(renderWithProvider("codex")).toHaveTextContent("Codex");
  });

  it("keeps the established Claude Code label", () => {
    expect(renderWithProvider("claude-code")).toHaveTextContent("Claude Code");
  });

  it("keeps the Gemini abbreviation for legacy gemini-cli rows", () => {
    expect(renderWithProvider("gemini-cli")).toHaveTextContent("Gemini");
  });

  it("shows the raw string for the removed pi provider, not a Claude Code mislabel", () => {
    const indicator = renderWithProvider("pi");
    expect(indicator).toHaveTextContent("pi");
    expect(indicator).not.toHaveTextContent("Pi");
    expect(indicator).not.toHaveTextContent("Claude Code");
  });

  it("shows the raw string for the removed opencode provider, not a Claude Code mislabel", () => {
    const indicator = renderWithProvider("opencode");
    expect(indicator).toHaveTextContent("opencode");
    expect(indicator).not.toHaveTextContent("Claude Code");
  });

  it("falls back to the raw value for an unknown provider", () => {
    expect(renderWithProvider("some-future-cli")).toHaveTextContent(
      "some-future-cli",
    );
  });
});
