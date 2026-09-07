"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";

import type { KanbanStatus } from "@/lib/types/kanban";
import type { RegistrySort, RegistrySortDirection } from "@/lib/tickets-registry/sort";
import { usePolling } from "@/hooks/usePolling";
import {
  REGISTRY_DONE_WINDOW,
  REGISTRY_RELEASED_WINDOW,
  REGISTRY_WINDOW_MAX,
  type RegistryGroup,
  type TicketsRegistryPayload,
} from "@/lib/tickets-registry/types";

/**
 * The registry's single data source: one poll of `GET /api/tickets`.
 *
 * POLLING, NOT SSE, for the reason `hooks/useControlDesk.ts` documents at
 * length: `lib/events/bus.ts` has no wildcard room and only a per-project SSE
 * endpoint, so N EventSources would cost one long-lived HTTP/1.1 connection per
 * project and starve the page at about six. 10 s rather than the desk's 4 s —
 * the registry is a lookup surface, not an attention surface, and its query is
 * the heavier of the two.
 *
 * THE STALE GUARD is the same one the desk and the board carry. The 6a overlay
 * opens over this table and can delete or dispatch a ticket; a poll issued
 * before that write can still be in flight when the overlay closes, and
 * applying it would repaint the pre-overlay world. `requestSeq` numbers each
 * request, `appliedSeq` records the newest one that reached the state, and a
 * response that lost the race is dropped. There is no `mutationSeq` here on
 * purpose: this screen issues no writes of its own, so there is no confirmed
 * write whose timing a refresh would have to be tied to.
 */

const POLL_INTERVAL_MS = 10_000;

export interface TicketsRegistryWindow {
  done: number;
  released: number;
}

export interface UseTicketsRegistry {
  data: TicketsRegistryPayload | null;
  loading: boolean;
  error: string | null;
  window: TicketsRegistryWindow;
  refresh: () => Promise<void>;
  /** Raise the server window for one terminal group ("tout montrer ↓"). */
  setWindow: (group: RegistryGroup, limit: number) => void;
}

export function useTicketsRegistry(
  projectId?: string | null,
  query?: string,
  sort: RegistrySort = "activite",
  direction: RegistrySortDirection = "desc",
  status: KanbanStatus | "all" = "all",
): UseTicketsRegistry {
  const t = useTranslations("Registry");
  const [data, setData] = useState<TicketsRegistryPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [win, setWin] = useState<TicketsRegistryWindow>({
    done: REGISTRY_DONE_WINDOW,
    released: REGISTRY_RELEASED_WINDOW,
  });

  const requestSeqRef = useRef(0);
  const appliedSeqRef = useRef(0);

  const href = useMemo(() => {
    const params = new URLSearchParams();
    params.set("sort", sort);
    params.set("direction", direction);
    if (status !== "all") params.set("status", status);
    if (projectId) params.set("project", projectId);
    const trimmed = (query ?? "").trim();
    if (trimmed) params.set("q", trimmed);
    if (win.done !== REGISTRY_DONE_WINDOW) params.set("doneLimit", String(win.done));
    if (win.released !== REGISTRY_RELEASED_WINDOW) {
      params.set("releasedLimit", String(win.released));
    }
    const search = params.toString();
    return search ? `/api/tickets?${search}` : "/api/tickets";
  }, [projectId, query, win.done, win.released, sort, direction, status]);

  const load = useCallback(async () => {
    const requestSeq = ++requestSeqRef.current;
    // Checked after the last await, so nothing can slip in between the check
    // and the state it guards.
    const stale = () => requestSeq !== requestSeqRef.current || requestSeq <= appliedSeqRef.current;
    try {
      const res = await fetch(href);
      if (!res.ok) {
        if (stale()) return;
        appliedSeqRef.current = requestSeq;
        setError(t("errors.loadFailedStatus", { status: res.status }));
        return;
      }
      const body = await res.json();
      if (stale()) return;
      appliedSeqRef.current = requestSeq;
      if (body?.error) {
        setError(String(body.error));
        return;
      }
      setError(null);
      setData(body.data as TicketsRegistryPayload);
    } catch {
      if (stale()) return;
      appliedSeqRef.current = requestSeq;
      setError(t("errors.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [href, t]);

  const refresh = useCallback(async () => {
    await load();
  }, [load]);

  const setWindow = useCallback((group: RegistryGroup, limit: number) => {
    const clamped = Math.min(REGISTRY_WINDOW_MAX, Math.max(1, Math.trunc(limit)));
    setWin((current) => {
      if (group === "done") {
        return clamped > current.done ? { ...current, done: clamped } : current;
      }
      if (group === "released") {
        return clamped > current.released ? { ...current, released: clamped } : current;
      }
      // The three open groups are never windowed — the route loads them whole.
      return current;
    });
  }, []);

  usePolling(load, POLL_INTERVAL_MS);

  return { data, loading, error, window: win, refresh, setWindow };
}
