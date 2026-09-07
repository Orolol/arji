/**
 * Frame 8d's own behaviour: the range control, the MONTHLY CAP tile and
 * its inline editor, band collapse, and the BY DAY failure caps.
 *
 * The provider subscription cards, the polling contract and the state
 * precedence are covered by `__tests__/usage-page.test.tsx` and
 * `__tests__/usage-live-cards.test.tsx`; nothing here duplicates them.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import UsagePage from "@/app/usage/page";
import type {
  SubscriptionStatus,
  UsageDashboard,
  UsageDayBar,
  UsageReport,
} from "@/lib/types/usage";

const FIXED_NOW = Date.parse("2026-08-18T12:00:00.000Z");

const DAY_KEYS: string[] = [
  ...Array.from({ length: 12 }, (_, i) => `2026-07-${20 + i}`),
  ...Array.from(
    { length: 18 },
    (_, i) => `2026-08-${String(i + 1).padStart(2, "0")}`
  ),
];

function makeDays(
  overrides: Record<
    string,
    { sessions: number; costUsd: number | null; failedSessions?: number }
  > = {}
): UsageDayBar[] {
  return DAY_KEYS.map((date) => ({
    date,
    sessions: overrides[date]?.sessions ?? 0,
    costUsd: overrides[date]?.costUsd ?? null,
    failedSessions: overrides[date]?.failedSessions ?? 0,
  }));
}

const CLAUDE_SUB: SubscriptionStatus = {
  provider: "claude-code",
  source: "metered-via-arij",
  sourceDetail: "arij-sessions",
  plan: null,
  capturedAt: null,
  primary: null,
  secondary: null,
  claudeLive: null,
  codexLive: null,
  metered: {
    last5h: { sessions: 0, inputTokens: null, outputTokens: null, costUsd: null },
    last7d: { sessions: 0, inputTokens: null, outputTokens: null, costUsd: null },
    budgetUsdWeek: null,
    budgetUsedPercent: null,
  },
};

function makeDashboard(overrides: Partial<UsageDashboard> = {}): UsageDashboard {
  return {
    range: "30d",
    since: "2026-07-19T12:00:00.000Z",
    totals: {
      costUsd: 184,
      sessions: 412,
      cleanPercent: 86,
      ticketsShipped: 409,
      costPerTicketUsd: 0.45,
    },
    cap: { capUsd: null, spentUsd: 184, usedPercent: null, alertPercent: 80 },
    byAgent: [
      {
        key: "Opus Builder|claude-code",
        label: "Opus Builder",
        costUsd: 96,
        sessions: 20,
        sharePercent: 52,
      },
      {
        key: "Codex Fast|codex",
        label: "Codex Fast",
        costUsd: 52,
        sessions: 11,
        sharePercent: 28,
      },
    ],
    byProject: [
      {
        key: "p1",
        projectId: "p1",
        label: "Arij",
        colorIndex: null,
        costUsd: 81,
        sessions: 30,
        sharePercent: 46,
      },
    ],
    byDay: makeDays({ "2026-08-18": { sessions: 3, costUsd: 4 } }),
    nightYesterdayUsd: null,
    ...overrides,
  };
}

function baseReport(dashboard: UsageDashboard = makeDashboard()): UsageReport {
  return {
    totals: { sessions: 412, inputTokens: null, outputTokens: null, costUsd: 184 },
    byAgent: [],
    byProvider: [],
    byProject: [],
    byDay: DAY_KEYS.map((date) => ({ date, sessions: 0, costUsd: null })),
    windows: {
      last5h: { sessions: 0, inputTokens: null, outputTokens: null, costUsd: null },
      last7d: { sessions: 0, inputTokens: null, outputTokens: null, costUsd: null },
    },
    subscriptions: [CLAUDE_SUB],
    generatedAt: "2026-08-18T12:00:00.000Z",
    dashboard,
  };
}

/**
 * GET /api/usage answers with `report`, echoing the requested range back in
 * `dashboard.range` the way the route does; every other call answers `{ ok }`.
 */
