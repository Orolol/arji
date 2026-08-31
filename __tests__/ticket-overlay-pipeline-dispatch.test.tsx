/**
 * Ticket overlay: Re-build (and the dev dispatch it owns) goes through the
 * shared send-to-dev dialog, where the "Run full pipeline" mode is selectable
 * and defaults to ON from the `pipeline_enabled` setting chain — the epic's
 * "on peut même pas sélectionner ce mode dans les tickets" gap, closed.
 *
 * The dialog itself is covered by `pipeline-dispatch-checkbox.test.tsx`
 * (rendered through AgentActionsBar); here we assert the overlay's wiring:
 * the band's Re-build pill opens the dialog, the band's agent seeds its
 * picker, and the confirmed flag reaches `sendToDev`.
 */
import { beforeEach, afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

import { TicketOverlay } from "@/components/ticket/TicketOverlay";

const mockUseEpicDetail = vi.hoisted(() => vi.fn());
const mockUseTicketComments = vi.hoisted(() => vi.fn());
const mockUseAgentDispatch = vi.hoisted(() => vi.fn());
const mockUseEpicPr = vi.hoisted(() => vi.fn());
const mockUseGitHubConfig = vi.hoisted(() => vi.fn());
const mockUseEpicDependencies = vi.hoisted(() => vi.fn());
const mockUseProjectEpicsList = vi.hoisted(() => vi.fn());
const mockUseNamedAgentsList = vi.hoisted(() => vi.fn());
const mockFetchUnifiedSessions = vi.hoisted(() => vi.fn());

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
vi.mock("@/hooks/useEpicDependencies", () => ({
  useEpicDependencies: (...args: unknown[]) => mockUseEpicDependencies(...args),
}));
vi.mock("@/hooks/useProjectEpicsList", () => ({
  useProjectEpicsList: (...args: unknown[]) => mockUseProjectEpicsList(...args),
}));
vi.mock("@/hooks/useNamedAgentsList", () => ({
  useNamedAgentsList: (...args: unknown[]) => mockUseNamedAgentsList(...args),
}));
vi.mock("@/hooks/useProjectEvents", () => ({
  useProjectEvents: () => ({ status: "connected", pollTick: 0 }),
}));
vi.mock("@/lib/agent-sessions/session-list", () => ({
  fetchUnifiedSessions: (...args: unknown[]) =>
    mockFetchUnifiedSessions(...args),
}));
vi.mock("@/components/review/DiffViewer", () => ({
  DiffViewer: () => <div data-testid="diff-viewer" />,
}));
vi.mock("@/components/chat/MarkdownContent", () => ({
  MarkdownContent: ({ content }: { content: string }) => <div>{content}</div>,
}));
vi.mock("@/components/shared/NamedAgentSelect", () => ({
  NamedAgentSelect: () => <div data-testid="named-agent-select" />,
}));
vi.mock("@/components/shared/SessionPicker", () => ({
  SessionPicker: () => <div data-testid="session-picker" />,
}));
vi.mock("@/components/documents/MentionTextarea", () => ({
  MentionTextarea: () => <textarea data-testid="mention-textarea" />,
}));
vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => (
    <div data-testid="dropdown-content">{children}</div>
  ),
  DropdownMenuLabel: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuSeparator: () => <hr />,
  DropdownMenuItem: ({
    children,
    disabled,
    title,
    onSelect,
  }: {
    children: ReactNode;
    disabled?: boolean;
    title?: string;
    onSelect?: () => void;
  }) => (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      title={title}
      onClick={() => onSelect?.()}
    >
      {children}
    </button>
  ),
}));

type SendToDev = (
  comment?: string,
  namedAgentId?: string | null,
  resumeSessionId?: string,
  pipeline?: boolean,
) => Promise<unknown>;

let sendToDevSpy: Mock<SendToDev>;

function epicFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: "epic-1",
    title: "Le full pipeline par défaut",
    description: "Le mode build doit être le full pipeline par défaut.",
    priority: 2,
    status: "in_progress",
    branchName: "feature/epic-1",
    prNumber: null,
    prUrl: null,
    prStatus: null,
    type: "feature",
    linkedEpicId: null,
    images: null,
    readableId: "ARJ-7",
    createdAt: null,
    updatedAt: null,
    ...overrides,
  };
}

function renderSubject() {
  return render(
    <TicketOverlay
      projectId="proj-1"
      epicId="epic-1"
      open
      onClose={vi.fn()}
    />,
  );
}

beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    const body =
      url.endsWith("/activity") || url.endsWith("/sessions")
        ? { data: [] }
        : url === "/api/settings"
          ? { data: {} }
          : { data: { name: "Arij" } };
    return new Response(JSON.stringify(body), { status: 200 });
  });

  sendToDevSpy = vi.fn<SendToDev>(async () => undefined);
  mockUseEpicDetail.mockReturnValue({
    epic: epicFixture(),
    userStories: [],
    loading: false,
    updateEpic: vi.fn().mockResolvedValue({ ok: true }),
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
    sendToDev: sendToDevSpy,
    sendToReview: vi.fn(),
    sendToGrading: vi.fn(),
    resolveMerge: vi.fn(),
    merge: vi.fn(),
    merging: false,
    mergeError: null,
    mergeConflict: false,
    conflictFiles: [],
    setMergeError: vi.fn(),
    stopSession: vi.fn(),
    refreshSessions: vi.fn(),
  });
  mockUseEpicPr.mockReturnValue({
    pr: null,
    loading: false,
    error: null,
    createPr: vi.fn(),
    syncPr: vi.fn(),
  });
  mockUseGitHubConfig.mockReturnValue({ isConfigured: false });
  mockUseEpicDependencies.mockReturnValue({
    predecessors: [],
    successors: [],
    waitsOn: [],
    waitsOnOptions: [],
    toggleWaitsOn: vi.fn(),
    saving: false,
    error: null,
  });
  mockUseProjectEpicsList.mockReturnValue({ epics: [] });
  mockUseNamedAgentsList.mockReturnValue({ agents: [] });
  mockFetchUnifiedSessions.mockResolvedValue([]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("TicketOverlay — dev dispatch through the shared dialog", () => {
  it("Re-build opens the dispatch dialog with the pipeline mode ON by default", async () => {
    renderSubject();
    fireEvent.click(screen.getByTestId("ticket-rebuild"));

    const checkbox = await screen.findByTestId("pipeline-checkbox");
    await waitFor(() => expect(checkbox).toBeChecked());
  });

  it("dispatches with pipeline=true when the default-on box is confirmed", async () => {
    renderSubject();
    fireEvent.click(screen.getByTestId("ticket-rebuild"));

    const checkbox = await screen.findByTestId("pipeline-checkbox");
    await waitFor(() => expect(checkbox).toBeChecked());

    fireEvent.click(screen.getByRole("button", { name: /Dispatch Agent/i }));

    await waitFor(() => expect(sendToDevSpy).toHaveBeenCalled());
    expect(sendToDevSpy.mock.calls[0]).toEqual([
      undefined,
      null,
      undefined,
      true,
    ]);
  });

  it("dispatches with pipeline=false when the user unticks the box", async () => {
    renderSubject();
    fireEvent.click(screen.getByTestId("ticket-rebuild"));

    const checkbox = await screen.findByTestId("pipeline-checkbox");
    await waitFor(() => expect(checkbox).toBeChecked());
    fireEvent.click(checkbox);

    fireEvent.click(screen.getByRole("button", { name: /Dispatch Agent/i }));

    await waitFor(() => expect(sendToDevSpy).toHaveBeenCalled());
    expect(sendToDevSpy.mock.calls[0][3]).toBe(false);
  });
});
