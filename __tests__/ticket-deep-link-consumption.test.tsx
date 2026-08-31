/**
 * `/projects/:id?ticket=<epicId>` — the notification deep link — has to be
 * *consumed*, not merely read. The page says so in its own comment; it was not
 * doing it.
 *
 * WHAT THIS PINS, AND WHY THE MOCKS LOOK LIKE THIS.
 *
 * 1. `useRouter()` IS NOT IDENTITY-STABLE. Next 16 memoises the object on
 *    `[router, bfcacheId]` (`next/dist/client/components/navigation.js`) and
 *    the bfcache id comes off the closest CacheNode, so it changes when a
 *    navigation commits. The consuming effect lists `router` in its
 *    dependencies, so it re-runs — and without a consumed-once guard it
 *    re-opens the overlay the user just closed and fires a second navigation.
 *    `bumpRouterIdentity()` reproduces exactly that.
 *
 * 2. `router.replace()` IS A NAVIGATION, not a URL rewrite. The App Router
 *    fetches the destination's RSC payload and only touches the address bar
 *    when that round-trip commits. Measured in Chrome against a warm
 *    `next dev` on a two-row scratch project: three RSC requests and ~3.4s
 *    before `?ticket=` left the address bar. Inside that window Escape closed
 *    the overlay, the query survived, and a reload re-opened it — the reported
 *    bug. So `replace()` here records the href and changes nothing until
 *    `flushPendingNavigation()` says the server answered.
 *
 * 3. `window.history.replaceState` is wired the way the App Router patches it
 *    (`app-router.js`: rewrite the URL, then sync `useSearchParams`), so it
 *    lands synchronously and costs no round-trip.
 *
 * A page that consumes the deep link through a navigation therefore fails
 * these tests; one that consumes it through the history API passes.
 */

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";

class MockEventSource {
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  close() {}
}
(globalThis as Record<string, unknown>).EventSource = MockEventSource;

/* ------------------------------------------------------------------ */
/* The address bar, and the hook's view of it                          */
/* ------------------------------------------------------------------ */

const urlListeners = new Set<() => void>();
let snapshotHref = "";
let snapshotParams = new URLSearchParams();

function subscribeToUrl(listener: () => void) {
  urlListeners.add(listener);
  return () => urlListeners.delete(listener);
}

/** jsdom owns `window.location`; this only keeps the hook's snapshot on it. */
function syncFromLocation() {
  const href = window.location.pathname + window.location.search;
  if (href === snapshotHref) return;
  snapshotHref = href;
  snapshotParams = new URLSearchParams(window.location.search);
  urlListeners.forEach((listener) => listener());
}

const nativeReplaceState = window.history.replaceState.bind(window.history);

/** The App Router's patch, in miniature: rewrite, then sync the hooks. */
window.history.replaceState = ((
  data: unknown,
  unused: string,
  url?: string | URL | null,
) => {
  nativeReplaceState(data, unused, url ?? undefined);
  syncFromLocation();
}) as typeof window.history.replaceState;

function setUrl(url: string) {
  window.history.replaceState(null, "", url);
}

/* ------------------------------------------------------------------ */
/* A router that behaves like the real one                             */
/* ------------------------------------------------------------------ */

const pendingNavigations: string[] = [];
const routerReplace = vi.fn((href: string) => {
  pendingNavigations.push(href);
});

let routerInstance = { replace: routerReplace, push: vi.fn(), refresh: vi.fn() };

/** A committed navigation gives `useRouter()` a new object. See (1) above. */
function bumpRouterIdentity() {
  routerInstance = { ...routerInstance };
}

/** The RSC round-trip `router.replace()` was waiting on finally answers. */
function flushPendingNavigation() {
  const href = pendingNavigations.pop();
  pendingNavigations.length = 0;
  if (!href) return;
  act(() => {
    window.history.replaceState(null, "", href);
  });
}