function mockFetch(report: UsageReport, opts: { patchOk?: boolean } = {}) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "PATCH") {
      return {
        ok: opts.patchOk ?? true,
        json: async () => ({ data: { updated: true } }),
      };
    }
    const requested = /range=(7d|all)/.exec(url)?.[1] ?? "30d";
    return {
      ok: true,
      json: async () => ({
        data: {
          ...report,
          dashboard: { ...report.dashboard, range: requested },
        },
      }),
    };
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(Date, "now").mockReturnValue(FIXED_NOW);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Usage screen — range control", () => {
  it("refetches the chosen range WITHOUT forcing a live re-poll", async () => {
    const fetchMock = mockFetch(baseReport());
    render(<UsagePage />);

    await screen.findByTestId("usage-band");
    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/usage");

    fireEvent.click(screen.getByText("7d"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    // A range change is a plain read: only Refresh pays the cold-poll latency.
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/usage?range=7d");
  });

  it("combines the range and the forced poll, range first", async () => {
    const fetchMock = mockFetch(baseReport());
    render(<UsagePage />);

    await screen.findByTestId("usage-band");
    fireEvent.click(screen.getByText("7d"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    fireEvent.click(screen.getByTestId("usage-refresh"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(fetchMock).toHaveBeenNthCalledWith(3, "/api/usage?range=7d&fresh=1");
  });

  it("labels the cost tile with the range the PAYLOAD reports", async () => {
    const fetchMock = mockFetch(baseReport());
    render(<UsagePage />);

    // Scoped to the KPI row: the subscription cards below carry their own
    // "LAST 7 DAYS" label for the Arij-metered window.
    const band = () => within(screen.getByTestId("usage-band"));
    await screen.findByTestId("usage-band");
    expect(band().getByText("LAST 30 DAYS")).toBeInTheDocument();

    fireEvent.click(screen.getByText("7d"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(band().getByText("LAST 7 DAYS")).toBeInTheDocument());
  });

  it("says ALL TIME on the all-time range", async () => {
    const fetchMock = mockFetch(baseReport());
    render(<UsagePage />);

    await screen.findByTestId("usage-band");
    fireEvent.click(screen.getByText("All"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/usage?range=all");
    expect(await screen.findByText("ALL TIME")).toBeInTheDocument();
  });
});

describe("Usage screen — MONTHLY CAP", () => {
  it("draws the ratio and a clamped bar when a cap is configured", async () => {
    mockFetch(
      baseReport(
        makeDashboard({
          cap: { capUsd: 250, spentUsd: 184, usedPercent: 74, alertPercent: 80 },
        })
      )
    );
    render(<UsagePage />);

    expect(await screen.findByTestId("usage-cap-readout")).toHaveTextContent(
      "$184.00 / $250.00"
    );
    expect(screen.getByTestId("usage-cap-fill")).toHaveStyle({ width: "74%" });
    expect(screen.getByText("alert at 80%")).toBeInTheDocument();
    // The promise the software cannot keep is deliberately not shipped.
    expect(screen.queryByText(/Full Auto/)).not.toBeInTheDocument();
  });

  it("clamps the bar but never the readout when the cap is blown", async () => {
    mockFetch(
      baseReport(
        makeDashboard({
          cap: { capUsd: 100, spentUsd: 142, usedPercent: 142, alertPercent: 80 },
        })
      )
    );
    render(<UsagePage />);

    const readout = await screen.findByTestId("usage-cap-readout");
    expect(readout).toHaveTextContent("$142.00 / $100.00");
    expect(readout.firstElementChild?.className).toContain("text-destructive");
    expect(screen.getByTestId("usage-cap-fill")).toHaveStyle({ width: "100%" });
  });

  it("collapses to the spend plus a link when no cap is set", async () => {
    mockFetch(baseReport());
    render(<UsagePage />);

    expect(await screen.findByTestId("usage-cap-readout")).toHaveTextContent(
      "$184.00"
    );
    // A bar with no denominator would be an invented number.
    expect(screen.queryByTestId("usage-cap-fill")).not.toBeInTheDocument();
    expect(screen.getByTestId("usage-cap-set")).toHaveTextContent(
      "set a cap →"
    );
  });

  it("PATCHes the generic settings key and re-reads without forcing", async () => {
    const fetchMock = mockFetch(baseReport());
    render(<UsagePage />);

    fireEvent.click(await screen.findByTestId("usage-cap-set"));
    fireEvent.change(screen.getByTestId("usage-cap-input"), {
      target: { value: "250" },
    });
    fireEvent.keyDown(screen.getByTestId("usage-cap-input"), { key: "Enter" });

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ usage_budget_usd_month: 250 }),
      })
    );
    // The re-read is a plain GET: the cap lives in Arij's own database.
    await waitFor(() =>
      expect(fetchMock).toHaveBeenLastCalledWith("/api/usage")
    );
  });

  it("clears the cap with an empty input rather than writing a zero", async () => {
    const fetchMock = mockFetch(
      baseReport(
        makeDashboard({
          cap: { capUsd: 250, spentUsd: 184, usedPercent: 74, alertPercent: 80 },
        })
      )
    );
    render(<UsagePage />);

    fireEvent.click(await screen.findByTestId("usage-cap-readout"));
    fireEvent.change(screen.getByTestId("usage-cap-input"), {
      target: { value: "" },
    });
    fireEvent.keyDown(screen.getByTestId("usage-cap-input"), { key: "Enter" });

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/settings",
        expect.objectContaining({
          body: JSON.stringify({ usage_budget_usd_month: null }),
        })
      )
    );
  });

  it("refuses a non-positive amount inline, without a request", async () => {
    const fetchMock = mockFetch(baseReport());
    render(<UsagePage />);

    fireEvent.click(await screen.findByTestId("usage-cap-set"));
    fireEvent.change(screen.getByTestId("usage-cap-input"), {
      target: { value: "-5" },
    });
    fireEvent.keyDown(screen.getByTestId("usage-cap-input"), { key: "Enter" });

    expect(await screen.findByTestId("usage-cap-message")).toHaveTextContent(
      "The cap must be a positive amount."
    );
    expect(
      fetchMock.mock.calls.some(([, init]) => init?.method === "PATCH")
    ).toBe(false);
  });

  it("keeps the previous cap on screen when the save fails", async () => {
    mockFetch(
      baseReport(
        makeDashboard({
          cap: { capUsd: 250, spentUsd: 184, usedPercent: 74, alertPercent: 80 },
        })
      ),
      { patchOk: false }
    );
    render(<UsagePage />);

    fireEvent.click(await screen.findByTestId("usage-cap-readout"));
    fireEvent.change(screen.getByTestId("usage-cap-input"), {
      target: { value: "900" },
    });
    fireEvent.keyDown(screen.getByTestId("usage-cap-input"), { key: "Enter" });

    expect(await screen.findByTestId("usage-cap-message")).toBeInTheDocument();
    // Still editing, still holding the old cap behind it.
    expect(screen.getByTestId("usage-cap-input")).toBeInTheDocument();
    expect(screen.getByTestId("usage-cap-fill")).toHaveStyle({ width: "74%" });
  });

  it("abandons the edit on Escape", async () => {
    mockFetch(baseReport());
    render(<UsagePage />);

    fireEvent.click(await screen.findByTestId("usage-cap-set"));
    fireEvent.keyDown(screen.getByTestId("usage-cap-input"), { key: "Escape" });

    await waitFor(() =>
      expect(screen.queryByTestId("usage-cap-input")).not.toBeInTheDocument()
    );
    expect(screen.getByTestId("usage-cap-set")).toBeInTheDocument();
  });
});

