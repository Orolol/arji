/**
 * The turquoise stratum: live session cards, the QUEUED tile and the TODAY
 * roll-up.
 *
 * Replaces the card-level coverage the deleted `epic-card-*` files carried for
 * live agents: the agent/provider meta line, the ticket chip, the elapsed
 * numeral and the fact that "alive" is motion and a word, never a colour.
 */

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { WorkingBand } from "@/components/desk/WorkingBand";
import { deriveProjects } from "@/lib/control-desk/aggregate";
import type {
  DeskQueuedSession,
  DeskToday,
  DeskWorkingSession,
} from "@/lib/control-desk/types";

const projects = deriveProjects([
  { id: "p1", name: "Arij", createdAt: "2026-01-01" },
  { id: "p2", name: "Ledger", createdAt: "2026-01-02" },
]);
const projectsById = new Map(projects.map((p) => [p.id, p]));

const EMPTY_TODAY: DeskToday = {
  ticketsShipped: null,
  failedSessions: null,
  costUsd: null,
  projects: null,
  sessions: null,
};

function live(overrides: Partial<DeskWorkingSession> = {}): DeskWorkingSession {
  return {
    sessionId: "s1",
    projectId: "p1",
    epicId: "e1",
    readableId: "ARJ-122",
    title: "Streaming session logs over SSE",
    taskType: "BUILD",
    agentName: "Opus Builder",
    startedAt: new Date(Date.now() - 252_000).toISOString(),
    lastLogLine: "editing lib/sse/stream.ts (+142 −18)",
    nightRun: false,
    stale: false,
    ...overrides,
  };
}

function queued(overrides: Partial<DeskQueuedSession> = {}): DeskQueuedSession {
  return {
    sessionId: "q1",
    projectId: "p1",
    epicId: "e9",
    readableId: "ARJ-131",
    title: "Inline review findings",
    ...overrides,
  };
}

function renderBand(props: Partial<React.ComponentProps<typeof WorkingBand>> = {}) {
  return render(
    <WorkingBand
      working={[]}
      queued={[]}
      today={EMPTY_TODAY}
      projectsById={projectsById}
      {...props}
    />,
  );
}

describe("WORKING band header", () => {
  it("counts agents and queued work", () => {
    renderBand({ working: [live()], queued: [queued()] });
    expect(screen.getByText("1 agent · 1 queued")).toBeInTheDocument();
  });

  it("pluralises the agent count", () => {
    renderBand({ working: [live(), live({ sessionId: "s2" })] });
    expect(screen.getByText("2 agents · 0 queued")).toBeInTheDocument();
  });

  it("omits the night-run line entirely — no wave data exists to show", () => {
    // Night runs live in a per-project in-process registry, lost on restart and
    // never aggregated. The documented fallback is to omit the slot, not to
    // invent a wave number.
    renderBand({ working: [live({ nightRun: true })] });
    expect(screen.queryByText(/wave/i)).not.toBeInTheDocument();
  });
});

describe("LiveSessionCard", () => {
  it("shows the project chip, the task word and the id · agent meta", () => {
    renderBand({ working: [live()] });
    expect(screen.getByText("ARIJ")).toBeInTheDocument();
    expect(screen.getByText("BUILD")).toBeInTheDocument();
    expect(screen.getByText("ARJ-122 · Opus Builder")).toBeInTheDocument();
  });

  it("prefixes the last log line with U+203A", () => {
    renderBand({ working: [live()] });
    expect(
      screen.getByText("› editing lib/sse/stream.ts (+142 −18)"),
    ).toBeInTheDocument();
  });

  it("renders the compact chrono, not the legacy '4m 12s' form", () => {
    renderBand({ working: [live()] });
    expect(screen.getByText("4m12")).toBeInTheDocument();
  });

  it("tags a night-run session without claiming a wave number", () => {
    renderBand({ working: [live({ nightRun: true })] });
    expect(screen.getByTestId("desk-night-tag")).toHaveTextContent("NIGHT");
    expect(screen.getByTestId("desk-night-tag")).not.toHaveTextContent("/");
  });

  it("says STALLED in a word when the watchdog flags the session", () => {
    // State is icon + word + motion, never a colour swap on the card.
    renderBand({ working: [live({ stale: true })] });
    expect(screen.getByText("STALLED")).toBeInTheDocument();
  });

  it("opens the ticket from the title and stops the session from the icon", () => {
    const onOpenTicket = vi.fn();
    const onStopSession = vi.fn();
    renderBand({ working: [live()], onOpenTicket, onStopSession });

    fireEvent.click(screen.getByText("Streaming session logs over SSE"));
    expect(onOpenTicket).toHaveBeenCalledWith("e1");

    fireEvent.click(screen.getByTestId("desk-stop-session"));
    expect(onStopSession).toHaveBeenCalledWith("s1");
  });

  it("keeps the progress bar indeterminate — nothing computes a percentage", () => {
    const { container } = renderBand({ working: [live()] });
    const track = container.querySelector('[data-slot="progress-track"]');
    expect(track).toHaveAttribute("data-indeterminate");
  });
});

describe("QUEUED tile", () => {
  it("labels itself with the count and lists the rows", () => {
    renderBand({ queued: [queued()] });
    const tile = screen.getByTestId("desk-queued-tile");
    expect(tile).toHaveTextContent("QUEUED · 1");
    expect(tile).toHaveTextContent("Inline review findings");
  });

  it("collapses the overflow past three rows", () => {
    renderBand({
      queued: [
        queued({ sessionId: "q1" }),
        queued({ sessionId: "q2" }),
        queued({ sessionId: "q3" }),
        queued({ sessionId: "q4" }),
        queued({ sessionId: "q5" }),
      ],
    });
    const tile = screen.getByTestId("desk-queued-tile");
    expect(tile).toHaveTextContent("QUEUED · 5");
    expect(tile).toHaveTextContent("+2");
  });

  it("stays on screen with nothing queued", () => {
    renderBand();
    expect(screen.getByTestId("desk-queued-tile")).toHaveTextContent("QUEUED · 0");
  });
});

describe("TODAY tile", () => {
  it("renders an em-dash for every figure the database cannot answer", () => {
    renderBand();
    expect(screen.getByTestId("desk-today-landed")).toHaveTextContent("—");
    expect(screen.getByTestId("desk-today-failed")).toHaveTextContent("—");
    expect(screen.getByTestId("desk-today-tile")).toHaveTextContent(
      "— · — projets · — sessions",
    );
  });

  it("renders the real figures when they exist", () => {
    renderBand({
      today: {
        ticketsShipped: 7,
        failedSessions: 1,
        costUsd: 11.4,
        projects: 3,
        sessions: 14,
      },
    });
    expect(screen.getByTestId("desk-today-landed")).toHaveTextContent("7");
    expect(screen.getByTestId("desk-today-failed")).toHaveTextContent("1");
    expect(screen.getByTestId("desk-today-tile")).toHaveTextContent(
      "$11.40 · 3 projets · 14 sessions",
    );
  });

  it("agrees in the French singular", () => {
    renderBand({
      today: { ticketsShipped: 1, failedSessions: 0, costUsd: 1, projects: 1, sessions: 1 },
    });
    expect(screen.getByTestId("desk-today-tile")).toHaveTextContent(
      "$1.00 · 1 projet · 1 session",
    );
  });

  it("prints a real zero as zero", () => {
    renderBand({ today: { ...EMPTY_TODAY, ticketsShipped: 0 } });
    expect(screen.getByTestId("desk-today-landed")).toHaveTextContent("0");
  });
});
