/**
 * The FilterBar COMPONENT is gone with the kanban board. Its pure half moved
 * to lib/kanban/filters.ts, unchanged, and is still the only definition of
 * "does this ticket survive the active filters" plus the parser for the
 * `arij.kanban-board.filters.<projectId>` payload the desk still reads.
 */
import { describe, it, expect } from "vitest";
import {
  EMPTY_FILTERS,
  countActiveFilters,
  epicMatchesFilters,
  parseStoredFilters,
  type KanbanFilters,
} from "@/lib/kanban/filters";

const noSignals = { isRunning: false, unreadAi: false, hasFailedSession: false };

function filters(overrides?: Partial<KanbanFilters>): KanbanFilters {
  return { ...EMPTY_FILTERS, ...overrides };
}

describe("epicMatchesFilters", () => {
  const featureP2 = { type: "feature", priority: 2 };
  const bugP0 = { type: "bug", priority: 0 };

  it("matches everything when no filter is active", () => {
    expect(epicMatchesFilters(featureP2, EMPTY_FILTERS, noSignals)).toBe(true);
    expect(epicMatchesFilters(bugP0, EMPTY_FILTERS, noSignals)).toBe(true);
  });

  it("filters by type", () => {
    const f = filters({ types: ["bug"] });
    expect(epicMatchesFilters(featureP2, f, noSignals)).toBe(false);
    expect(epicMatchesFilters(bugP0, f, noSignals)).toBe(true);
  });

  it("filters by priority (multi-select)", () => {
    const f = filters({ priorities: [0, 3] });
    expect(epicMatchesFilters(featureP2, f, noSignals)).toBe(false);
    expect(epicMatchesFilters(bugP0, f, noSignals)).toBe(true);
  });

  it("filters by agent-running / unread-AI / failed-session signals", () => {
    expect(
      epicMatchesFilters(featureP2, filters({ agentRunning: true }), noSignals)
    ).toBe(false);
    expect(
      epicMatchesFilters(featureP2, filters({ agentRunning: true }), {
        ...noSignals,
        isRunning: true,
      })
    ).toBe(true);
    expect(
      epicMatchesFilters(featureP2, filters({ unreadAi: true }), {
        ...noSignals,
        unreadAi: true,
      })
    ).toBe(true);
    expect(
      epicMatchesFilters(featureP2, filters({ failedSession: true }), noSignals)
    ).toBe(false);
    expect(
      epicMatchesFilters(featureP2, filters({ failedSession: true }), {
        ...noSignals,
        hasFailedSession: true,
      })
    ).toBe(true);
  });

  it("combines filters with AND semantics", () => {
    const f = filters({ types: ["feature"], priorities: [2], unreadAi: true });
    expect(epicMatchesFilters(featureP2, f, noSignals)).toBe(false);
    expect(
      epicMatchesFilters(featureP2, f, { ...noSignals, unreadAi: true })
    ).toBe(true);
    expect(
      epicMatchesFilters(bugP0, f, { ...noSignals, unreadAi: true })
    ).toBe(false);
  });
});

describe("countActiveFilters / parseStoredFilters", () => {
  it("counts every active chip", () => {
    expect(countActiveFilters(EMPTY_FILTERS)).toBe(0);
    expect(
      countActiveFilters(
        filters({ types: ["bug"], priorities: [1, 2], failedSession: true })
      )
    ).toBe(4);
  });

  it("parses persisted filters and tolerates malformed payloads", () => {
    const stored = filters({ types: ["feature"], priorities: [3], unreadAi: true });
    expect(parseStoredFilters(JSON.stringify(stored))).toEqual(stored);
    expect(parseStoredFilters(null)).toEqual(EMPTY_FILTERS);
    expect(parseStoredFilters("not-json{")).toEqual(EMPTY_FILTERS);
    expect(parseStoredFilters('"just a string"')).toEqual(EMPTY_FILTERS);
    expect(
      parseStoredFilters(
        JSON.stringify({ types: [42, "bug"], priorities: ["3", 1], unreadAi: "yes" })
      )
    ).toEqual(filters({ types: ["bug"], priorities: [1] }));
  });
});
