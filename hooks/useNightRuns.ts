"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
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

/**
 * Loads one night run's detail (morning summary). Keeps polling while the
 * run is still executing so the dialog can be opened mid-run.
 */
export function useNightRunDetail(
  projectId: string,
  runId: string | null,
  intervalMs: number = 5000
) {
  const [detail, setDetail] = useState<NightRunDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Shared by the mount fetch and by `load`, so the effect only ever updates
  // state from a promise callback instead of synchronously in its body.
  const applyDetail = useCallback(
    (ok: boolean, json: { data?: unknown; error?: string } | null) => {
      if (!ok || !json?.data) {
        setDetail(null);
        setError(json?.error ?? "Night run not found");
      } else {
        setDetail(json.data as NightRunDetail);
        setError(null);
      }
      setLoading(false);
    },
    []
  );

  const runUrl = runId
    ? `/api/projects/${projectId}/build/night-runs/${runId}`
    : null;

  const load = useCallback(async () => {
    if (!runUrl) {
      setDetail(null);
      setError(null);
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(runUrl);
      applyDetail(res.ok, await res.json());
    } catch {
      setError("Failed to load the night run summary");
      setLoading(false);
    }
  }, [runUrl, applyDetail]);

  useEffect(() => {
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
        if (!cancelled) applyDetail(ok, json);
      })
      .catch(() => {
        if (cancelled) return;
        setError("Failed to load the night run summary");
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [runUrl, applyDetail]);

  usePolling(load, intervalMs, Boolean(runId) && detail?.state === "running", {
    immediate: false,
  });

  return { detail, loading, error, refresh: load };
}
