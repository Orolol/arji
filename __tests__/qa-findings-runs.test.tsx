/**
 * The turquoise stratum of frame 11b: review passes in flight, the queued tile,
 * and the empty stratum that folds to its label line.
 */

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { QaRunsBand } from "@/components/qa/QaRunsBand";
import { deriveProjects } from "@/lib/control-desk/aggregate";
import type { QaQueuedRun, QaRun } from "@/lib/qa/types";

const projects = deriveProjects([
  { id: "p1", name: "Arij", createdAt: "2026-01-01" },
]);
const projectsById = new Map(projects.map((p) => [p.id, p]));

function run(overrides: Partial<QaRun> = {}): QaRun {
  return {
    sessionId: "s1",
    projectId: "p1",
    epicId: "e1",
    readableId: "ARJ-113",
    title: "Named agents: per-task defaults",
    agentName: "Security CC",
    startedAt: new Date(Date.now() - 47_000).toISOString(),
    lastLine: "checking migration rollback",
    findingsFiled: null,
    blockingFiled: null,
    ...overrides,
  };
}

function queued(overrides: Partial<QaQueuedRun> = {}): QaQueuedRun {
  return {
    sessionId: "q1",
    projectId: "p1",
    epicId: "e9",
    readableId: "ARJ-122",
    title: "Streaming session logs — après le build",
    ...overrides,
  };
}

function renderBand(
  props: Partial<React.ComponentProps<typeof QaRunsBand>> = {},
) {
  return render(
    <QaRunsBand runs={[]} queued={[]} projectsById={projectsById} {...props} />,
  );
}

describe("QaRunsBand", () => {
  it("folds to its label line with nothing live and nothing queued", () => {
    renderBand();
    expect(screen.getByText("QA runs")).toBeInTheDocument();
    expect(screen.getByText("0 live · 0 queued")).toBeInTheDocument();
    expect(screen.queryByTestId("qa-runs-grid")).toBeNull();
    expect(screen.queryByTestId("qa-run-card")).toBeNull();
    expect(screen.queryByTestId("qa-queued-tile")).toBeNull();
  });

  it("omits the queued tile when there is nothing queued", () => {
    renderBand({ runs: [run()] });
    expect(screen.getByTestId("qa-run-card")).toBeInTheDocument();
    expect(screen.queryByTestId("qa-queued-tile")).toBeNull();
  });

  it("shows the queued tile, with its count, when the scheduler is holding one", () => {
    renderBand({ runs: [run()], queued: [queued()] });
    const tile = screen.getByTestId("qa-queued-tile");
    expect(tile).toBeInTheDocument();
    expect(screen.getByText("QUEUED · 1")).toBeInTheDocument();
    expect(screen.getByText("1 live · 1 queued")).toBeInTheDocument();
  });

  it("prefers the filing count over the log line", () => {
    renderBand({ runs: [run({ findingsFiled: 2, blockingFiled: 1 })] });
    expect(screen.getByText("› 2 findings filed, 1 blocking")).toBeInTheDocument();
    expect(screen.queryByText("› checking migration rollback")).toBeNull();
  });

  it("falls back to the clipped log line, then to an ellipsis", () => {
    const { unmount } = renderBand({ runs: [run()] });
    expect(screen.getByText("› checking migration rollback")).toBeInTheDocument();
    unmount();

    renderBand({ runs: [run({ lastLine: null })] });
    expect(screen.getByText("› …")).toBeInTheDocument();
  });

  it("tells 'alive' with a ticking chrono and an indeterminate track, never a colour", () => {
    renderBand({ runs: [run()] });
    const card = screen.getByTestId("qa-run-card");
    expect(card.querySelector('[data-slot="chrono"]')?.textContent).toMatch(/\d+s$/);
    const track = card.querySelector('[data-slot="progress-track"]');
    // Nothing emits per-session progress, so the bar crawls rather than lying.
    expect(track).toHaveAttribute("data-indeterminate");
    expect(screen.getByText("REVIEW")).toBeInTheDocument();
  });

  it("prints an em-dash for a run with no agent name", () => {
    renderBand({ runs: [run({ agentName: null })] });
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it("opens the ticket and stops the session", () => {
    const onOpenTicket = vi.fn();
    const onStopRun = vi.fn();
    renderBand({ runs: [run()], onOpenTicket, onStopRun });

    fireEvent.click(screen.getByText("Named agents: per-task defaults"));
    expect(onOpenTicket).toHaveBeenCalledWith("e1");

    fireEvent.click(screen.getByTestId("qa-run-stop"));
    expect(onStopRun).toHaveBeenCalledWith("s1");
  });
});
