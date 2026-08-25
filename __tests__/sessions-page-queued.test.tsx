/**
 * Sessions list page: the synthesis band derived from the loaded sessions
 * (running / today / success rate / queue), the honest empty states, the
 * client-side filter chips (state, provider, ticket query), and the night-run
 * history the "Night run" chip reveals.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import SessionsPage from "@/app/projects/[projectId]/sessions/page";

vi.mock("next/navigation", () => ({
  useParams: () => ({ projectId: "proj-1" }),
}));

// Radix Select's portal/pointer plumbing is covered by the shared UI
// component. Render it as a native select here so this page test can drive
// the controlled value and assert the resulting session order in jsdom.
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
  SelectItem: ({
    value,
    children,
  }: {
    value: string;
    children: ReactNode;
  }) => <option value={value}>{children}</option>,
}));

// The dialog owns its own rendering matrix in night-run-summary-dialog.test.tsx.
// What this file asserts is the handoff: which run id the page opens it with.
vi.mock("@/components/night/NightRunSummaryDialog", () => ({
  NightRunSummaryDialog: ({
    open,
    runId,
  }: {
    open: boolean;
    runId: string | null;
  }) => (open ? <div data-testid="night-summary-open">{runId}</div> : null),
}));

function agentSession(overrides: Record<string, unknown>) {
  const createdAt =
    typeof overrides.createdAt === "string"
      ? overrides.createdAt
      : new Date().toISOString();
  return {
    kind: "agent_session",
    id: "sess-x",
    status: "completed",
    mode: "code",
    provider: "claude-code",
    // "today" so the band's Today/Success-rate cells see it
    createdAt,
    lastActivityAt: createdAt,
    ...overrides,
  };
}

function chatSession(overrides: Record<string, unknown>) {
  const createdAt =
    typeof overrides.createdAt === "string"
      ? overrides.createdAt
      : new Date().toISOString();
  return {
    kind: "chat_session",
    id: "conv-x",
    type: "brainstorm",
    label: "Chat",
    status: "active",
    provider: "claude-code",
    messageCount: 1,
    lastMessagePreview: "Hello",
    createdAt,
    lastActivityAt: createdAt,
    ...overrides,
  };
}

/**
 * A run the registry still knows. `source` and `interrupted` are correlated on
 * the server — `detailFromRegistry` pairs "registry"/false, `detailFromDb`
 * pairs "db"/true — so the two must be overridden together to stay a payload
 * the API could actually produce.
 */
function nightRun(overrides: Record<string, unknown>) {
  return {
    runId: "night_a41c",
    projectId: "proj-1",
    source: "registry",
    interrupted: false,
    state: "finished",
    startedAt: new Date("2026-08-19T23:04:00Z").toISOString(),
    endedAt: new Date("2026-08-20T02:11:00Z").toISOString(),
    counts: { done: 3, asked: 1, failed: 2, skipped: 0, running: 0, pending: 0 },
    totalCostUsd: 4.2,
    abortReason: null,
    ...overrides,
  };
}

/**
 * The page hits two endpoints: the session list, and — only while the "Night
 * run" chip is active — the night-run list. Route by URL so the two never
 * feed each other the wrong payload.
 */
function mockEndpoints({
  sessions = [] as unknown[],
  nightRuns = [] as unknown[],
} = {}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown) => ({
      ok: true,
      json: async () => ({
        data: String(url).includes("/build/night-runs") ? nightRuns : sessions,
      }),
    }))
  );
}

function mockSessions(data: unknown[]) {
  mockEndpoints({ sessions: data });
}

/**
 * Sessions load, night runs do not. The page has to keep serving the session
 * rows while being honest about the list it could not fetch.
 */
function mockNightRunsFailure(
  failure: { throws: true } | { status: number; error?: string },
  sessions: unknown[] = []
) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown) => {
      if (!String(url).includes("/build/night-runs")) {
        return { ok: true, json: async () => ({ data: sessions }) };
      }
      if ("throws" in failure) throw new Error("network down");
      return {
        ok: false,
        status: failure.status,
        json: async () => ({ error: failure.error }),
      };
    })
  );
}

async function renderPage() {
  render(<SessionsPage />);
  await waitFor(() =>
    expect(screen.queryByText("Loading sessions...")).not.toBeInTheDocument()
  );
}

