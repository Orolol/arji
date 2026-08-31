/**
 * The four strata have to share the column honestly.
 *
 * YOUR TURN used to spread one or two rows across 40vh with `justify-around`,
 * and the READY TO LAND / UP NEXT grid under it was `shrink-0` with no floor —
 * so a single question could squash the two bands the user actually acts on.
 *
 * The invariant these tests protect is the one written in StrataBand's own
 * doc comment: EXACTLY ONE band per screen grows, and on the desk that band is
 * WORKING. Giving the grid a floor must not turn it into a second one.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

import { NowDesk } from "@/components/desk/NowDesk";
import type { ControlDeskPayload } from "@/lib/control-desk/types";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

vi.mock("@/hooks/useNamedAgentsList", () => ({
  useNamedAgentsList: () => ({ agents: [], loading: false, refresh: vi.fn() }),
}));

function payload(overrides: Partial<ControlDeskPayload> = {}): ControlDeskPayload {
  return {
    generatedAt: "2026-08-28T09:00:00.000Z",
    projects: [
      {
        id: "p1",
        name: "Arij",
        shortName: "ARIJ",
        colorIndex: 0,
        activeAgents: 0,
        autoModeEnabled: false,
      },
    ],
    working: [],
    queued: [],
    today: {
      ticketsShipped: 0,
      failedSessions: 0,
      costUsd: 0,
      projects: 1,
      sessions: 0,
    },
    yourTurn: { awaitingReply: [], failed: [], conflicts: [] },
    readyToLand: [],
    heldBackCount: 0,
      upNext: [],
    ...overrides,
  };
}

function asks(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    epicId: `e-${i}`,
    projectId: "p1",
    readableId: `ARJ-${i}`,
    title: `Ticket ${i}`,
    question: "On garde le flag ?",
    author: "agent",
    askedAt: "2026-08-28T09:00:00.000Z",
    unreadAi: false,
  }));
}

async function renderDesk(data: ControlDeskPayload) {
  global.fetch = vi.fn(async (url: string) =>
    url === "/api/control-desk"
      ? { ok: true, status: 200, json: async () => ({ data }) }
      : { ok: true, status: 200, json: async () => ({ data: {} }) },
  ) as unknown as typeof fetch;

  const result = render(<NowDesk />);
  await waitFor(() => expect(screen.getByText("Your turn")).toBeInTheDocument());
  return result;
}

/** The Ready-to-land / Up-next row, found by the two bands it wraps. */
function landGrid(): HTMLElement {
  const land = document.querySelector('[data-stratum="land"]');
  expect(land).toBeTruthy();
  return land!.parentElement as HTMLElement;
}

describe("desk strata balance", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("gives the Ready/Up next grid a floor without letting it grow", async () => {
    await renderDesk(payload());
    const grid = landGrid();
    expect(grid.className).toContain("min-h-[168px]");
    expect(grid.className).toContain("shrink-0");
    expect(grid.className).not.toContain("flex-1");
  });

  it("keeps the floor under a crowded Your turn", async () => {
    await renderDesk(payload({ yourTurn: { awaitingReply: asks(6), failed: [], conflicts: [] } }));
    expect(landGrid().className).toContain("min-h-[168px]");
    // The overflow marker itself is measured from the scroll container, so it
    // needs a real layout; jsdom has none. Its count is pinned against a
    // stubbed fold in desk-your-turn.test.tsx ("overflow marker") instead —
    // what matters here is that a crowded coral band never eats the floor.
  });

  it("leaves WORKING as the desk's only growing band, whatever Your turn holds", async () => {
    for (const rows of [0, 1, 6]) {
      const { unmount } = await renderDesk(
        payload({ yourTurn: { awaitingReply: asks(rows), failed: [], conflicts: [] } }),
      );
      const growing = [...document.querySelectorAll('[data-slot="strata-band"]')].filter((b) =>
        b.className.includes("flex-1"),
      );
      expect(growing, `${rows} row(s) in Your turn`).toHaveLength(1);
      expect(growing[0].getAttribute("data-stratum")).toBe("live");
      unmount();
    }
  });
});
