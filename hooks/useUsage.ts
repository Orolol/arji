"use client";

import { useCallback, useEffect, useState } from "react";
import type { UsageRange, UsageReport } from "@/lib/types/usage";

/**
 * The usage observatory's single data source: one fat GET /api/usage.
 *
 * Deliberately NOT polled. Subscription burn is slow state, not live
 * activity — a manual refresh button is the contract, so the page never
 * churns the codex rollout scan the route performs on every read.
 *
 * A failed refresh keeps the previously loaded report on screen and only
 * raises `error`; the page decides whether that means "error screen" (no
 * report yet) or "stale data plus a warning".
 *
 * `refresh({ fresh: true })` appends `?fresh=1`, which bypasses the route's
 * 120s live-quota TTL and re-polls the provider CLIs. The mount effect, the
 * error-screen Retry, a RANGE CHANGE and the post-cap-save refresh
 * deliberately do NOT force: only the explicit Refresh button pays the
 * (bounded) cold-poll latency.
 *
 * `range` scopes the response's `dashboard` block only. The query string is
 * built by hand rather than with URLSearchParams so the default case is
 * EXACTLY the bare path `/api/usage` — three tests assert those literals, and
 * `?range=30d` would be a different string for an identical read.
 */
export function useUsage() {
  const [report, setReport] = useState<UsageReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [range, setRange] = useState<UsageRange>("30d");

  const refresh = useCallback(
    async (opts?: { fresh?: boolean }) => {
      setLoading(true);
      setError(null);
      try {
        // `range` first, then `fresh` — the order is asserted.
        const query = [
          range !== "30d" ? `range=${range}` : null,
          opts?.fresh ? "fresh=1" : null,
        ]
          .filter(Boolean)
          .join("&");
        const response = await fetch(
          query === "" ? "/api/usage" : `/api/usage?${query}`
        );
        const body = await response.json().catch(() => null);
        if (!response.ok) {
          setError(
            typeof body?.error === "string"
              ? body.error
              : "Failed to load the usage report."
          );
          return;
        }
        if (!body?.data) {
          setError("Failed to load the usage report.");
          return;
        }
        setReport(body.data as UsageReport);
      } catch {
        setError("Failed to load the usage report.");
      } finally {
        setLoading(false);
      }
    },
    [range]
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { report, loading, error, range, setRange, refresh };
}
