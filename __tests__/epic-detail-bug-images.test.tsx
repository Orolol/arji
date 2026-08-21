import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { EpicDetail } from "@/components/kanban/EpicDetail";

const mockUseEpicDetail = vi.hoisted(() => vi.fn());
const mockUseTicketComments = vi.hoisted(() => vi.fn());
const mockUseAgentDispatch = vi.hoisted(() => vi.fn());
const mockUseEpicPr = vi.hoisted(() => vi.fn());
const mockUseGitHubConfig = vi.hoisted(() => vi.fn());
const mockUseGitStatus = vi.hoisted(() => vi.fn());
const mockUseProvidersAvailable = vi.hoisted(() => vi.fn());

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

vi.mock("@/hooks/useProvidersAvailable", () => ({
  useProvidersAvailable: (...args: unknown[]) => mockUseProvidersAvailable(...args),
}));

vi.mock("@/components/shared/AgentActionsBar", () => ({
  AgentActionsBar: () => <div data-testid="epic-actions" />,
}));

vi.mock("@/components/dependencies/DependencyEditor", () => ({
  DependencyEditor: () => <div data-testid="dependency-editor" />,
}));

const SHOT = "data/uploads/proj-1/att-1-screenshot.png";
const SECOND_SHOT = "data/uploads/proj-1/att-2-console.png";

/**
 * A screenshot is the whole point of a bug report, so it has to survive the
 * create modal: the ticket panel reads the paths back out of `epics.images`
 * and shows them, and a click opens the image full size.
 */
describe("EpicDetail bug screenshots", () => {
  function mountWith(images: string | null, type = "bug") {
    mockUseEpicDetail.mockReturnValue({
      epic: {
        id: "bug-1",
        title: "Board renders blank",
        description: "Steps to reproduce",
        priority: 1,
        status: "todo",
        branchName: null,
        prNumber: null,
        prUrl: null,
        prStatus: null,
        type,
        linkedEpicId: null,
        images,
      },
      userStories: [],
      loading: false,
      updateEpic: vi.fn(),
      addUserStory: vi.fn(),
      updateUserStory: vi.fn(),
      deleteUserStory: vi.fn(),
      refresh: vi.fn(),
      setPolling: vi.fn(),
    });

    render(
      <EpicDetail projectId="proj-1" epicId="bug-1" open onClose={vi.fn()} />
    );
  }

  beforeEach(() => {
    vi.restoreAllMocks();
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ data: [] }),
    })) as unknown as typeof fetch;

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
      loading: false,
      error: null,
      refresh: vi.fn(),
      push: vi.fn(),
      pushing: false,
    });
    mockUseProvidersAvailable.mockReturnValue({
      codexAvailable: true,
      codexInstalled: true,
    });
  });

  it("shows a thumbnail per attached screenshot", () => {
    mountWith(JSON.stringify([SHOT, SECOND_SHOT]));

    expect(screen.getByTestId("ticket-images")).toBeInTheDocument();

    const first = screen.getByAltText("att-1-screenshot.png");
    expect(first).toHaveAttribute(
      "src",
      "/api/projects/proj-1/uploads/att-1-screenshot.png"
    );
    expect(first).toHaveAttribute("loading", "lazy");
    expect(screen.getByAltText("att-2-console.png")).toBeInTheDocument();
  });

  it("opens the full-size image when a thumbnail is clicked", () => {
    mountWith(JSON.stringify([SHOT]));

    expect(screen.queryByTestId("image-lightbox")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Open att-1-screenshot.png" }));

    const lightbox = screen.getByTestId("image-lightbox");
    expect(lightbox).toBeInTheDocument();
    // Thumbnail plus the enlarged copy inside the overlay.
    expect(screen.getAllByAltText("att-1-screenshot.png")).toHaveLength(2);
    expect(
      lightbox.querySelector("img[src='/api/projects/proj-1/uploads/att-1-screenshot.png']")
    ).not.toBeNull();
  });

  it("closes the full-size view on Escape", () => {
    mountWith(JSON.stringify([SHOT]));

    fireEvent.click(screen.getByRole("button", { name: "Open att-1-screenshot.png" }));
    expect(screen.getByTestId("image-lightbox")).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });

    expect(screen.queryByTestId("image-lightbox")).toBeNull();
  });

  it.each([
    ["a bug reported before attachments existed", null, "bug"],
    ["a bug whose column holds an empty array", "[]", "bug"],
    ["a bug whose column is corrupt", "{oops", "bug"],
    ["a feature epic", null, "feature"],
  ])("renders no screenshot block for %s", (_label, images, type) => {
    mountWith(images, type);

    expect(screen.queryByTestId("ticket-images")).toBeNull();
    // The rest of the ticket is untouched.
    expect(screen.getByTestId("epic-detail-panel")).toBeInTheDocument();
    expect(document.querySelectorAll("img")).toHaveLength(0);
  });
});
