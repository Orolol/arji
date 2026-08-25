/**
 * Tests for the sticky ticket header (ticket-display overhaul, story 2):
 * - critical information (status, priority, type, title) is visible in the
 *   top zone without any user action;
 * - frequent actions (status transition, edit, quick comment) are one
 *   click away from the header;
 * - the agent action bar is present in the header;
 * - the status control mirrors the workflow engine: only allowed
 *   transitions are enabled, review → done stays approval-gated, a running
 *   session locks the status, and server rejections surface inline;
 * - secondary metadata (dates, raw ids) is demoted to the Details tab.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { EpicDetail } from "@/components/kanban/EpicDetail";
import {
  REASON_APPROVAL_REQUIRED,
  REASON_RELEASED_SYSTEM_ONLY,
  REASON_SESSION_RUNNING,
} from "@/lib/kanban/status-transitions";

const mockUseEpicDetail = vi.hoisted(() => vi.fn());
const mockUseTicketComments = vi.hoisted(() => vi.fn());
const mockUseAgentDispatch = vi.hoisted(() => vi.fn());
const mockUseEpicPr = vi.hoisted(() => vi.fn());
const mockUseGitHubConfig = vi.hoisted(() => vi.fn());
const mockUseGitStatus = vi.hoisted(() => vi.fn());
const mockUseProjectEpicsList = vi.hoisted(() => vi.fn());
const mockUseEpicActivity = vi.hoisted(() => vi.fn());
const mockUpdateEpic = vi.hoisted(() => vi.fn());

vi.mock("@/hooks/useEpicDetail", () => ({
  useEpicDetail: (...args: unknown[]) => mockUseEpicDetail(...args),
}));
vi.mock("@/hooks/useTicketComments", () => ({
  useTicketComments: (...args: unknown[]) => mockUseTicketComments(...args),
}));
vi.mock("@/hooks/useAgentDispatch", () => ({
  useAgentDispatch: (...args: unknown[]) => mockUseAgentDispatch(...args),
}));
vi.mock("@/hooks/useEpicPr", () => ({
  useEpicPr: (...args: unknown[]) => mockUseEpicPr(...args),
}));
vi.mock("@/hooks/useGitHubConfig", () => ({
  useGitHubConfig: (...args: unknown[]) => mockUseGitHubConfig(...args),
}));
vi.mock("@/hooks/useGitStatus", () => ({
  useGitStatus: (...args: unknown[]) => mockUseGitStatus(...args),
}));
vi.mock("@/hooks/useProjectEpicsList", () => ({
  useProjectEpicsList: (...args: unknown[]) => mockUseProjectEpicsList(...args),
}));
vi.mock("@/hooks/useEpicActivity", () => ({
  useEpicActivity: (...args: unknown[]) => mockUseEpicActivity(...args),
}));

vi.mock("@/components/shared/AgentActionsBar", () => ({
  AgentActionsBar: () => (
    <button data-testid="mock-approve">Approve</button>
  ),
}));
vi.mock("@/components/epic/UserStoryQuickActions", () => ({
  UserStoryQuickActions: () => <div data-testid="story-quick-actions" />,
}));
vi.mock("@/components/dependencies/DependencyEditor", () => ({
  DependencyEditor: () => <div data-testid="dependency-editor" />,
}));
vi.mock("@/components/kanban/epic-detail/WhatTheAgentDid", () => ({
  WhatTheAgentDid: () => <div data-testid="what-the-agent-did" />,
}));

function baseEpic(overrides: Record<string, unknown> = {}) {
  return {
    id: "epic-1",
    title: "Refonte du paiement",
    description: "Epic details",
    priority: 2,
    status: "review",
    branchName: null,
    prNumber: null,
    prUrl: null,
    prStatus: null,
    type: "feature",
    linkedEpicId: null,
    images: null,
    readableId: "ARI-42",
    createdAt: "2025-01-01T09:00:00.000Z",
    updatedAt: "2025-02-02T10:00:00.000Z",
    ...overrides,
  };
}

function setupHooks(
  epic: Record<string, unknown>,
  {
    isRunning = false,
    comments = [],
  }: { isRunning?: boolean; comments?: unknown[] } = {}
) {
  mockUseEpicDetail.mockReturnValue({
    epic,
    userStories: [],
    loading: false,
    updateEpic: mockUpdateEpic,
    addUserStory: vi.fn(),
    updateUserStory: vi.fn(),
    deleteUserStory: vi.fn(),
    refresh: vi.fn(),
    setPolling: vi.fn(),
  });
  mockUseTicketComments.mockReturnValue({
    comments,
    loading: false,
    addComment: vi.fn(),
  });
  mockUseAgentDispatch.mockReturnValue({
    activeSession: isRunning ? { id: "sess-1", startedAt: new Date().toISOString() } : null,
    dispatching: false,
    isRunning,
    sendToDev: vi.fn(),
    sendToReview: vi.fn(),
    resolveMerge: vi.fn(),
    approve: vi.fn(),
  });
  mockUseEpicPr.mockReturnValue({
    pr: null,
    loading: false,
    error: null,
    createPr: vi.fn(),
    syncPr: vi.fn(),
  });
  mockUseGitHubConfig.mockReturnValue({ isConfigured: false });
  mockUseGitStatus.mockReturnValue({
    ahead: 0,
    behind: 0,
    lastFetchedAt: null,
    lastFetchError: null,
    loading: false,
    error: null,
    refresh: vi.fn(),
    push: vi.fn(),
    pushing: false,
  });
  mockUseProjectEpicsList.mockReturnValue({ epics: [] });
  mockUseEpicActivity.mockReturnValue({ entries: [], loading: false });
}

function renderSubject() {
  render(
    <EpicDetail projectId="proj-1" epicId="epic-1" open={true} onClose={vi.fn()} />
  );
}

/** Radix Select opens on Enter in jsdom (scrollIntoView is polyfilled). */
function openStatusSelect() {
  const trigger = screen.getByTestId("epic-status-select");
  trigger.focus();
  fireEvent.keyDown(trigger, { key: "Enter" });
}