describe("SessionsPage — synthesis band", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockSessions([
      agentSession({ id: "sess-queued", status: "queued" }),
      agentSession({
        id: "sess-running",
        status: "running",
        startedAt: new Date().toISOString(),
      }),
      agentSession({ id: "sess-done", status: "completed", totalCostUsd: 0.5 }),
      agentSession({ id: "sess-failed", status: "failed", error: "boom" }),
    ]);
  });

  it("counts running, today, success rate and the queue", async () => {
    await renderPage();

    expect(screen.getByTestId("sessions-band")).toBeInTheDocument();
    expect(screen.getByTestId("sessions-band-running")).toHaveTextContent(
      "1 session"
    );
    // Terminal sessions created today, with the reported cost summed.
    expect(screen.getByTestId("sessions-band-today")).toHaveTextContent(
      "2 sessions"
    );
    expect(screen.getByTestId("sessions-band-today")).toHaveTextContent("$0.50");
    expect(screen.getByTestId("sessions-band-success")).toHaveTextContent(
      "1 / 2"
    );
    expect(screen.getByTestId("sessions-band-queue")).toHaveTextContent(
      "1 queued"
    );
  });

  it("renders one row per session, with the Queued state spelled out", async () => {
    await renderPage();

    expect(screen.getByTestId("session-row-sess-queued")).toHaveTextContent(
      "Queued"
    );
    expect(screen.getByTestId("session-row-sess-running")).toHaveTextContent(
      "Running"
    );
    expect(screen.getByTestId("session-row-sess-failed")).toHaveTextContent(
      "Failed"
    );
    // The row links to the existing detail route.
    expect(screen.getByTestId("session-row-sess-done")).toHaveAttribute(
      "href",
      "/projects/proj-1/sessions/sess-done"
    );
  });
});

describe("SessionsPage — empty states", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("says nothing is queued instead of showing a zero counter", async () => {
    mockSessions([agentSession({ id: "sess-done", status: "completed" })]);
    await renderPage();

    expect(screen.getByTestId("sessions-band-queue")).toHaveTextContent(
      "Nothing queued"
    );
    expect(screen.queryByText(/1 queued/)).not.toBeInTheDocument();
    expect(screen.getByTestId("sessions-band-running")).toHaveTextContent(
      "None right now"
    );
  });

  it("keeps the no-sessions copy when the project never ran anything", async () => {
    mockSessions([]);
    await renderPage();

    expect(screen.getByText("No sessions yet")).toBeInTheDocument();
  });
});

describe("SessionsPage — filters", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockSessions([
      agentSession({
        id: "sess-night",
        status: "completed",
        batchRunId: "night_a41c",
        epicId: "epic-9",
      }),
      agentSession({
        id: "sess-day",
        status: "failed",
        batchRunId: "batch_1",
        branchName: "arij/feature-x",
      }),
      agentSession({
        id: "sess-codex",
        status: "running",
        provider: "codex",
        startedAt: new Date().toISOString(),
      }),
    ]);
  });

  it("filters to running sessions only", async () => {
    await renderPage();

    fireEvent.click(screen.getByTestId("sessions-filter-running"));

    expect(screen.getByTestId("session-row-sess-codex")).toBeInTheDocument();
    expect(
      screen.queryByTestId("session-row-sess-night")
    ).not.toBeInTheDocument();
    expect(screen.queryByTestId("session-row-sess-day")).not.toBeInTheDocument();
  });

  it("filters to failed sessions only", async () => {
    await renderPage();

    fireEvent.click(screen.getByTestId("sessions-filter-failed"));

    expect(screen.getByTestId("session-row-sess-day")).toBeInTheDocument();
    expect(
      screen.queryByTestId("session-row-sess-codex")
    ).not.toBeInTheDocument();
  });

  it("filters to night-run sessions by their batch tag", async () => {
    await renderPage();

    fireEvent.click(screen.getByTestId("sessions-filter-night"));
    // The chip also mounts the night-run list; let its fetch settle so the
    // state update lands inside the test.
    await screen.findByTestId("night-runs-list");

    expect(screen.getByTestId("session-row-sess-night")).toBeInTheDocument();
    expect(screen.queryByTestId("session-row-sess-day")).not.toBeInTheDocument();
  });

  it("filters by provider and clears back with All", async () => {
    await renderPage();

    fireEvent.click(screen.getByTestId("sessions-filter-codex"));
    expect(screen.getByTestId("session-row-sess-codex")).toBeInTheDocument();
    expect(
      screen.queryByTestId("session-row-sess-night")
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("sessions-filter-all"));
    expect(screen.getByTestId("session-row-sess-night")).toBeInTheDocument();
    expect(screen.getByTestId("session-row-sess-codex")).toBeInTheDocument();
  });

  it("does not fetch night runs until the Night run chip is on", async () => {
    await renderPage();

    const calls = () =>
      (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.filter(
        (c) => String(c[0]).includes("/build/night-runs")
      );

    expect(calls()).toHaveLength(0);
    fireEvent.click(screen.getByTestId("sessions-filter-night"));
    await waitFor(() => expect(calls().length).toBeGreaterThan(0));
  });

  it("filters by ticket text against the epic id and the branch", async () => {
    await renderPage();

    const input = screen.getByPlaceholderText("Filter by ticket");
    fireEvent.change(input, { target: { value: "epic-9" } });

    expect(screen.getByTestId("session-row-sess-night")).toBeInTheDocument();
    expect(screen.queryByTestId("session-row-sess-day")).not.toBeInTheDocument();

    fireEvent.change(input, { target: { value: "arij/feature" } });
    expect(screen.getByTestId("session-row-sess-day")).toBeInTheDocument();
    expect(
      screen.queryByTestId("session-row-sess-night")
    ).not.toBeInTheDocument();
  });
});

