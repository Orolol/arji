import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EpicDetail } from "@/components/kanban/EpicDetail";

const mockUseEpicDetail = vi.hoisted(() => vi.fn());
const mockUseTicketComments = vi.hoisted(() => vi.fn());
const mockUseAgentDispatch = vi.hoisted(() => vi.fn());
const mockUseEpicPr = vi.hoisted(() => vi.fn());
const mockUseGitHubConfig = vi.hoisted(() => vi.fn());
const mockUseGitStatus = vi.hoisted(() => vi.fn());
const mockUseProjectEpicsList = vi.hoisted(() => vi.fn());

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

vi.mock("@/components/shared/AgentActionsBar", () => ({
  AgentActionsBar: () => <div data-testid="epic-actions" />,
}));
vi.mock("@/components/dependencies/DependencyEditor", () => ({
  DependencyEditor: () => <div data-testid="dependency-editor" />,
}));
vi.mock("@/components/review/DiffViewer", () => ({
  DiffViewer: () => <div data-testid="diff-viewer" />,
}));
vi.mock("@/components/kanban/epic-detail/WhatTheAgentDid", () => ({
  WhatTheAgentDid: () => null,
}));

describe("EpicDetail session artifact gallery", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ data: [] }),
    })) as unknown as typeof fetch;

    mockUseEpicDetail.mockReturnValue({
      epic: {
        id: "epic-1",
        title: "Settings redesign",
        description: "Update the project settings UI",
        priority: 1,
        status: "review",
        branchName: "feature/settings-redesign",
        prNumber: null,
        prUrl: null,
        prStatus: null,
        type: "feature",
        linkedEpicId: null,
        images: null,
        readableId: "ARI-7",
        createdAt: "2026-08-25T10:00:00.000Z",
        updatedAt: "2026-08-25T11:00:00.000Z",
      },
      userStories: [],
      gradingReport: null,
      artifacts: [
        {
          id: "artifact-one",
          agentSessionId: "session-one",
          epicId: "epic-1",
          caption: "Settings saved with the new confirmation state",
          createdAt: "2026-08-25T10:30:00.000Z",
        },
        {
          id: "artifact-two",
          agentSessionId: "session-one",
          epicId: "epic-1",
          caption: "Responsive settings layout on mobile",
          createdAt: "2026-08-25T10:31:00.000Z",
        },
      ],
      loading: false,
      updateEpic: vi.fn(),
      addUserStory: vi.fn(),
      updateUserStory: vi.fn(),
      deleteUserStory: vi.fn(),
      refresh: vi.fn(),
      setPolling: vi.fn(),
    });
    mockUseTicketComments.mockReturnValue({
      comments: [],
      loading: false,
      addComment: vi.fn(),
    });
    mockUseAgentDispatch.mockReturnValue({
      activeSession: null,
      dispatching: false,
      isRunning: false,
      sendToDev: vi.fn(),
      sendToReview: vi.fn(),
      sendToGrading: vi.fn(),
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
  });

  it("shows captioned proofs before the diff and opens a captioned lightbox", async () => {
    const user = userEvent.setup();
    render(
      <EpicDetail
        projectId="project-one"
        epicId="epic-1"
        open
        onClose={vi.fn()}
      />
    );

    await user.click(screen.getByRole("tab", { name: /Code Review/i }));

    const gallery = screen.getByTestId("session-artifact-gallery");
    const diff = screen.getByTestId("diff-viewer");
    expect(gallery.compareDocumentPosition(diff)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    );
    expect(gallery).toHaveTextContent(
      "Settings saved with the new confirmation state"
    );
    expect(gallery).toHaveTextContent("Responsive settings layout on mobile");
    expect(
      screen.getByAltText("Settings saved with the new confirmation state")
    ).toHaveAttribute(
      "src",
      "/api/projects/project-one/artifacts/artifact-one"
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "Open visual proof: Settings saved with the new confirmation state",
      })
    );

    const lightbox = screen.getByTestId("image-lightbox");
    expect(
      within(lightbox).getByText(
        "Settings saved with the new confirmation state"
      )
    ).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByTestId("image-lightbox")).toBeNull();
  });
});