function option(name: RegExp) {
  return screen.getByRole("option", { name });
}

beforeEach(() => {
  vi.restoreAllMocks();
  mockUpdateEpic.mockReset();
  mockUpdateEpic.mockResolvedValue({ ok: true });
  // jsdom has no scrollIntoView; Radix Select calls it when it opens.
  Element.prototype.scrollIntoView = vi.fn();
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ data: [] }),
  }) as unknown as typeof fetch;
});

describe("EpicDetail sticky header — critical information", () => {
  it("shows status, priority, type and title in the top zone without any user action", () => {
    setupHooks(baseEpic({ status: "in_progress", priority: 2 }));
    renderSubject();

    const header = screen.getByTestId("epic-detail-header");
    expect(header).toHaveTextContent("Refonte du paiement");
    expect(header).toHaveTextContent("In Progress");
    expect(header).toHaveTextContent("High");
    expect(within(header).getByTestId("ticket-type-badge")).toHaveTextContent(
      "Feature"
    );
    // The readable id stays in the top zone as the ticket's short label.
    expect(header).toHaveTextContent("ARI-42");
  });

  it("keeps the comment volume visible in the header without opening the tab", () => {
    setupHooks(baseEpic({ status: "review" }), {
      comments: [{ id: "c1" }, { id: "c2" }],
    });
    renderSubject();

    const header = screen.getByTestId("epic-detail-header");
    expect(within(header).getByTestId("epic-activity-comment-count")).toHaveTextContent(
      "2"
    );
  });
});

describe("EpicDetail sticky header — frequent actions", () => {
  it("exposes the status control, the priority control and the quick comment in the header", () => {
    setupHooks(baseEpic({ status: "backlog" }));
    renderSubject();

    const header = screen.getByTestId("epic-detail-header");
    expect(within(header).getByTestId("epic-status-select")).toBeInTheDocument();
    expect(within(header).getByTestId("epic-priority-select")).toBeInTheDocument();
    expect(within(header).getByTestId("epic-comment-button")).toBeInTheDocument();
  });

  it("jumps the quick comment button to the Activity tab with its composer", () => {
    setupHooks(baseEpic({ status: "backlog" }));
    renderSubject();

    fireEvent.click(screen.getByTestId("epic-comment-button"));

    expect(screen.getByPlaceholderText("Add a comment...")).toBeInTheDocument();
  });

  it("keeps the agent action bar in the sticky header", () => {
    setupHooks(baseEpic({ status: "review" }));
    renderSubject();

    const header = screen.getByTestId("epic-detail-header");
    expect(within(header).getByTestId("mock-approve")).toBeInTheDocument();
  });
});

