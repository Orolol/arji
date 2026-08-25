"use client";

import { useEffect, useState } from "react";
import {
  DISPATCH_RELIABILITY_MIN_SAMPLE,
  DISPATCH_RELIABILITY_WINDOW_DAYS,
  type DispatchReliabilityRow,
  type DispatchRole,
} from "@/lib/agent-config/dispatch-reliability-constants";

/**
 * The reliability numbers behind the picker badge, indexed by named agent id
 * for the requested role.
 *
 * One fetch serves every picker on the page: the response is cached at module
 * level and concurrent callers share the in-flight promise. A board can render
 * a build picker and a review picker side by side, each listing every named
 * agent — without this the badge would be exactly the N+1 the endpoint exists
 * to avoid.
 *
 * The cache is intentionally never invalidated on a timer: these are 30-day
 * averages, so a page that lives for an hour showing numbers from when it
 * loaded is showing the truth. A remount (reopening a dialog) is the refresh.
 */

interface DispatchStatsPayload {
  windowDays: number;
  minSample: number;
  rows: DispatchReliabilityRow[];
}

let cache: DispatchStatsPayload | null = null;
let inFlight: Promise<DispatchStatsPayload> | null = null;

const EMPTY: DispatchStatsPayload = {
  windowDays: DISPATCH_RELIABILITY_WINDOW_DAYS,
  minSample: DISPATCH_RELIABILITY_MIN_SAMPLE,
  rows: [],
};

function loadDispatchStats(): Promise<DispatchStatsPayload> {
  if (cache) return Promise.resolve(cache);
  if (inFlight) return inFlight;

  inFlight = fetch("/api/agent-config/dispatch-stats")
    .then((res) => res.json())
    .then((json) => {
      const data = json?.data;
      const payload: DispatchStatsPayload = {
        windowDays: data?.windowDays ?? EMPTY.windowDays,
        minSample: data?.minSample ?? EMPTY.minSample,
        rows: Array.isArray(data?.rows) ? data.rows : [],
      };
      cache = payload;
      return payload;
    })
    .catch(() => EMPTY)
    .finally(() => {
      inFlight = null;
    });

  return inFlight;
}

/** Drops the cached aggregate — exported for tests. */
export function resetDispatchReliabilityCache(): void {
  cache = null;
  inFlight = null;
}

export interface DispatchReliability {
  /** namedAgentId → the row for this role. Empty until loaded. */
  byAgentId: Map<string, DispatchReliabilityRow>;
  windowDays: number;
  minSample: number;
  loading: boolean;
}

/**
 * `role` of null disables the hook entirely (no fetch, empty map) — pickers
 * that do not declare a task type keep their plain agent list.
 */
export function useDispatchReliability(
  role: DispatchRole | null | undefined,
): DispatchReliability {
  // Seeded from the module cache so a reopened dialog renders its badges on
  // the first paint instead of flashing blanks.
  const [payload, setPayload] = useState<DispatchStatsPayload | null>(cache);

  useEffect(() => {
    if (!role) return;
    let cancelled = false;
    loadDispatchStats().then((next) => {
      if (!cancelled) setPayload(next);
    });
    return () => {
      cancelled = true;
    };
  }, [role]);

  // Derived, not stored: `loadDispatchStats` resolves to EMPTY even on a
  // failed request, so "no payload yet" is exactly "still loading".
  const loading = Boolean(role) && payload === null;

  const byAgentId = new Map<string, DispatchReliabilityRow>();
  if (role && payload) {
    for (const row of payload.rows) {
      if (row.role === role) byAgentId.set(row.namedAgentId, row);
    }
  }

  return {
    byAgentId,
    windowDays: payload?.windowDays ?? EMPTY.windowDays,
    minSample: payload?.minSample ?? EMPTY.minSample,
    loading,
  };
}
