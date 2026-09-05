/**
 * Sessions list page × switching projects while the list is still loading.
 *
 * The page follows the route's keyset cursor to the end, so "loading" is not
 * one round trip any more — it is one window per page, held open for as long
 * as the project has sessions. Switching projects re-runs the effect, and
 * without a guard the *previous* project's loop keeps running: it keeps
 * fetching, and it keeps calling `setItems`.
 *
 * WHAT WAS MEASURED, AND WHERE. Driven in Chrome against a 733-session
 * project (four pages) switching to a 282-session one, the abandoned loop
 * made four more session-list requests after the switch. That waste is real
 * and is what the AbortController removes.
 *
 * The stale *write* is a different claim, and an honest reading of it is
 * narrower than the ticket's: Next's App Router remounts this page when the
 * `[projectId]` segment changes — verified in Chrome, on a client-side
 * navigation with no document request, by the page's own filter state
 * resetting — so the abandoned loop's `setItems` currently lands on an
 * unmounted component and does nothing. The screen-replacement symptom the
 * ticket describes was NOT reproduced through in-app navigation.
 *
 * These tests therefore drive the re-render path deliberately, and pin a
 * component-level contract rather than a reproduction:
 *   - remount-on-param-change is a routing detail this component should not
 *     have to depend on for correctness, and
 *   - the sibling hooks in this family genuinely do take the re-render path.
 *     `useTicketOverlayData` is the live case: the cross-project desk at `/`
 *     opens tickets from different projects without remounting, so its
 *     `projectId` changes under a component that stays put. It already
 *     carries the `cancelled` guard this file pins here.
 *
 * Both halves of the guarantee are covered: the abandoned loop never writes
 * again (and never raises the "list is incomplete" banner out of its own
 * cancellation), and it stops fetching.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import SessionsPage from "@/app/projects/[projectId]/sessions/page";

let currentProjectId = "proj-a";

vi.mock("next/navigation", () => ({
  useParams: () => ({ projectId: currentProjectId }),
}));

// Same substitution as the sibling page tests: Radix Select's portal/pointer
// plumbing is covered by the shared UI component, and a native select is what
// lets jsdom read back the rendered row order.
vi.mock("@/components/ui/select", () => ({
  Select: ({
    value,
    onValueChange,
    children,
  }: {
    value: string;
    onValueChange: (value: string) => void;
    children: ReactNode;
  }) => (
    <select
      aria-label="Sort sessions"
      data-testid="sessions-sort"
      value={value}
      onChange={(event) => onValueChange(event.target.value)}
    >
      {children}
    </select>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children: ReactNode }) => (
    <option value={value}>{children}</option>
  ),
}));

vi.mock("@/components/night/NightRunSummaryDialog", () => ({
  NightRunSummaryDialog: () => null,
}));

function agentSession(id: string, createdAt: string) {
  return {
    kind: "agent_session",
    id,
    status: "completed",
    mode: "code",
    provider: "claude-code",
    createdAt,
    lastActivityAt: createdAt,
  };
}

interface Page {
  data: unknown[];
  nextCursor: string | null;
  /** Optional gate, so a test can hold a page in flight and release it later. */
  release?: Promise<void>;
  /**
   * Optional gate on the *body*, held after the response itself has resolved.
   * That window is the one an `AbortSignal` alone cannot close: the request
   * has already succeeded, so aborting it rejects nothing, and the page lands
   * in the client's hands regardless.
   */
  releaseBody?: Promise<void>;
}

interface ProjectPages {
  [projectId: string]: Page[];
}

/**
 * Serve each project its own cursor-keyed pages, honouring `AbortSignal` the
 * way a real `fetch` does. Honouring it matters: a stub that ignores the
 * signal would let a cancelled request resolve anyway, and the test could not
 * tell a page dropped on arrival from a request that was never made.
 */
function mockProjectPages(pages: ProjectPages) {
  const byProject = new Map<string, Map<string | null, Page>>();
  for (const [projectId, projectPages] of Object.entries(pages)) {
    const byCursor = new Map<string | null, Page>();
    let key: string | null = null;
    for (const page of projectPages) {
      byCursor.set(key, page);
      key = page.nextCursor;
    }
    byProject.set(projectId, byCursor);
  }

  const requests: { projectId: string; cursor: string | null }[] = [];

  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown, init?: { signal?: AbortSignal }) => {
      const parsed = new URL(String(url), "http://localhost");
      if (parsed.pathname.includes("/build/night-runs")) {
        return { ok: true, json: async () => ({ data: [] }) };
      }

      const projectId = parsed.pathname.split("/")[3];
      const cursor = parsed.searchParams.get("cursor");
      requests.push({ projectId, cursor });

      const page = byProject.get(projectId)?.get(cursor);
      if (!page) {
        throw new Error(`stub has no page for ${projectId} @ ${String(cursor)}`);
      }

      const signal = init?.signal;
      if (signal?.aborted) throw abortError();
      if (page.release) {
        await new Promise<void>((resolve, reject) => {
          void page.release!.then(resolve);
          signal?.addEventListener("abort", () => reject(abortError()));
        });
      }
      return {
        ok: true,
        json: async () => {
          if (page.releaseBody) await page.releaseBody;
          return { data: page.data, nextCursor: page.nextCursor };
        },
      };
    })
  );

  return { requests };
}

