"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePolling } from "@/hooks/usePolling";
import type {
  NightRunDetail,
  NightRunListEntry,
} from "@/lib/night/constants";

/**
 * Polls the project's night runs (the registry's active run plus its recent
 * ring, merged with runs rebuilt from the database).
 *
 * A failed request keeps the previous snapshot *and* raises `error`. Both
 * halves matter: this list is the only durable way back into a past run's
 * morning summary, so a dead request must never be indistinguishable from
 * "this project has no night runs" — the caller needs to tell the two apart.
 *
 * Cadence follows the data: `intervalMs` while a run is live, `idleIntervalMs`
 * otherwise. Terminal history barely changes, and the list route rebuilds every
 * run through per-run and per-epic queries, so idle polling should not pay the
 * live rate — but it does keep polling, so a run starting while the list is
 * open still appears.
 */
export function useNightRuns(
  projectId: string,
  enabled: boolean = true,
  intervalMs: number = 5000,
  idleIntervalMs: number = 30000
) {
  const [runs, setRuns] = useState<NightRunListEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${projectId}/build/night-runs`);
      const json = await res.json().catch(() => null);
      if (!res.ok || !Array.isArray(json?.data)) {
        // Leave `runs` alone: a stale list beats a blank one.
        setError(json?.error ?? "Could not load night runs");
      } else {
        setRuns(json.data as NightRunListEntry[]);
        setError(null);
      }
    } catch {
      setError("Could not load night runs");
    }
    setLoading(false);
  }, [projectId]);

  /**
   * The one run currently executing. A run rebuilt from the database after a
   * restart is never "active": its engine died with the process.
   */
  const activeRun = useMemo(
    () =>
      runs.find((run) => run.state === "running" && !run.interrupted) ?? null,
    [runs]
  );

  usePolling(load, activeRun ? intervalMs : idleIntervalMs, enabled);

  return { runs, activeRun, loading, error, refresh: load };
}

/**
 * Asks the server to stop an in-flight night run. Returns true when the run
 * was flagged (a 404 means it already finished, which is not an error worth
 * shouting about). The engine only reacts at the next wave boundary, so the
 * caller should keep polling rather than assume an immediate finish.
 */
export async function stopNightRun(
  projectId: string,
  runId: string
): Promise<boolean> {
  try {
    const res = await fetch(
      `/api/projects/${projectId}/build/night-runs/${runId}/stop`,
      { method: "POST" }
    );
    return res.ok;
  } catch {
    return false;
  }
}

type SettledDetail = {
  /** The run URL this result answers. */
  key: string;
  detail: NightRunDetail | null;
  error: string | null;
};

/**
 * Loads one night run's detail (morning summary). Keeps polling while the
 * run is still executing so the dialog can be opened mid-run.
 *
 * Every value is keyed by the run being asked for *now*. The dialog is one
 * mount pointed at one run after another — the list closes it (`runId` back to
 * null) and reopens it on the next run — so a result recorded for a run it has
 * since left is not an answer about this one. Retaining it is not merely
 * cosmetic: `detail.state` draws the Stop button, and the click stops the
 * *current* `runId`, so run A's live state under run B's id offers to stop a
 * run nobody looked at.
 */
export function useNightRunDetail(
  projectId: string,
  runId: string | null,
  intervalMs: number = 5000
) {
  const [settled, setSettled] = useState<SettledDetail | null>(null);

  const runUrl = runId
    ? `/api/projects/${projectId}/build/night-runs/${runId}`
    : null;

  /**
   * The run URL being asked for *now*, for the response handlers to check
   * against: a request is never cancelled when the dialog moves on, and
   * `usePolling` leaves its in-flight callback running when it restarts. A
   * poll issued for the previous run can therefore still answer, and there is
   * only one slot to answer into. Dropping the reply is not cosmetic either:
   * once a finished run is on screen nothing polls any more, so a result
   * evicted by a straggler is never fetched again and the dialog is stuck
   * loading until it is closed and reopened.
   */
  const requestedUrl = useRef(runUrl);

  // No run asked for is a settled empty state, not a pending one.
  const current = runUrl !== null && settled?.key === runUrl ? settled : null;
  const detail = current?.detail ?? null;
  const error = current?.error ?? null;
  const loading = runUrl !== null && current === null;

  // Shared by the mount fetch and by `load`, so the effect only ever updates
  // state from a promise callback instead of synchronously in its body.
  const applyDetail = useCallback(
    (
      key: string,
      ok: boolean,
      json: { data?: unknown; error?: string } | null
    ) => {
      if (key !== requestedUrl.current) return;
      setSettled(
        ok && json?.data
          ? { key, detail: json.data as NightRunDetail, error: null }
          : { key, detail: null, error: json?.error ?? "Night run not found" }
      );
    },
    []
  );

  const applyFailure = useCallback((key: string) => {
    if (key !== requestedUrl.current) return;
    setSettled({
      key,
      detail: null,
      error: "Failed to load the night run summary",
    });
  }, []);

  const load = useCallback(async () => {
    if (!runUrl) return;
    try {
      const res = await fetch(runUrl);
      applyDetail(runUrl, res.ok, await res.json());
    } catch {
      applyFailure(runUrl);
    }
  }, [runUrl, applyDetail, applyFailure]);

  useEffect(() => {
    requestedUrl.current = runUrl;
    if (!runUrl) {
      return;
    }
    let cancelled = false;
    let ok = false;
    fetch(runUrl)
      .then((res) => {
        ok = res.ok;
        return res.json();
      })
      .then((json) => {
        if (!cancelled) applyDetail(runUrl, ok, json);
      })
      .catch(() => {
        if (!cancelled) applyFailure(runUrl);
      });
    return () => {
      cancelled = true;
    };
  }, [runUrl, applyDetail, applyFailure]);

  usePolling(load, intervalMs, Boolean(runId) && detail?.state === "running", {
    immediate: false,
  });

  return { detail, loading, error, refresh: load };
}
