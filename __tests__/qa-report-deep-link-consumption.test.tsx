/**
 * `/projects/:id/qa?reportId=<id>` — the source link on a ticket generated
 * from a QA report — has to be *consumed*, not merely read. The page says so
 * in its own comment ("remove the transient parameter"); it was not doing it.
 *
 * Sibling of `__tests__/ticket-deep-link-consumption.test.tsx`, same defect
 * class in a different file. The mocks model the two things that make the bug
 * invisible to a `router.replace` assertion:
 *
 * 1. `router.replace()` IS A NAVIGATION, not a URL rewrite. The App Router
 *    fetches the destination's RSC payload and only touches the address bar
 *    when that round-trip commits. Measured on the board page in Chrome
 *    against a warm `next dev`: three RSC requests and ~3.4s before the spent
 *    parameter left the address bar; ~150ms under `next start`. Inside that
 *    window the user can pick another report and reload, and the stale deep
 *    link replays. So `replace()` here records the href and changes nothing
 *    until `flushPendingNavigation()` says the server answered.
 *
 * 2. `window.history.replaceState` is wired the way the App Router patches it
 *    (`app-router.js`: rewrite the URL, then sync `useSearchParams`), so it
 *    lands synchronously and costs no round-trip.
 *
 * A page that consumes the deep link through a navigation therefore fails
 * these tests; one that consumes it through the history API passes.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useSyncExternalStore } from "react";

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

/** A committed navigation gives `useRouter()` a new object. */
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
  useParams: () => ({ projectId: "proj-1" }),
  useRouter: () => routerInstance,
  useSearchParams: () =>
    useSyncExternalStore(
      subscribeToUrl,
      () => snapshotParams,
      () => snapshotParams,
    ),
}));

const reports = [
  {
    id: "report-default",
    projectId: "proj-1",
    status: "completed",
    agentSessionId: "session-default",
    namedAgentId: null,
    promptUsed: null,
    customPromptId: null,
    reportContent: "Default report",
    summary: "Default report",
    checkType: "tech_check",
    createdAt: "2026-08-25T09:00:00.000Z",
    completedAt: "2026-08-25T09:01:00.000Z",
  },
  {
    id: "report-linked",
    projectId: "proj-1",
    status: "completed",
    agentSessionId: "session-linked",
    namedAgentId: null,
    promptUsed: null,
    customPromptId: null,
    reportContent: "Linked report",
    summary: "Linked report",
    checkType: "failure_digest",
    createdAt: "2026-08-25T10:00:00.000Z",
    completedAt: "2026-08-25T10:01:00.000Z",
  },
];

vi.mock("@/hooks/useQaReports", () => ({
  useQaReports: () => ({
    reports,
    loading: false,
    error: null,
    refresh: vi.fn(),
  }),
}));

vi.mock("@/components/qa/ReportDetail", () => ({
  ReportDetail: ({ reportId }: { reportId: string | null }) => (
    <div data-testid="report-detail">{reportId}</div>
  ),
}));

vi.mock("@/components/qa/StartQaCheckDialog", () => ({
  StartQaCheckDialog: () => null,
}));

import QAPage from "@/app/projects/[projectId]/qa/page";

/** The selection the page falls back to when no deep link names one. */
const FALLBACK_REPORT = "report-default";

/** Let a deferred consumption (a queued microtask) land if there is one. */
async function settle() {
  await act(async () => {
    await Promise.resolve();
  });
}