vi.mock("next/navigation", () => ({
  useParams: () => ({ projectId: "proj1" }),
  useRouter: () => routerInstance,
  useSearchParams: () =>
    useSyncExternalStore(
      subscribeToUrl,
      () => snapshotParams,
      () => snapshotParams,
    ),
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
vi.mock("@/components/monitor/AgentMonitor", () => ({ AgentMonitor: () => null }));
vi.mock("@/components/shared/NamedAgentSelect", () => ({
  NamedAgentSelect: () => null,
}));
vi.mock("@/components/night/NightRunDialog", () => ({ NightRunDialog: () => null }));
vi.mock("@/components/night/NightRunSummaryDialog", () => ({
  NightRunSummaryDialog: ({ open, runId }: { open: boolean; runId: string | null }) =>
    open ? <div data-testid="night-summary-open">{runId}</div> : null,
}));
vi.mock("@/components/chat/UnifiedChatPanel", () => ({
  UnifiedChatPanel: forwardRef(function UnifiedChatPanelMock(
    { children }: { children: ReactNode },
    ref,
  ) {
    useImperativeHandle(ref, () => ({
      openChat: vi.fn(),
      openNewEpic: vi.fn(),
      collapse: vi.fn(),
      hide: vi.fn(),
    }));
    return <div data-testid="unified-chat-panel">{children}</div>;
  }),
}));

/** Escape is the overlay's own binding; the page only ever sees `onClose`. */
let closeOverlay: (() => void) | null = null;
vi.mock("@/components/ticket/TicketOverlay", () => ({
  TicketOverlay: function TicketOverlayMock({
    epicId,
    onClose,
  }: {
    epicId: string;
    onClose: () => void;
  }) {
    closeOverlay = onClose;
    return <div data-testid="ticket-overlay">{epicId}</div>;
  },
}));

import ProjectDeskPage from "@/app/projects/[projectId]/page";

describe("project desk — the ?ticket= deep link is consumed", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pendingNavigations.length = 0;
    closeOverlay = null;
    routerInstance = { replace: routerReplace, push: vi.fn(), refresh: vi.fn() };
    setUrl("/projects/proj1");
    global.fetch = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ data: {} }) });
  });

  afterEach(() => {
    setUrl("/projects/proj1");
  });

  // Control: true on both sides of the fix. If this goes red the deep link
  // itself is broken, not its consumption.
  it("opens the overlay on the ticket the query names", async () => {
    setUrl("/projects/proj1?ticket=T1");
    render(<ProjectDeskPage />);

    expect(await screen.findByTestId("ticket-overlay")).toHaveTextContent("T1");
  });

  it("has already stripped ?ticket= by the time the overlay is open", async () => {
    setUrl("/projects/proj1?ticket=T1");
    render(<ProjectDeskPage />);

    await screen.findByTestId("ticket-overlay");

    // No `flushPendingNavigation()` on purpose: the address bar has to be clean
    // without waiting on a server round-trip, because the user can close the
    // overlay and reload inside that window.
    expect(window.location.search).toBe("");
  });

  it("leaves the rest of the query untouched", async () => {
    setUrl("/projects/proj1?ticket=T1&highlight=abc");
    render(<ProjectDeskPage />);

    await screen.findByTestId("ticket-overlay");

    const params = new URLSearchParams(window.location.search);
    expect(params.has("ticket")).toBe(false);
    expect(params.get("highlight")).toBe("abc");
  });

  it("does not re-open the overlay when a closed ticket page is reloaded", async () => {
    setUrl("/projects/proj1?ticket=T1");
    const first = render(<ProjectDeskPage />);
    await screen.findByTestId("ticket-overlay");

    act(() => closeOverlay?.());
    await waitFor(() =>
      expect(screen.queryByTestId("ticket-overlay")).not.toBeInTheDocument(),
    );

    // A reload is a fresh tree on whatever URL the address bar still holds.
    first.unmount();
    render(<ProjectDeskPage />);

    await screen.findByTestId("board");
    expect(screen.queryByTestId("ticket-overlay")).not.toBeInTheDocument();
  });

  it("does not re-open a closed overlay when a navigation renews the router", async () => {
    setUrl("/projects/proj1?ticket=T1");
    const view = render(<ProjectDeskPage />);
    await screen.findByTestId("ticket-overlay");

    act(() => closeOverlay?.());
    await waitFor(() =>
      expect(screen.queryByTestId("ticket-overlay")).not.toBeInTheDocument(),
    );

    // The deep link is spent. Re-running the effect — which Next does on its
    // own the moment any navigation commits — must not resurrect it.
    act(() => {
      bumpRouterIdentity();
      view.rerender(<ProjectDeskPage />);
    });

    await screen.findByTestId("board");
    expect(screen.queryByTestId("ticket-overlay")).not.toBeInTheDocument();
  });

  it("re-opens the same ticket when the deep link is followed a second time", async () => {
    setUrl("/projects/proj1?ticket=T1");
    const first = render(<ProjectDeskPage />);
    await screen.findByTestId("ticket-overlay");
    act(() => closeOverlay?.());
    first.unmount();

    // Consuming a value once must not make a repeated notification link dead.
    setUrl("/projects/proj1?ticket=T1");
    render(<ProjectDeskPage />);

    expect(await screen.findByTestId("ticket-overlay")).toHaveTextContent("T1");
  });

  it("consumes ?nightRun= without waiting on a navigation either", async () => {
    setUrl("/projects/proj1?nightRun=night_abc");
    render(<ProjectDeskPage />);

    await waitFor(() =>
      expect(screen.getByTestId("night-summary-open")).toHaveTextContent("night_abc"),
    );
    expect(window.location.search).toBe("");
  });

  it("never leaves a deep-link navigation queued behind the address bar", async () => {
    setUrl("/projects/proj1?ticket=T1");
    render(<ProjectDeskPage />);
    await screen.findByTestId("ticket-overlay");

    // If a round-trip were still pending, letting it land would be the only
    // thing that cleans the URL — and that is precisely the stale window.
    const searchBeforeFlush = window.location.search;
    flushPendingNavigation();
    expect(searchBeforeFlush).toBe("");
  });
});
