"use client";

import { useTranslations } from "next-intl";

import { useCallback, useMemo, useRef, useState } from "react";

import { usePolling } from "@/hooks/usePolling";
import type { ControlDeskPayload } from "@/lib/control-desk/types";

/**
 * The desk's single data source: one poll of `GET /api/control-desk`.
 *
 * POLLING, NOT SSE, and that is a decision rather than a shortcut.
 * `lib/events/bus.ts` keeps a `Map<projectId, Set<Listener>>` and `emit()`
 * returns early for a project with no listener; there is no wildcard room and
 * only a per-project SSE endpoint. Opening one EventSource per project works
 * but costs one long-lived HTTP/1.1 connection each, and browsers cap those at
 * about six per origin — so at six projects the desk's own polls would queue
 * behind its own streams. A wildcard room plus a single `GET /api/events` is
 * the follow-up; until then this replaces the 3s board / 5s inbox / 10s
 * dashboard polls with ONE request.
 *
 * @param projectId when set, the payload is narrowed to that project before it
 *                  reaches the desk — the `/projects/:id` route renders the
 *                  same desk, filtered.
 */
export function useControlDesk(
  projectId?: string | null,
  intervalMs = 4000,
): {
  data: ControlDeskPayload | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
} {
  const tErrors = useTranslations("ClientErrors");
  const [data, setData] = useState<ControlDeskPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  /**
   * Ordering guards for desk polls. Same two the board carries (hooks/
   * useKanban.ts, commit a2a827c — "stop a stale board GET reverting a
   * completed action"), because the desk reproduced the shape that made that
   * a shipped bug.
   *
   * Every desk action ends in `refresh()`, and the 4 s poll keeps running
   * through it. So a poll issued BEFORE a Land / Dispatch / Reply lands can
   * still be in flight when the action's own refresh has already painted the
   * result — and it carries the pre-action world. Applying it puts the ticket
   * back in READY TO LAND, or the session back in QUEUED. Nothing then
   * corrects it until the next tick, which on a 4 s poll is a visible revert
   * of an action the server accepted.
   *
   * - `requestSeq` numbers each request and `appliedSeq` records the newest
   *   one that reached the state: a response that lost the race is dropped.
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
    // True for a response that lost a race — checked after the last await, so
    // nothing can slip in between the check and the state it guards.
    const stale = () =>
      requestSeq <= appliedSeqRef.current ||
      mutationSeqRef.current !== issuedAtMutation;
    try {
      const res = await fetch("/api/control-desk");
      if (!res.ok) {
        if (stale()) return;
        appliedSeqRef.current = requestSeq;
        setError(tErrors("deskHttp", { status: res.status }));
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
      setData(body.data as ControlDeskPayload);
    } catch {
      if (stale()) return;
      appliedSeqRef.current = requestSeq;
      setError(tErrors("failedToLoadTheDesk"));
    } finally {
      setLoading(false);
    }
  }, [tErrors]);

  /**
   * Re-read the desk after a confirmed write.
   *
   * The bump is the point: it invalidates every poll already in flight, which
   * is what stops one of them from repainting the state this refresh is about
   * to replace.
   */
  const refresh = useCallback(async () => {
    mutationSeqRef.current += 1;
    await load();
  }, [load]);

  usePolling(load, intervalMs);

  const filtered = useMemo(
    () => (data ? filterDeskPayload(data, projectId ?? null) : null),
    [data, projectId],
  );

  return { data: filtered, loading, error, refresh };
}

/**
 * Narrow a desk payload to one project.
 *
 * Done on the client rather than with a `?projectId=` query so the two routes
 * share ONE cached response shape and one server derivation — the ranks, the
 * merge readiness and the queue order must be identical whether or not a
 * project chip is active, and computing them twice is how they stop being.
 */
export function filterDeskPayload(
  payload: ControlDeskPayload,
  projectId: string | null,
): ControlDeskPayload {
  if (!projectId) return payload;
  const keep = <T extends { projectId: string }>(rows: readonly T[]): T[] =>
    rows.filter((row) => row.projectId === projectId);

  return {
    ...payload,
    projects: payload.projects.filter((project) => project.id === projectId),
    working: keep(payload.working),
    queued: keep(payload.queued),
    yourTurn: {
      awaitingReply: keep(payload.yourTurn.awaitingReply),
      failed: keep(payload.yourTurn.failed),
      conflicts: keep(payload.yourTurn.conflicts),
    },
    readyToLand: keep(payload.readyToLand),
    upNext: payload.upNext.filter((row) => row.projectId === projectId),
  };
}