describe("QA page — the ?reportId= deep link is consumed", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pendingNavigations.length = 0;
    routerInstance = { replace: routerReplace, push: vi.fn(), refresh: vi.fn() };
    setUrl("/projects/proj-1/qa");
    global.fetch = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ data: {} }) });
  });

  afterEach(() => {
    // Unmount before touching the address bar: the rewrite notifies the
    // `useSearchParams` store, and a still-mounted page would take that
    // update outside `act`. Vitest runs this hook before RTL's own cleanup.
    cleanup();
    setUrl("/projects/proj-1/qa");
  });

  // Control: true on both sides of the fix. If this goes red the deep link
  // itself is broken, not its consumption.
  it("selects the report the query names", async () => {
    setUrl("/projects/proj-1/qa?reportId=report-linked");
    render(<QAPage />);

    await waitFor(() =>
      expect(screen.getByTestId("report-detail")).toHaveTextContent(
        "report-linked",
      ),
    );
  });

  it("has already stripped ?reportId= by the time the report is selected", async () => {
    setUrl("/projects/proj-1/qa?reportId=report-linked");
    render(<QAPage />);

    await waitFor(() =>
      expect(screen.getByTestId("report-detail")).toHaveTextContent(
        "report-linked",
      ),
    );

    // No `flushPendingNavigation()` on purpose: the address bar has to be
    // clean without waiting on a server round-trip, because the user can move
    // to another report and reload inside that window.
    expect(window.location.search).toBe("");
  });

  it("leaves the rest of the query untouched", async () => {
    setUrl("/projects/proj-1/qa?reportId=report-linked&keep=1");
    render(<QAPage />);

    await waitFor(() =>
      expect(screen.getByTestId("report-detail")).toHaveTextContent(
        "report-linked",
      ),
    );

    const params = new URLSearchParams(window.location.search);
    expect(params.has("reportId")).toBe(false);
    expect(params.get("keep")).toBe("1");
  });

  it("consumes a source link that arrives while the page is already mounted", async () => {
    render(<QAPage />);
    expect(screen.getByTestId("report-detail")).toHaveTextContent(
      FALLBACK_REPORT,
    );

    act(() => setUrl("/projects/proj-1/qa?reportId=report-linked"));

    await waitFor(() =>
      expect(screen.getByTestId("report-detail")).toHaveTextContent(
        "report-linked",
      ),
    );
    expect(window.location.search).toBe("");
  });

  it("does not restore the stale selection when the page is reloaded", async () => {
    setUrl("/projects/proj-1/qa?reportId=report-linked");
    const first = render(<QAPage />);
    await waitFor(() =>
      expect(screen.getByTestId("report-detail")).toHaveTextContent(
        "report-linked",
      ),
    );

    // The user moves on to another report — the deep link is spent.
    fireEvent.click(screen.getByText("Default report"));
    await waitFor(() =>
      expect(screen.getByTestId("report-detail")).toHaveTextContent(
        FALLBACK_REPORT,
      ),
    );

    // A reload is a fresh tree on whatever URL the address bar still holds.
    first.unmount();
    render(<QAPage />);
    await settle();

    expect(screen.getByTestId("report-detail")).toHaveTextContent(
      FALLBACK_REPORT,
    );
  });

  it("does not restore the stale selection when a navigation renews the router", async () => {
    setUrl("/projects/proj-1/qa?reportId=report-linked");
    const view = render(<QAPage />);
    await waitFor(() =>
      expect(screen.getByTestId("report-detail")).toHaveTextContent(
        "report-linked",
      ),
    );

    fireEvent.click(screen.getByText("Default report"));
    await waitFor(() =>
      expect(screen.getByTestId("report-detail")).toHaveTextContent(
        FALLBACK_REPORT,
      ),
    );

    // Next re-runs the effect on its own the moment any navigation commits:
    // `useRouter()` is memoised on the closest CacheNode's bfcache id. That
    // must not resurrect a spent deep link.
    act(() => {
      bumpRouterIdentity();
      view.rerender(<QAPage />);
    });
    await settle();

    expect(screen.getByTestId("report-detail")).toHaveTextContent(
      FALLBACK_REPORT,
    );
  });

  it("selects the same report again when the source link is followed twice", async () => {
    setUrl("/projects/proj-1/qa?reportId=report-linked");
    const first = render(<QAPage />);
    await waitFor(() =>
      expect(screen.getByTestId("report-detail")).toHaveTextContent(
        "report-linked",
      ),
    );
    first.unmount();

    // Consuming a value once must not make a repeated source link dead.
    setUrl("/projects/proj-1/qa?reportId=report-linked");
    render(<QAPage />);

    await waitFor(() =>
      expect(screen.getByTestId("report-detail")).toHaveTextContent(
        "report-linked",
      ),
    );
  });

  it("never leaves a deep-link navigation queued behind the address bar", async () => {
    setUrl("/projects/proj-1/qa?reportId=report-linked");
    render(<QAPage />);
    await waitFor(() =>
      expect(screen.getByTestId("report-detail")).toHaveTextContent(
        "report-linked",
      ),
    );

    // If a round-trip were still pending, letting it land would be the only
    // thing that cleans the URL — and that is precisely the stale window.
    const searchBeforeFlush = window.location.search;
    flushPendingNavigation();
    expect(searchBeforeFlush).toBe("");
  });
});
