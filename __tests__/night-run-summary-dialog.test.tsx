/**
 * The morning surface: NightRunSummaryDialog rendering matrix (clean run,
 * circuit-breaker trip, cost-cap trip, user stop, restart-interrupted run),
 * the in-run "Stop night run" control, plus the pure formatters it shares
 * with the monitor chip.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NightRunSummaryDialog } from "@/components/night/NightRunSummaryDialog";
import {
  NIGHT_RUN_STATUS_LABEL_KEYS,
  formatNightRunCost,
  formatNightRunCounts,
  formatNightRunDuration,
  nightRunAbortKind,
  nightRunAbortSentence,
  type NightRunAbortCopy,
  type NightRunCountsCopy,
} from "@/components/night/night-run-format";
import { catalogueValue } from "@/lib/i18n/catalogue";
import { translatorFor } from "@/lib/i18n/translator";
import type { NightRunDetail } from "@/lib/night/constants";
import type { TicketExecutionStatus } from "@/lib/dependencies/scheduler";

// The formatters compose, they do not word: the phrases come resolved from
// the caller, exactly as NightRunSummaryDialog supplies them. The status table
// holds full dotted paths, so it resolves outside a namespace.
const t = translatorFor("en", "NightRuns");
const countsCopy: NightRunCountsCopy = {
  bucket: (count, label) => t("counts.bucket", { count, label }),
  statusLabel: (status) =>
    catalogueValue("en", NIGHT_RUN_STATUS_LABEL_KEYS[status]),
  none: t("counts.none"),
};
const abortCopy: NightRunAbortCopy = {
  stopped: (wave) =>
    wave == null ? t("abort.stopped") : t("abort.stoppedAtWave", { wave }),
  other: (reason, wave) =>
    wave == null
      ? t("abort.other", { reason })
      : t("abort.otherAtWave", { reason, wave }),
};

function counts(
  partial: Partial<Record<TicketExecutionStatus, number>>
): Record<TicketExecutionStatus, number> {
  return {
    pending: 0,
    running: 0,
    done: 0,
    asked: 0,
    failed: 0,
    skipped: 0,
    ...partial,
  };
}

function detail(overrides: Partial<NightRunDetail> = {}): NightRunDetail {
  return {
    runId: "night_abc",
    projectId: "proj-1",
    source: "registry",
    interrupted: false,
    state: "finished",
    startedAt: "2026-08-17T22:00:00.000Z",
    endedAt: "2026-08-18T04:30:00.000Z",
    failurePolicy: "halt",
    totalWaves: 3,
    currentWave: 3,
    counts: counts({ done: 5 }),
    epics: [],
    stopRequested: false,
    totalCostUsd: 4.2,
    costIsPartial: false,
    abortReason: null,
    abortedAtWave: null,
    breakerThreshold: 3,
    costCapUsd: null,
    ...overrides,
  };
}

function mockDetail(payload: NightRunDetail | { error: string }, ok = true) {
  const fetchMock = vi.fn(async () => ({
    ok,
    status: ok ? 200 : 404,
    json: async () => ("error" in payload ? payload : { data: payload }),
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderSummary() {
  render(
    <NightRunSummaryDialog
      projectId="proj-1"
      runId="night_abc"
      open
      onOpenChange={vi.fn()}
    />
  );
}

describe("NightRunSummaryDialog", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("renders a clean run: outcome headline, duration and cost", async () => {
    mockDetail(detail());
    renderSummary();

    await waitFor(() =>
      expect(screen.getByTestId("night-summary-counts")).toHaveTextContent(
        "5 to merge"
      )
    );
    expect(screen.getByTestId("night-summary-duration")).toHaveTextContent(
      "6h 30m"
    );
    expect(screen.getByTestId("night-summary-cost")).toHaveTextContent(
      "$4.20"
    );
    expect(screen.getByTestId("night-summary-waves")).toHaveTextContent(
      "Wave 3/3"
    );
    expect(screen.queryByTestId("night-summary-abort")).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("night-summary-interrupted")
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("night-summary-cost-caveat")
    ).not.toBeInTheDocument();
  });

  it("breaks the outcome into the four morning tiles", async () => {
    mockDetail(
      detail({ counts: counts({ done: 5, asked: 1, failed: 2, skipped: 1 }) })
    );
    renderSummary();

    // Labels come from NIGHT_RUN_STATUS_LABELS, one tile each.
    await waitFor(() =>
      expect(screen.getByText("to merge")).toBeInTheDocument()
    );
    expect(screen.getByText("paused")).toBeInTheDocument();
    expect(screen.getByText("failed")).toBeInTheDocument();
    expect(screen.getByText("skipped")).toBeInTheDocument();
    expect(screen.getByText("5")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
  });

  it("offers the morning follow-ups: sessions and the board", async () => {
    mockDetail(detail());
    renderSummary();

    await waitFor(() =>
      expect(screen.getByText("Open sessions")).toBeInTheDocument()
    );
    expect(screen.getByText("Open sessions").closest("a")).toHaveAttribute(
      "href",
      "/projects/proj-1/sessions"
    );
    expect(screen.getByText("Review on the board").closest("a")).toHaveAttribute(
      "href",
      "/projects/proj-1"
    );
  });

  it("explains a circuit-breaker trip and the wave it stopped at", async () => {
    mockDetail(
      detail({
        counts: counts({ done: 1, failed: 3, skipped: 4 }),
        abortReason: "circuit breaker: 3 consecutive pipeline failures",
        abortedAtWave: 2,
      })
    );
    renderSummary();

    const banner = await screen.findByTestId("night-summary-abort");
    expect(banner).toHaveAttribute("data-abort-kind", "breaker");
    expect(banner).toHaveTextContent(
      "circuit breaker: 3 consecutive pipeline failures"
    );
    expect(banner).toHaveTextContent("after wave 2");
    expect(screen.getByTestId("night-summary-counts")).toHaveTextContent(
      "1 to merge, 3 failed, 4 skipped"
    );
  });

  it("explains a cost-cap trip and marks the total as a lower bound", async () => {
    mockDetail(
      detail({
        counts: counts({ done: 2, skipped: 6 }),
        abortReason: "cost cap reached: $20.10 of $20",
        abortedAtWave: 1,
        totalCostUsd: 20.1,
        costIsPartial: true,
        costCapUsd: 20,
      })
    );
    renderSummary();

    const banner = await screen.findByTestId("night-summary-abort");
    expect(banner).toHaveAttribute("data-abort-kind", "cost");
    expect(screen.getByTestId("night-summary-cost")).toHaveTextContent(
      "≥$20.10"
    );
    expect(
      screen.getByTestId("night-summary-cost-caveat")
    ).toBeInTheDocument();
  });

  it("flags a run rebuilt from the database after a restart", async () => {
    mockDetail(
      detail({
        source: "db",
        interrupted: true,
        failurePolicy: null,
        totalWaves: null,
        currentWave: null,
        breakerThreshold: null,
        counts: counts({ done: 2, failed: 1 }),
      })
    );
    renderSummary();

    await waitFor(() =>
      expect(
        screen.getByTestId("night-summary-interrupted")
      ).toHaveTextContent(/Interrupted by a server restart — partial data/)
    );
    expect(screen.queryByTestId("night-summary-waves")).not.toBeInTheDocument();
  });

  it("links each epic to its ticket and shows skip reasons", async () => {
    mockDetail(
      detail({
        counts: counts({ done: 1, failed: 1, asked: 1, skipped: 1 }),
        epics: [
          {
            epicId: "e1",
            readableId: "ARJ-1",
            title: "Landing page",
            status: "done",
            reason: null,
            pipelineRunId: "pipe-1",
            sessionIds: ["s1", "s2"],
            costUsd: 1.5,
          },
          {
            epicId: "e2",
            readableId: "ARJ-2",
            title: "Payments",
            status: "failed",
            reason: "pipeline failed",
            pipelineRunId: "pipe-2",
            sessionIds: ["s3"],
            costUsd: 2.7,
          },
          {
            epicId: "e3",
            readableId: "ARJ-3",
            title: "Checkout",
            status: "asked",
            reason: null,
            pipelineRunId: "pipe-3",
            sessionIds: ["s4"],
            costUsd: null,
          },
          {
            epicId: "e4",
            readableId: "ARJ-4",
            title: "Receipts",
            status: "skipped",
            reason: "skipped: dependency ARJ-2 failed",
            pipelineRunId: null,
            sessionIds: [],
            costUsd: null,
          },
        ],
      })
    );
    renderSummary();

    const failedRow = await screen.findByTestId("night-epic-e2");
    expect(failedRow).toHaveTextContent("failed");
    expect(failedRow.querySelector("a")).toHaveAttribute(
      "href",
      "/projects/proj-1?ticket=e2"
    );
    expect(failedRow).toHaveTextContent("$2.70");

    expect(screen.getByTestId("night-epic-e3")).toHaveTextContent("paused");
    expect(screen.getByTestId("night-epic-e3").querySelector("a")).toHaveAttribute(
      "href",
      "/projects/proj-1?ticket=e3"
    );
    expect(screen.getByTestId("night-epic-e4")).toHaveTextContent(
      "skipped: dependency ARJ-2 failed"
    );
    expect(screen.getByTestId("night-epic-e1")).toHaveTextContent("to merge");
  });

  it("hides the stop control for a run that already finished", async () => {
    mockDetail(detail());
    renderSummary();

    await waitFor(() =>
      expect(screen.getByTestId("night-summary-counts")).toBeInTheDocument()
    );
    expect(
      screen.queryByTestId("night-run-stop-button")
    ).not.toBeInTheDocument();
  });

  it("hides the stop control for a restart-interrupted run (no engine left)", async () => {
    mockDetail(detail({ source: "db", interrupted: true, state: "running" }));
    renderSummary();

    await waitFor(() =>
      expect(
        screen.getByTestId("night-summary-interrupted")
      ).toBeInTheDocument()
    );
    expect(
      screen.queryByTestId("night-run-stop-button")
    ).not.toBeInTheDocument();
  });

  it("stops a running run: POSTs the stop route, then shows 'Stopping…'", async () => {
    const requests: Array<{ url: string; method?: string }> = [];
    let stopped = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: { method?: string }) => {
        requests.push({ url, method: init?.method });
        if (init?.method === "POST") {
          stopped = true;
          return {
            ok: true,
            status: 200,
            json: async () => ({ data: { stopping: true } }),
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: detail({
              state: "running",
              endedAt: null,
              counts: counts({ done: 1, running: 2, pending: 3 }),
              stopRequested: stopped,
            }),
          }),
        };
      })
    );
    renderSummary();

    const button = await screen.findByTestId("night-run-stop-button");
    expect(button).toHaveTextContent("Stop night run");
    expect(button).not.toBeDisabled();

    await userEvent.click(button);

    await waitFor(() =>
      expect(
        requests.some(
          (req) =>
            req.method === "POST" &&
            req.url ===
              "/api/projects/proj-1/build/night-runs/night_abc/stop"
        )
      ).toBe(true)
    );

    // The button latches: no double stop, and the state is legible.
    await waitFor(() =>
      expect(screen.getByTestId("night-run-stop-button")).toHaveTextContent(
        "Stopping…"
      )
    );
    expect(screen.getByTestId("night-run-stop-button")).toBeDisabled();
    expect(screen.getByTestId("night-summary-stopping")).toHaveTextContent(
      /no new epic will be launched/i
    );
  });

  it("shows 'Stopping…' from the server flag alone (dialog reopened mid-stop)", async () => {
    mockDetail(
      detail({ state: "running", endedAt: null, stopRequested: true })
    );
    renderSummary();

    await waitFor(() =>
      expect(screen.getByTestId("night-run-stop-button")).toHaveTextContent(
        "Stopping…"
      )
    );
    expect(screen.getByTestId("night-run-stop-button")).toBeDisabled();
  });

  it("reports a user stop in its own neutral variant, not as an incident", async () => {
    mockDetail(
      detail({
        counts: counts({ done: 2, skipped: 4 }),
        abortReason: "stopped by user",
        abortedAtWave: 2,
      })
    );
    renderSummary();

    const banner = await screen.findByTestId("night-summary-abort");
    expect(banner).toHaveAttribute("data-abort-kind", "stopped");
    expect(banner).toHaveTextContent("You stopped this run (after wave 2)");
    expect(banner).toHaveTextContent(/left to finish/);
    // Not the breaker/cost wording.
    expect(banner).not.toHaveTextContent("Run stopped early");
    // A finished run offers no stop control anymore.
    expect(
      screen.queryByTestId("night-run-stop-button")
    ).not.toBeInTheDocument();
  });

  it("surfaces a missing run instead of rendering an empty shell", async () => {
    mockDetail({ error: "Night run not found" }, false);
    renderSummary();

    await waitFor(() =>
      expect(screen.getByTestId("night-summary-error")).toHaveTextContent(
        "Night run not found"
      )
    );
  });
});

describe("night-run formatters", () => {
  it("omits empty buckets and words outcomes for a human", () => {
    expect(
      formatNightRunCounts(
        counts({ done: 5, asked: 1, failed: 2, skipped: 1 }),
        countsCopy
      )
    ).toBe("5 to merge, 1 paused, 2 failed, 1 skipped");
    expect(formatNightRunCounts(counts({ done: 3 }), countsCopy)).toBe(
      "3 to merge"
    );
    expect(formatNightRunCounts(counts({}), countsCopy)).toBe("no epics");
    expect(formatNightRunCounts(null, countsCopy)).toBe("no epics");
  });

  it("prefixes a partial cost with ≥ and hides a zero total", () => {
    expect(formatNightRunCost(4.2, false)).toBe("$4.20");
    expect(formatNightRunCost(4.2, true)).toBe("≥$4.20");
    expect(formatNightRunCost(0, true)).toBeNull();
    expect(formatNightRunCost(null, false)).toBeNull();
  });

  it("measures the run against its end, not the clock", () => {
    expect(
      formatNightRunDuration(
        "2026-08-17T22:00:00.000Z",
        "2026-08-17T23:15:00.000Z"
      )
    ).toBe("1h 15m");
    expect(formatNightRunDuration(null, null)).toBe("—");
  });

  it("classifies abort reasons for styling", () => {
    expect(nightRunAbortKind("circuit breaker: 3 consecutive pipeline failures")).toBe(
      "breaker"
    );
    expect(nightRunAbortKind("cost cap reached: $20.10 of $20")).toBe("cost");
    // The engine's user-stop reason is its own kind, not "other".
    expect(nightRunAbortKind("stopped by user")).toBe("stopped");
    expect(nightRunAbortKind("something else entirely")).toBe("other");
    expect(nightRunAbortKind(null)).toBeNull();
  });

  it("words a user stop as a decision and an abort as an incident", () => {
    expect(nightRunAbortSentence("stopped by user", 2, abortCopy)).toBe(
      "You stopped this run (after wave 2). Epics already running were left to finish; the rest were skipped."
    );
    expect(
      nightRunAbortSentence("cost cap reached: $20.10 of $20", 1, abortCopy)
    ).toBe(
      "Run stopped early: cost cap reached: $20.10 of $20 (after wave 1). Remaining epics were skipped."
    );
    // No wave number known (aborted before the first launch).
    expect(nightRunAbortSentence("stopped by user", null, abortCopy)).toBe(
      "You stopped this run. Epics already running were left to finish; the rest were skipped."
    );
    expect(nightRunAbortSentence(null, 3, abortCopy)).toBeNull();
  });
});
