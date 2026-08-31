/**
 * Project board wiring for night runs. The trigger button itself now lives in
 * the project chrome (the layout header, Builder A) and reaches this page
 * through `?night=start` — the same URL mechanism as the existing `?ticket=`
 * and `?nightRun=` links. What this file owns is the page side of that seam:
 * the dialog it opens, the toast it raises, and the summary deep link.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useState,
  type ReactNode,
} from "react";

class MockEventSource {
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  close() {}
}
(globalThis as Record<string, unknown>).EventSource = MockEventSource;

const routerReplace = vi.fn();
let searchParams = new URLSearchParams();

vi.mock("next/navigation", () => ({
  useParams: () => ({ projectId: "proj1" }),
  useRouter: () => ({ replace: routerReplace }),
  useSearchParams: () => searchParams,
}));

vi.mock("@/hooks/useAgentPolling", () => ({
  useAgentPolling: () => ({ activities: [] }),
}));

vi.mock("@/hooks/useBatchSelection", () => ({
  useBatchSelection: () => {
    const [selectedTicketIds, setSelectedTicketIds] = useState<string[]>([]);
    const clear = useCallback(() => setSelectedTicketIds([]), []);
    return {
      allSelected: new Set(selectedTicketIds),
      userSelected: new Set(selectedTicketIds),
      autoIncluded: new Set<string>(),
      selectedTicketIds,
      loading: false,
      setSelectedTicketIds,
      toggle: vi.fn(),
      clear,
      isAutoIncluded: () => false,
      isUserSelected: () => false,
    };
  },
}));

vi.mock("@/components/desk/NowDesk", () => ({
  NowDesk: () => <div data-testid="board" />,
}));
vi.mock("@/components/auto-mode/AutoModeToggle", () => ({
  AutoModeToggle: () => null,
}));
vi.mock("@/components/kanban/RefinementButton", () => ({
  RefinementButton: () => null,
}));
vi.mock("@/components/ticket/TicketOverlay", () => ({ TicketOverlay: () => null }));
vi.mock("@/components/monitor/AgentMonitor", () => ({ AgentMonitor: () => null }));
vi.mock("@/components/shared/NamedAgentSelect", () => ({
  NamedAgentSelect: () => null,
}));
vi.mock("@/components/chat/UnifiedChatPanel", () => ({
  UnifiedChatPanel: forwardRef(({ children }: { children: ReactNode }, ref) => {
    useImperativeHandle(ref, () => ({
      openChat: vi.fn(),
      openNewEpic: vi.fn(),
      collapse: vi.fn(),
      hide: vi.fn(),
    }));
    return <div data-testid="unified-chat-panel">{children}</div>;
  }),
}));

// Stubs for the two night dialogs: the dialogs have their own tests, here we
// only assert the page opens them with the right inputs.
let startedHandler: ((r: { message: string }) => void) | null = null;
vi.mock("@/components/night/NightRunDialog", () => ({
  NightRunDialog: ({
    open,
    onStarted,
  }: {
    open: boolean;
    onStarted?: (r: { message: string }) => void;
  }) => {
    startedHandler = onStarted ?? null;
    return open ? <div data-testid="night-dialog-open" /> : null;
  },
}));
vi.mock("@/components/night/NightRunSummaryDialog", () => ({
  NightRunSummaryDialog: ({
    open,
    runId,
  }: {
    open: boolean;
    runId: string | null;
  }) =>
    open ? <div data-testid="night-summary-open">{runId}</div> : null,
}));

import KanbanPage from "@/app/projects/[projectId]/page";

describe("Project board — night run wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    searchParams = new URLSearchParams();
    startedHandler = null;
    global.fetch = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ data: {} }) });
  });

  it("keeps the dialog closed until something asks for it", async () => {
    render(<KanbanPage />);
    expect(await screen.findByTestId("board")).toBeInTheDocument();
    expect(screen.queryByTestId("night-dialog-open")).not.toBeInTheDocument();
  });

  it("opens the confirm dialog from ?night=start and strips the param", async () => {
    searchParams = new URLSearchParams("night=start");
    render(<KanbanPage />);

    await waitFor(() =>
      expect(screen.getByTestId("night-dialog-open")).toBeInTheDocument()
    );
    expect(routerReplace).toHaveBeenCalledWith("/projects/proj1");
  });

  it("ignores an unrelated night param value", async () => {
    searchParams = new URLSearchParams("night=maybe");
    render(<KanbanPage />);

    await screen.findByTestId("board");
    expect(screen.queryByTestId("night-dialog-open")).not.toBeInTheDocument();
  });

  it("toasts the launch message the dialog reports", async () => {
    searchParams = new URLSearchParams("night=start");
    render(<KanbanPage />);

    await waitFor(() =>
      expect(screen.getByTestId("night-dialog-open")).toBeInTheDocument()
    );

    act(() => {
      startedHandler?.({ message: "Night run started — wave 1/3, 5 epics" });
    });

    await waitFor(() =>
      expect(
        screen.getByText("Night run started — wave 1/3, 5 epics")
      ).toBeInTheDocument()
    );
  });

  it("opens the summary from ?nightRun= and strips the param", async () => {
    searchParams = new URLSearchParams("nightRun=night_abc");
    render(<KanbanPage />);

    await waitFor(() =>
      expect(screen.getByTestId("night-summary-open")).toHaveTextContent(
        "night_abc"
      )
    );
    expect(routerReplace).toHaveBeenCalledWith("/projects/proj1");
  });

  it("does not open the summary without the param", async () => {
    render(<KanbanPage />);
    await screen.findByTestId("board");
    expect(screen.queryByTestId("night-summary-open")).not.toBeInTheDocument();
  });

  it("no longer renders night-run chrome on the board itself", async () => {
    render(<KanbanPage />);
    await screen.findByTestId("board");
    // Starting a run lives in the project header; the board reaches the
    // summary by URL only (`?nightRun=`). The durable list of past runs lives
    // on the Sessions tab — see sessions-page-queued.test.tsx.
    expect(screen.queryByTestId("night-run-button")).not.toBeInTheDocument();
  });
});
