/**
 * THE EM-DASH-NOT-ZERO INVARIANT, on both halves of the roster's numbers.
 *
 * "Unavailable numerals are em-dashes, never zeros" is only worth stating
 * because the natural implementation breaks it: `stats?.runsToday ?? 0` reads
 * identically whether the agent ran nothing today or the aggregate never came
 * back, and a `0` in the second case is a figure no server ever gave.
 *
 * So the hook has to distinguish the two — including on the failure mode that
 * throws nothing at all, a 500 whose `{ error }` body parses perfectly well —
 * and the card has to honour the distinction.
 *
 * The unsaved marker is pinned here too: it is the same card, and the rule it
 * breaks is the neighbouring one (colour is stratum or identity, never state).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, renderHook, screen, waitFor } from "@testing-library/react";

import { AgentRosterCard } from "@/components/agents-workshop/AgentRosterCard";
import {
  useAgentRosterStats,
  type AgentDayStats,
  type AgentRosterStatsStatus,
  type NamedAgent,
} from "@/hooks/useAgentConfig";

const EM_DASH = "—";

const AGENT: NamedAgent = {
  id: "agent-1",
  name: "Opus Builder",
  provider: "claude-code",
  model: "claude-opus-5",
  options: {},
  personaPrompt: null,
  kind: "simple",
  members: [],
  isDefault: false,
  createdAt: null,
};

const BUSY_DAY: AgentDayStats = {
  namedAgentId: "agent-1",
  runsToday: 7,
  cleanRate: 0.5,
  costTodayUsd: 1.5,
  liveSessions: 2,
};

function renderCard(
  statsStatus: AgentRosterStatsStatus,
  stats?: AgentDayStats,
  dirty = false,
) {
  return render(
    <AgentRosterCard
      agent={AGENT}
      selected={false}
      dirty={dirty}
      stats={stats}
      statsStatus={statsStatus}
      onSelect={() => {}}
    />,
  );
}

/**
 * The three figures, in card order: runs, clean, cost. Read off the mono runs
 * so the assertion sees exactly what is printed, em-dash included — the
 * "provider · model" line is mono too and is dropped by the middot.
 */
function figures(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('[data-slot="mono"]'))
    .map((element) => element.textContent ?? "")
    .filter((text) => !text.includes("·"));
}

describe("AgentRosterCard figures", () => {
  it("prints a truthful 0 when the aggregate answered and this agent is absent", () => {
    // The aggregate is bounded to today plus anything running, so an agent
    // that has not run today has NO row. That absence is knowledge, not a gap.
    const { container } = renderCard("ready", undefined);

    expect(figures(container)).toEqual(["0", EM_DASH, EM_DASH]);
  });

  it("prints em-dashes, never a 0, when the aggregate failed", () => {
    const { container } = renderCard("unavailable", undefined);

    expect(figures(container)).toEqual([EM_DASH, EM_DASH, EM_DASH]);
  });

  it("prints em-dashes while the first aggregate is still in flight", () => {
    const { container } = renderCard("loading", undefined);

    expect(figures(container)).toEqual([EM_DASH, EM_DASH, EM_DASH]);
  });

  it("prints the real figures once they arrive", () => {
    const { container } = renderCard("ready", BUSY_DAY);

    expect(figures(container)).toEqual(["7", "50%", "$1.50"]);
    expect(screen.getByTitle("2 sessions live")).toBeInTheDocument();
  });

  it("drops the live dot when the aggregate is unavailable", () => {
    // A breathing dot is a claim about right now. Left standing on a stale
    // row it says "running" about a server that answered nothing.
    const { container } = renderCard("unavailable", BUSY_DAY);

    expect(screen.queryByTitle("2 sessions live")).not.toBeInTheDocument();
    expect(figures(container)).toEqual([EM_DASH, EM_DASH, EM_DASH]);
  });
});

describe("AgentRosterCard unsaved marker", () => {
  it("carries dirty as a word and spends no colour on it", () => {
    const { container } = renderCard("ready", BUSY_DAY, false);
    expect(screen.queryByText("unsaved")).not.toBeInTheDocument();
    expect(container.querySelector(".bg-action")).toBeNull();
  });

  it("shows the word when dirty, without relabelling the card", () => {
    const { container } = renderCard("ready", BUSY_DAY, true);

    expect(screen.getByText("unsaved")).toBeInTheDocument();
    // The old marker was a --action dot: the filled-button green spent on a
    // boolean, on a screen capped at two loud colours.
    expect(container.querySelector(".bg-action")).toBeNull();
    // The card is still found by the SAVED name — the marker is not part of
    // the accessible name.
    expect(
      screen.getByRole("button", { name: "Opus Builder" }),
    ).toBeInTheDocument();
  });
});

describe("useAgentRosterStats", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const fetchMock = () => vi.mocked(globalThis.fetch);

  function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }

  it("keys the rows by agent id and reports ready", async () => {
    fetchMock().mockResolvedValue(json({ data: { agents: [BUSY_DAY] } }));

    const { result } = renderHook(() => useAgentRosterStats());

    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.data["agent-1"]).toEqual(BUSY_DAY);
  });

  it("reports unavailable when the request rejects", async () => {
    fetchMock().mockRejectedValue(new Error("offline"));

    const { result } = renderHook(() => useAgentRosterStats());

    await waitFor(() => expect(result.current.status).toBe("unavailable"));
    expect(result.current.data).toEqual({});
  });

  it("reports unavailable on a 500 whose error body parses cleanly", async () => {
    // The route answers `{ error }` with a 500. Reading `json.data.agents` off
    // that yields undefined, and the old `?? []` turned it into "no agent ran
    // today" — a silent, wrong, zero that never touched the catch block.
    fetchMock().mockResolvedValue(json({ error: "no such table" }, 500));

    const { result } = renderHook(() => useAgentRosterStats());

    await waitFor(() => expect(result.current.status).toBe("unavailable"));
    expect(result.current.data).toEqual({});
  });

  it("reports unavailable on a 200 whose payload has no agents array", async () => {
    fetchMock().mockResolvedValue(json({ data: {} }));

    const { result } = renderHook(() => useAgentRosterStats());

    await waitFor(() => expect(result.current.status).toBe("unavailable"));
  });

  it("clears the previous rows when a later poll fails", async () => {
    fetchMock()
      .mockResolvedValueOnce(json({ data: { agents: [BUSY_DAY] } }))
      .mockRejectedValue(new Error("offline"));

    const { result } = renderHook(() => useAgentRosterStats());
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.status).toBe("unavailable");
    expect(result.current.data).toEqual({});
  });
});