describe("SessionsPage — sorting", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockSessions([
      chatSession({
        id: "conv-created-newest",
        createdAt: "2026-02-05T00:00:00.000Z",
        lastActivityAt: "2026-02-06T00:00:00.000Z",
      }),
      agentSession({
        id: "sess-created-middle",
        createdAt: "2026-02-04T00:00:00.000Z",
        lastActivityAt: "2026-02-09T00:00:00.000Z",
      }),
      agentSession({
        id: "sess-created-oldest",
        createdAt: "2026-02-01T00:00:00.000Z",
        lastActivityAt: "2026-02-10T00:00:00.000Z",
      }),
    ]);
  });

  function visibleSessionIds(): string[] {
    return screen
      .getAllByTestId(/^session-row-/)
      .map((row) => row.getAttribute("data-testid")!.replace("session-row-", ""));
  }

  it("offers Last activity and sorts the most recently active sessions first", async () => {
    await renderPage();

    const sort = screen.getByLabelText("Sort sessions");
    expect(sort).toHaveValue("created");
    expect(
      screen.getByRole("option", { name: "Last activity" })
    ).toBeInTheDocument();
    expect(screen.getByText("Activity", { selector: "span" })).toBeInTheDocument();
    expect(
      screen.getByTestId("session-activity-sess-created-oldest")
    ).toHaveAttribute("title", "2026-02-10T00:00:00.000Z");
    expect(visibleSessionIds()).toEqual([
      "conv-created-newest",
      "sess-created-middle",
      "sess-created-oldest",
    ]);

    fireEvent.change(sort, { target: { value: "last_activity" } });

    expect(visibleSessionIds()).toEqual([
      "sess-created-oldest",
      "sess-created-middle",
      "conv-created-newest",
    ]);
  });

  it("keeps sessions with missing or invalid activity deterministic", async () => {
    mockSessions([
      agentSession({
        id: "sess-z-invalid",
        createdAt: "invalid",
        lastActivityAt: "invalid",
      }),
      agentSession({
        id: "sess-y-missing",
        createdAt: "invalid",
        lastActivityAt: null,
      }),
      agentSession({
        id: "sess-a-valid",
        createdAt: "2026-02-01T00:00:00.000Z",
        lastActivityAt: "2026-02-10T00:00:00.000Z",
      }),
    ]);
    await renderPage();

    fireEvent.change(screen.getByLabelText("Sort sessions"), {
      target: { value: "last_activity" },
    });

    expect(visibleSessionIds()).toEqual([
      "sess-a-valid",
      "sess-y-missing",
      "sess-z-invalid",
    ]);
  });
});

/**
 * This list is the only durable entry point to a past run's morning summary
 * — the "Night run finished" notification deep link is transient.
 */
