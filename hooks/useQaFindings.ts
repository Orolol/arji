"use client";

import { useCallback, useMemo, useRef, useState } from "react";

import { usePolling } from "@/hooks/usePolling";
import type { QaPayload } from "@/lib/qa/types";

/**
 * Frame 11b's single data source: one poll of `GET /api/qa/findings`.
 *
 * SAME SHAPE AS `useControlDesk`, DELIBERATELY — including both ordering
 * guards, which are load-bearing here for exactly the reason they are on the
 * desk (see below).
 *
 * THE INTERVAL IS 8 s, NOT 4 s. `better-sqlite3` is synchronous on ONE shared
 * connection, and the control desk already polls it every 4 s from the route
 * the user usually has open. QA is a secondary surface: a human arbitrating
 * findings does not need a 4 s refresh, and halving the frequency halves what
 * this screen costs the connection every other request shares.
 *
 * POLLING, NOT SSE, for the reason `hooks/useControlDesk.ts` documents:
 * `lib/events/bus.ts` has no wildcard room and only a per-project SSE
 * endpoint, so a cross-project screen would need one long-lived connection per
 * project and browsers cap those at about six per origin.
 *
 * @param projectId when set, the payload is narrowed to that project before it
 *                  reaches the screen.
 */
export function useQaFindings(
  projectId?: string | null,
  intervalMs = 8000,
): {
  data: QaPayload | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
} {
  const [data, setData] = useState<QaPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  /**
   * Ordering guards. Every action on 11b ends in `refresh()` and the poll keeps
   * running through it, so a poll issued BEFORE a Dismiss / Fix / Run QA pass
   * can still be in flight when the action's own refresh has already painted
   * the result — carrying the pre-action world. Applying it puts the dismissed
   * finding back in the coral band, which on an 8 s poll is a visible revert of
   * an action the server accepted.
   *
   * - `requestSeq` numbers each request and `appliedSeq` records the newest one
   *   that reached the state: a response that lost the race is dropped.
   * - `mutationSeq` counts confirmed writes. `refresh()` bumps it, so every
   *   poll already in flight when an action completes is discarded even if it
   *   is the newest request issued — it describes a world the user has left.
   *
   * `refresh()` itself is the recovery half: it is the one GET whose timing is
   * tied to the write, so it always applies.
   */
  const requestSeqRef = useRef(0);
  const appliedSeqRef = useRef(0);
  const mutationSeqRef = useRef(0);

  const load = useCallback(async () => {
    const requestSeq = ++requestSeqRef.current;
    const issuedAtMutation = mutationSeqRef.current;
    // Checked after the last await, so nothing can slip in between the check
    // and the state it guards.
    const stale = () =>
      requestSeq <= appliedSeqRef.current ||
      mutationSeqRef.current !== issuedAtMutation;
    try {
      const res = await fetch("/api/qa/findings");
      if (!res.ok) {
        if (stale()) return;
        appliedSeqRef.current = requestSeq;
        setError(`Failed to load QA (${res.status})`);
        return;
      }
      const body = await res.json();
      if (stale()) return;
      appliedSeqRef.current = requestSeq;
      if (body?.error) {
        setError(body.error);
        return;
      }
      setError(null);
      setData(body.data as QaPayload);
    } catch {
      if (stale()) return;
      appliedSeqRef.current = requestSeq;
      setError("Failed to load QA");
    } finally {
      setLoading(false);
    }
  }, []);

  /**
   * Re-read after a confirmed write. The bump is the point: it invalidates
   * every poll already in flight, which is what stops one of them repainting
   * the state this refresh is about to replace.
   */
  const refresh = useCallback(async () => {
    mutationSeqRef.current += 1;
    await load();
  }, [load]);

  usePolling(load, intervalMs);

  const filtered = useMemo(
    () => (data ? filterQaPayload(data, projectId ?? null) : null),
    [data, projectId],
  );

  return { data: filtered, loading, error, refresh };
}

/**
 * Narrow a QA payload to one project.
 *
 * Done on the client rather than with a `?projectId=` query so the two views
 * share ONE cached response shape and one server derivation — the severity
 * stamps, the blocking flags and the verdict ranking must be identical whether
 * or not a project is active, and computing them twice is how they stop being.
 *
 * `rubric` and `coveragePercent` are NOT narrowed, and that is the same
 * decision `filterDeskPayload` makes about the TODAY roll-up: both are single
 * derived facts that cannot be recomputed from the rows in hand. The rubric is
 * genuinely global (it is the prompt every reviewer gets); the coverage stat is
 * cross-project by construction and a project-scoped one would need its own
 * server derivation rather than a client guess.
 */
export function filterQaPayload(
  payload: QaPayload,
  projectId: string | null,
): QaPayload {
  if (!projectId) return payload;
  const keep = <T extends { projectId: string }>(rows: readonly T[]): T[] =>
    rows.filter((row) => row.projectId === projectId);

  return {
    ...payload,
    projects: payload.projects.filter((project) => project.id === projectId),
    runs: keep(payload.runs),
    queued: keep(payload.queued),
    findings: keep(payload.findings),
    verdicts: keep(payload.verdicts),
    reviewable: keep(payload.reviewable),
    checks: keep(payload.checks),
    // Narrowed by KEY, which is why the route groups by project: the screen
    // sums whichever projects are in scope (`sumCheckTotals`), so a
    // project-scoped band counts that project's reports and nothing else.
    checkTotals: Object.fromEntries(
      Object.entries(payload.checkTotals).filter(([id]) => id === projectId),
    ),
    checkableProjectIds: payload.checkableProjectIds.filter(
      (id) => id === projectId,
    ),
  };
}
