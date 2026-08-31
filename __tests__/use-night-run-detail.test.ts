import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { useNightRunDetail } from "@/hooks/useNightRuns";
import type { NightRunDetail } from "@/lib/night/constants";

function detailFor(runId: string, state: NightRunDetail["state"] = "finished") {
  return {
    runId,
    projectId: "proj-1",
    source: "db",
    interrupted: false,
    state,
    startedAt: "2026-08-30T22:00:00.000Z",
    endedAt: state === "finished" ? "2026-08-31T02:00:00.000Z" : null,
    failurePolicy: null,
    totalWaves: 1,
    currentWave: 1,
    counts: {},
    epics: [],
    stopRequested: false,
    totalCostUsd: 0,
    costIsPartial: false,
    abortReason: null,
    abortedAtWave: null,
    breakerThreshold: null,
    costCapUsd: null,
  } as unknown as NightRunDetail;
}

/**
 * The dialog is a single mount that is pointed at one run after another: the
 * summary list closes it (runId -> null) and reopens it on the next run. Every
 * value it exposes therefore has to belong to the run being asked for *now*.
 * A retained summary is not a cosmetic staleness — the Stop button is drawn
 * from `detail.state` and fires at the *current* runId, so run A's live state
 * under run B's id offers to stop a run the user never looked at.
 */
describe("useNightRunDetail", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("drops the summary as soon as the dialog closes", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: detailFor("run-a") }),
    });

    const { result, rerender } = renderHook(
      ({ runId }: { runId: string | null }) => useNightRunDetail("proj-1", runId),
      { initialProps: { runId: "run-a" as string | null } }
    );

    await waitFor(() => expect(result.current.detail?.runId).toBe("run-a"));

    rerender({ runId: null });

    expect(result.current.detail).toBeNull();
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it("does not show the previous run's summary while the next run loads", async () => {
    let releaseRunB: ((value: unknown) => void) | null = null;

    global.fetch = vi.fn((url: string) => {
      if (url.endsWith("/run-a")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ data: detailFor("run-a", "running") }),
        });
      }
      return new Promise((resolve) => {
        releaseRunB = resolve;
      });
    }) as unknown as typeof fetch;

    const { result, rerender } = renderHook(
      ({ runId }: { runId: string | null }) => useNightRunDetail("proj-1", runId),
      { initialProps: { runId: "run-a" as string | null } }
    );

    await waitFor(() => expect(result.current.detail?.runId).toBe("run-a"));

    // The user closes run A's summary and opens run B's; B's request is still
    // in flight.
    rerender({ runId: null });
    rerender({ runId: "run-b" });

    expect(result.current.detail).toBeNull();
    expect(result.current.loading).toBe(true);

    await act(async () => {
      releaseRunB!({
        ok: true,
        json: () => Promise.resolve({ data: detailFor("run-b") }),
      });
    });

    await waitFor(() => expect(result.current.detail?.runId).toBe("run-b"));
    expect(result.current.loading).toBe(false);
  });

  it("keeps a failed run's error attached to the run that failed", async () => {
    global.fetch = vi.fn((url: string) => {
      if (url.endsWith("/run-a")) {
        return Promise.resolve({
          ok: false,
          json: () => Promise.resolve({ error: "Night run not found" }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ data: detailFor("run-b") }),
      });
    }) as unknown as typeof fetch;

    const { result, rerender } = renderHook(
      ({ runId }: { runId: string | null }) => useNightRunDetail("proj-1", runId),
      { initialProps: { runId: "run-a" as string | null } }
    );

    await waitFor(() => expect(result.current.error).toBe("Night run not found"));

    rerender({ runId: "run-b" });

    // Run A's error must not sit over run B while B is still loading.
    expect(result.current.error).toBeNull();
    expect(result.current.loading).toBe(true);

    await waitFor(() => expect(result.current.detail?.runId).toBe("run-b"));
    expect(result.current.error).toBeNull();
  });
});