describe("EpicDetail sticky header — workflow-aware status control", () => {
  it("only enables the transitions the workflow engine allows from review, with Done approval-gated", () => {
    setupHooks(baseEpic({ status: "review" }));
    renderSubject();
    openStatusSelect();

    // The only structurally allowed move is back to In Progress…
    expect(option(/In Progress/)).not.toHaveAttribute("data-disabled");
    // …and Done is shown but explicitly gated on the human approval.
    expect(option(/Done/)).toHaveAttribute("data-disabled");
    expect(option(/Done/)).toHaveAttribute("title", REASON_APPROVAL_REQUIRED);
    // Released is system-only from anywhere.
    expect(option(/Released/)).toHaveAttribute("data-disabled");
    expect(option(/Released/)).toHaveAttribute(
      "title",
      REASON_RELEASED_SYSTEM_ONLY
    );
    // Structurally unreachable from review.
    expect(option(/Backlog/)).toHaveAttribute("data-disabled");
    expect(option(/To Do/)).toHaveAttribute("data-disabled");
    // The current status is marked and not selectable.
    expect(option(/Review/)).toHaveTextContent("(current)");
    expect(option(/Review/)).toHaveAttribute("data-disabled");
  });

  it("enables exactly the backlog transitions from the backlog status", () => {
    setupHooks(baseEpic({ status: "backlog" }));
    renderSubject();
    openStatusSelect();

    expect(option(/To Do/)).not.toHaveAttribute("data-disabled");
    expect(option(/In Progress/)).not.toHaveAttribute("data-disabled");
    expect(option(/Review/)).toHaveAttribute("data-disabled");
    expect(option(/Done/)).toHaveAttribute("data-disabled");
    expect(option(/Released/)).toHaveAttribute("data-disabled");
    expect(option(/Backlog/)).toHaveTextContent("(current)");
  });

  it("locks every status change while a session is running", () => {
    setupHooks(baseEpic({ status: "in_progress" }), { isRunning: true });
    renderSubject();
    openStatusSelect();

    // Structurally reachable targets are disabled with the session reason.
    expect(option(/To Do/)).toHaveAttribute("data-disabled");
    expect(option(/To Do/)).toHaveAttribute("title", REASON_SESSION_RUNNING);
    expect(option(/Review/)).toHaveAttribute("data-disabled");
    expect(option(/Review/)).toHaveAttribute("title", REASON_SESSION_RUNNING);
    expect(option(/Backlog/)).toHaveAttribute("data-disabled");
    expect(option(/Backlog/)).toHaveAttribute("title", REASON_SESSION_RUNNING);
    // Unreachable ones stay disabled too.
    expect(option(/Done/)).toHaveAttribute("data-disabled");
    expect(option(/Released/)).toHaveAttribute("data-disabled");
  });

  it("surfaces the engine's rejection inline on the status control and does not apply the change", async () => {
    const engineMessage =
      "Cannot move to In Progress: a review comment is still open.";
    mockUpdateEpic.mockResolvedValue({ ok: false, error: engineMessage });
    setupHooks(baseEpic({ status: "review" }));
    renderSubject();
    openStatusSelect();

    fireEvent.click(option(/In Progress/));

    await waitFor(() => {
      expect(screen.getByTestId("epic-status-error")).toHaveTextContent(
        engineMessage
      );
    });
    expect(mockUpdateEpic).toHaveBeenCalledWith({ status: "in_progress" });
    // Optimistic state was not applied: the control still shows Review.
    expect(screen.getByTestId("epic-status-select")).toHaveTextContent(
      "Review"
    );
  });
});

describe("EpicDetail sticky header — demoted metadata", () => {
  it("keeps dates and the raw id out of the header and in the Details tab", () => {
    setupHooks(baseEpic({ status: "review" }));
    renderSubject();

    const header = screen.getByTestId("epic-detail-header");
    expect(header).not.toHaveTextContent("Created");
    expect(header).not.toHaveTextContent("Updated");
    expect(header).not.toHaveTextContent("epic-1");

    const metadata = screen.getByTestId("ticket-metadata");
    expect(metadata).toHaveTextContent("Created");
    expect(metadata).toHaveTextContent("Updated");
    expect(metadata).toHaveTextContent("epic-1");
  });
});