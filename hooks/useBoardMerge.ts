"use client";

import { useCallback, useRef, useState } from "react";

/**
 * Merging a Review card straight from the board.
 *
 * No new endpoint and no new rules: this posts to the SAME
 * `POST /api/projects/:p/epics/:e/approve` route the ticket detail uses, so
 * the card inherits its whole contract — merge into the default branch
 * FIRST, bulk-resolve the findings, then `review → done` through the
 * transition service. A merge that fails changes nothing and answers 409
 * with `mergeFailed`, which is exactly the state this hook parks on the card
 * so the user can reach for Resolve Merge instead of retrying blindly.
 * Merges operate on the project repository's shared base checkout, so only one
 * merge or resolve request can run at a time per project. Other cards on the
 * board are locked while a merge is in flight to prevent index.lock collisions.
 */

export interface BoardMergeState {
  /** A request is in flight for this epic. */
  pending?: boolean;
  /** Another epic's merge is in flight on this project. */
  locked?: boolean;
  /** Which request — the labels and the offered recovery differ. */
  action?: "merge" | "resolve";
  /** Last failure, kept until the next attempt or an explicit dismiss. */
  error?: string | null;
  /**
   * The failure was git refusing the merge (the route's `mergeFailed` flag),
   * so Resolve Merge is the way out. A plain guard refusal is not: the card
   * shows the error and the blocking reason takes over on the next poll.
   */
  conflict?: boolean;
}
export interface UseBoardMergeOptions {
  /** Called after a merge lands, or after Resolve Merge finishes cleanly. */
  onMerged?: (epicId: string) => void;
  /** Called when Resolve Merge dispatched a conflict agent instead. */
  onResolveDispatched?: (epicId: string, sessionId: string) => void;
}

export function useBoardMerge(
  projectId: string,
  { onMerged, onResolveDispatched }: UseBoardMergeOptions = {}
) {
  const [stateByEpic, setStateByEpic] = useState<
    Record<string, BoardMergeState>
  >({});
  // Double-click and concurrent-merge protection that does not wait for a
  // state flush: merges operate on the project repository's shared checkout,
  // so only one merge or resolve request can run at a time per project.
  const inFlightRef = useRef<string | null>(null);
  const [activeEpicId, setActiveEpicId] = useState<string | null>(null);

  const patch = useCallback((epicId: string, next: BoardMergeState) => {
    setStateByEpic((prev) => ({ ...prev, [epicId]: next }));
  }, []);

  const run = useCallback(
    async (
      epicId: string,
      action: "merge" | "resolve",
      request: () => Promise<void>
    ) => {
      if (inFlightRef.current !== null) return;
      inFlightRef.current = epicId;
      setActiveEpicId(epicId);
      patch(epicId, { pending: true, action, error: null, conflict: false });
      try {
        await request();
      } finally {
        inFlightRef.current = null;
        setActiveEpicId(null);
      }
    },
    [patch]
  );

  const merge = useCallback(
    (epicId: string) =>
      run(epicId, "merge", async () => {
        try {
          const res = await fetch(
            `/api/projects/${projectId}/epics/${epicId}/approve`,
            { method: "POST" }
          );
          const data = await res.json().catch(() => ({}));

          if (!res.ok || data.error) {
            patch(epicId, {
              error: data.error || "Failed to merge",
              // 409 + mergeFailed is git's refusal; anything else is a guard.
              conflict: data.mergeFailed === true,
            });
            return;
          }

          patch(epicId, {});
          onMerged?.(epicId);
        } catch {
          patch(epicId, { error: "Failed to merge" });
        }
      }),
    [projectId, run, patch, onMerged]
  );

  const resolveMerge = useCallback(
    (epicId: string) =>
      run(epicId, "resolve", async () => {
        try {
          const res = await fetch(
            `/api/projects/${projectId}/epics/${epicId}/resolve-merge`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({}),
            }
          );
          const data = await res.json().catch(() => ({}));

          if (!res.ok || data.error) {
            // Same rule as `merge`: only git refusing keeps Resolve merge on
            // the card. A busy-agent 409 or a refused preflight would fail
            // identically on the next click, so the card falls back to the
            // readiness signal for the reason instead.
            patch(epicId, {
              error: data.error || "Failed to resolve the merge",
              conflict: data.mergeFailed === true,
            });
            return;
          }

          patch(epicId, {});
          // A clean re-merge already landed the branch; otherwise the route
          // dispatched a conflict-resolution agent and the card goes back to
          // showing ordinary agent activity.
          if (data.data?.resolved) onMerged?.(epicId);
          else if (data.data?.sessionId) {
            onResolveDispatched?.(epicId, data.data.sessionId);
          }
        } catch {
          patch(epicId, { error: "Failed to resolve the merge" });
        }
      }),
    [projectId, run, patch, onMerged, onResolveDispatched]
  );

  /**
   * Drop a card's failure line. Wired to the × on the error itself: nothing
   * else clears this state, so without a control a failure would sit on the
   * card for the Board's lifetime — including after its cause is gone and the
   * card has moved back up to "Ready to merge".
   */
  const dismissError = useCallback(
    (epicId: string) => patch(epicId, {}),
    [patch]
  );

  return {
    stateByEpic,
    activeEpicId,
    isMerging: activeEpicId !== null,
    merge,
    resolveMerge,
    dismissError,
  };
}