describe("SessionsPage — night-run history", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  async function openNightHistory(runs: unknown[]) {
    mockEndpoints({
      sessions: [agentSession({ id: "sess-day", status: "completed" })],
      nightRuns: runs,
    });
    await renderPage();
    fireEvent.click(screen.getByTestId("sessions-filter-night"));
    return screen.findByTestId("night-runs-list");
  }

  it("stays hidden until the Night run chip is on", async () => {
    mockEndpoints({
      sessions: [agentSession({ id: "sess-day" })],
      nightRuns: [nightRun({})],
    });
    await renderPage();

    expect(screen.queryByTestId("night-runs-list")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("sessions-filter-night"));
    expect(await screen.findByTestId("night-runs-list")).toBeInTheDocument();
  });

  it("lists past runs with their outcome counts and id", async () => {
    await openNightHistory([
      nightRun({ runId: "night_a41c" }),
      nightRun({ runId: "night_b72d", counts: { done: 1 } }),
    ]);

    const row = await screen.findByTestId("night-run-row-night_a41c");
    expect(row).toHaveTextContent("3 in review, 1 paused, 2 failed");
    expect(row).toHaveTextContent("night_a41c");
    expect(
      await screen.findByTestId("night-run-row-night_b72d")
    ).toHaveTextContent("1 in review");
  });

  it("opens the summary dialog for the clicked run", async () => {
    await openNightHistory([nightRun({ runId: "night_a41c" })]);

    expect(screen.queryByTestId("night-summary-open")).not.toBeInTheDocument();

    fireEvent.click(await screen.findByTestId("night-run-row-night_a41c"));

    // Same component, same props as the board's `?nightRun=` deep link.
    expect(screen.getByTestId("night-summary-open")).toHaveTextContent(
      "night_a41c"
    );
  });

  it("flags a live run instead of offering its summary as history", async () => {
    await openNightHistory([
      nightRun({ runId: "night_live", state: "running", endedAt: null }),
    ]);

    expect(
      await screen.findByTestId("night-run-row-night_live")
    ).toHaveTextContent("Running");
  });

  it("says so when the project never ran a night run", async () => {
    await openNightHistory([]);

    expect(
      await screen.findByText("No night runs recorded yet.")
    ).toBeInTheDocument();
  });

  /**
   * The server flags every run it rebuilds from session rows as `interrupted`,
   * and the registry that would say otherwise is in-memory and ring-capped —
   * so a clean run earns the flag just by outliving a restart. The row reports
   * where the record came from, and stops short of alleging why.
   */
  it("calls a DB-derived run rebuilt, not interrupted", async () => {
    await openNightHistory([
      nightRun({ runId: "night_old", source: "db", interrupted: true }),
    ]);

    const row = await screen.findByTestId("night-run-row-night_old");
    expect(row).toHaveTextContent("rebuilt from history");
    expect(row).not.toHaveTextContent(/interrupted/i);
  });

  it("does not pass a failed request off as an empty history", async () => {
    mockNightRunsFailure({ throws: true });
    await renderPage();
    fireEvent.click(screen.getByTestId("sessions-filter-night"));

    expect(await screen.findByTestId("night-runs-error")).toBeInTheDocument();
    expect(
      screen.queryByText("No night runs recorded yet.")
    ).not.toBeInTheDocument();
  });

  it("surfaces the server's message when the list route errors", async () => {
    mockNightRunsFailure({ status: 500, error: "Night run registry is down" });
    await renderPage();
    fireEvent.click(screen.getByTestId("sessions-filter-night"));

    expect(await screen.findByTestId("night-runs-error")).toHaveTextContent(
      "Night run registry is down"
    );
    expect(
      screen.queryByText("No night runs recorded yet.")
    ).not.toBeInTheDocument();
  });

  it("recovers the history when Retry succeeds", async () => {
    let failing = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown) => {
        if (!String(url).includes("/build/night-runs")) {
          return { ok: true, json: async () => ({ data: [] }) };
        }
        if (failing) throw new Error("network down");
        return {
          ok: true,
          json: async () => ({ data: [nightRun({ runId: "night_a41c" })] }),
        };
      })
    );

    await renderPage();
    fireEvent.click(screen.getByTestId("sessions-filter-night"));
    await screen.findByTestId("night-runs-error");

    failing = false;
    fireEvent.click(screen.getByTestId("night-runs-retry"));

    expect(
      await screen.findByTestId("night-run-row-night_a41c")
    ).toBeInTheDocument();
    expect(screen.queryByTestId("night-runs-error")).not.toBeInTheDocument();
  });
});