function abortError(): Error {
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}

function visibleSessionIds(): string[] {
  return screen
    .queryAllByTestId(/^session-row-/)
    .map((row) => row.getAttribute("data-testid")!.replace("session-row-", ""));
}

const A_PAGE_ONE = [agentSession("A-page1", "2026-03-10T00:00:00.000Z")];
const A_PAGE_TWO = [agentSession("A-page2", "2026-03-09T00:00:00.000Z")];
const B_ONLY = [agentSession("B-only", "2026-03-08T00:00:00.000Z")];

const A_CURSOR = "2026-03-10T00:00:00.000Z|A-page1";

describe("SessionsPage — switching projects mid-load", () => {
  beforeEach(() => {
    currentProjectId = "proj-a";
    vi.restoreAllMocks();
  });

  it("does not let the previous project's tail replace the new project's list", async () => {
    let releaseAPageTwo: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseAPageTwo = resolve;
    });

    mockProjectPages({
      "proj-a": [
        { data: A_PAGE_ONE, nextCursor: A_CURSOR },
        { data: A_PAGE_TWO, nextCursor: null, release: gate },
      ],
      "proj-b": [{ data: B_ONLY, nextCursor: null }],
    });

    const view = render(<SessionsPage />);
    // Project A's first page has painted; its second page is still in flight.
    await waitFor(() => expect(visibleSessionIds()).toEqual(["A-page1"]));

    currentProjectId = "proj-b";
    view.rerender(<SessionsPage />);
    await waitFor(() => expect(visibleSessionIds()).toEqual(["B-only"]));

    // A's abandoned loop finally gets its page. It must land nowhere.
    releaseAPageTwo();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(visibleSessionIds()).toEqual(["B-only"]);
    // ...and the cancellation is not a loading failure: the banner claims the
    // *rendered* list is a prefix, which would be a lie about project B.
    expect(screen.queryByTestId("sessions-incomplete")).not.toBeInTheDocument();
  });

  it("stops paging the project the user left", async () => {
    let releaseAPageTwo: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseAPageTwo = resolve;
    });

    const { requests } = mockProjectPages({
      "proj-a": [
        { data: A_PAGE_ONE, nextCursor: A_CURSOR },
        // Held, so the switch happens with a request genuinely in flight.
        {
          data: A_PAGE_TWO,
          nextCursor: "2026-03-09T00:00:00.000Z|A-page2",
          release: gate,
        },
        // A third page exists only to be *not* requested. Reaching it means
        // the abandoned loop kept following the cursor after the switch.
        {
          data: [agentSession("A-page3", "2026-03-07T00:00:00.000Z")],
          nextCursor: null,
        },
      ],
      "proj-b": [{ data: B_ONLY, nextCursor: null }],
    });

    const view = render(<SessionsPage />);
    await waitFor(() => expect(visibleSessionIds()).toEqual(["A-page1"]));

    currentProjectId = "proj-b";
    view.rerender(<SessionsPage />);
    await waitFor(() => expect(visibleSessionIds()).toEqual(["B-only"]));

    // Releasing the gate after the abort proves the request was dropped
    // rather than merely slow: a live loop would resume and ask for page 3.
    releaseAPageTwo();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(
      requests.filter((r) => r.projectId === "proj-a").map((r) => r.cursor)
    ).toEqual([null, A_CURSOR]);
  });

  it("drops a page already in hand when the switch happens", async () => {
    // The request succeeded before the user switched; only its body is still
    // being read. Aborting cannot unwind that, so the page arrives either
    // way — the loop must decline to paint it.
    let releaseABody: () => void = () => {};
    const bodyGate = new Promise<void>((resolve) => {
      releaseABody = resolve;
    });

    mockProjectPages({
      "proj-a": [
        { data: A_PAGE_ONE, nextCursor: A_CURSOR },
        { data: A_PAGE_TWO, nextCursor: null, releaseBody: bodyGate },
      ],
      "proj-b": [{ data: B_ONLY, nextCursor: null }],
    });

    const view = render(<SessionsPage />);
    await waitFor(() => expect(visibleSessionIds()).toEqual(["A-page1"]));

    currentProjectId = "proj-b";
    view.rerender(<SessionsPage />);
    await waitFor(() => expect(visibleSessionIds()).toEqual(["B-only"]));

    releaseABody();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(visibleSessionIds()).toEqual(["B-only"]);
  });

  it("clears the previous project's rows instead of showing them under the new project", async () => {
    let releaseB: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseB = resolve;
    });

    mockProjectPages({
      "proj-a": [{ data: A_PAGE_ONE, nextCursor: null }],
      "proj-b": [{ data: B_ONLY, nextCursor: null, release: gate }],
    });

    const view = render(<SessionsPage />);
    await waitFor(() => expect(visibleSessionIds()).toEqual(["A-page1"]));

    currentProjectId = "proj-b";
    view.rerender(<SessionsPage />);

    // Project B has nothing yet. The honest screen is the loading state — not
    // project A's session wearing project B's URL.
    await waitFor(() =>
      expect(screen.getByText("Loading sessions...")).toBeInTheDocument()
    );
    expect(visibleSessionIds()).toEqual([]);

    releaseB();
    await waitFor(() => expect(visibleSessionIds()).toEqual(["B-only"]));
  });
});