describe("Usage screen — bands", () => {
  it("collapses an empty band to its label line, with no list element", async () => {
    mockFetch(baseReport(makeDashboard({ byAgent: [] })));
    render(<UsagePage />);

    await screen.findByTestId("usage-band");
    expect(screen.getByText("By agent")).toBeInTheDocument();
    expect(screen.queryByTestId("usage-agent-table")).not.toBeInTheDocument();
    // The other band is untouched.
    expect(screen.getByTestId("usage-project-list")).toBeInTheDocument();
  });

  it("dims the last agent name only once the band is full", async () => {
    const four = makeDashboard().byAgent.concat([
      { key: "c|codex", label: "Security CC", costUsd: 22, sessions: 5, sharePercent: 12 },
      { key: "d|claude-code", label: "Opus Planner", costUsd: 14, sessions: 3, sharePercent: 8 },
    ]);
    mockFetch(baseReport(makeDashboard({ byAgent: four })));
    render(<UsagePage />);

    await screen.findByTestId("usage-agent-table");
    expect(
      screen.getByTestId("usage-agent-row-3").firstElementChild?.className
    ).toContain("text-strata-live-mid");
    expect(
      screen.getByTestId("usage-agent-row-0").firstElementChild?.className
    ).not.toContain("text-strata-live-mid");
  });

  it("drops the night tail from the BY PROJECT footnote when none ran", async () => {
    mockFetch(baseReport());
    render(<UsagePage />);

    await screen.findByTestId("usage-band");
    expect(screen.getByText("night runs included")).toBeInTheDocument();
  });

  it("names yesterday's night batch when it reported a cost", async () => {
    mockFetch(baseReport(makeDashboard({ nightYesterdayUsd: 4.2 })));
    render(<UsagePage />);

    await screen.findByTestId("usage-band");
    expect(
      screen.getByText("night runs included — last night: $4.20")
    ).toBeInTheDocument();
  });
});

describe("Usage screen — BY DAY", () => {
  it("caps a day that carried a failed session", async () => {
    mockFetch(
      baseReport(
        makeDashboard({
          byDay: makeDays({
            "2026-08-17": { sessions: 4, costUsd: 6 },
            "2026-08-18": { sessions: 3, costUsd: 4, failedSessions: 1 },
          }),
        })
      )
    );
    render(<UsagePage />);

    await screen.findByTestId("usage-day-strip");
    expect(screen.getByTestId("usage-day-2026-08-18-fail")).toBeInTheDocument();
    expect(
      screen.queryByTestId("usage-day-2026-08-17-fail")
    ).not.toBeInTheDocument();
  });

  it("carries the day's own tooltip, failures included", async () => {
    mockFetch(
      baseReport(
        makeDashboard({
          byDay: makeDays({
            "2026-08-18": { sessions: 3, costUsd: 4, failedSessions: 2 },
          }),
        })
      )
    );
    render(<UsagePage />);

    expect(await screen.findByTestId("usage-day-2026-08-18")).toHaveAttribute(
      "title",
      "2026-08-18 · 3 sessions · $4.00 · 2 failed"
    );
  });

  it("says how many days the strip covers", async () => {
    mockFetch(baseReport());
    render(<UsagePage />);

    await screen.findByTestId("usage-day-strip");
    expect(screen.getByText(/30 days/)).toBeInTheDocument();
    expect(screen.getByText("red = failed sessions")).toBeInTheDocument();
  });
});
