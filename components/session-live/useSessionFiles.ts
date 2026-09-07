"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";

import { usePolling } from "@/hooks/usePolling";

import type {
  SessionDiff,
  SessionFilesProject,
  SessionFilesResponse,
  SessionFilesTicket,
} from "./types";

/**
 * The session's ticket, project and worktree diffstat, from the read-only
 * `/files` route.
 *
 * POLLED AT 15 SECONDS, NOT 3. The route shells out to git — `merge-base`,
 * `rev-list` and three `diff --numstat` calls in the session's worktree — and
 * `hooks/useWorktrees.ts` records the precedent: its route is "deliberately
 * not polled" for the same reason. 15s is the compromise this screen's
 * liveness needs; it is not folded into the 3-second session poll, and it is
 * not lowered.
 *
 * A failed request keeps the previous value and records the error: the header
 * identity, once it has landed, must not blink out because a git call failed.
 */

export interface SessionFilesState {
  ticket: SessionFilesTicket | null;
  project: SessionFilesProject | null;
  diff: SessionDiff | null;
  loading: boolean;
  error: string | null;
}

export function useSessionFiles(
  projectId: string,
  sessionId: string,
  isRunning: boolean
): SessionFilesState {
  // Read into a plain string so `load` depends on the message rather than on
  // the translator identity, which changes on every render.
  const t = useTranslations("SessionLive");
  const readFailedCopy = t("files.readFailed");
  const [ticket, setTicket] = useState<SessionFilesTicket | null>(null);
  const [project, setProject] = useState<SessionFilesProject | null>(null);
  const [diff, setDiff] = useState<SessionDiff | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // A slow git call must not stack behind the poll.
  const inFlight = useRef(false);

  const load = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const res = await fetch(
        `/api/projects/${projectId}/sessions/${sessionId}/files`
      );
      if (!res.ok) throw new Error(`Files request failed (${res.status})`);
      const body = (await res.json()) as { data?: SessionFilesResponse };
      if (!body.data) throw new Error("Files response had no data");
      setTicket(body.data.ticket);
      setProject(body.data.project);
      setDiff(body.data.diff);
      setError(null);
    } catch {
      // Never throws: this is ambient detail on a page that must keep working.
      setError(readFailedCopy);
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }, [projectId, sessionId, readFailedCopy]);

  useEffect(() => {
    void load();
  }, [load]);

  usePolling(load, 15000, isRunning, { immediate: false });

  // One more read when the run ends, so the final diff lands even though the
  // poll above has just switched itself off.
  const wasRunning = useRef(isRunning);
  useEffect(() => {
    if (wasRunning.current && !isRunning) void load();
    wasRunning.current = isRunning;
  }, [isRunning, load]);

  return { ticket, project, diff, loading, error };
}
