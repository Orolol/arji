"use client";

/**
 * Everything the frame-6a ticket overlay reads, in one view model.
 *
 * This hook composes the ticket's existing hooks — none of which it owns or
 * edits — and adds the four cross-cutting behaviours the overlay is
 * responsible for:
 *
 *  1. MARK-AS-READ ON OPEN. Owned here on purpose, so that *any* path that
 *     opens a ticket clears the unread dot: the desk, the board, the inbox, a
 *     deep link, a future command palette. If it moved to a caller, every new
 *     entry point would have to remember it, and one of them would not.
 *  2. THE POLLING GATE. `useEpicDetail` only runs its 5s background poll while
 *     `polling` is true; without this gate every open ticket would hammer four
 *     endpoints forever.
 *  3. DERIVED-STATE RESET when the ticket changes — render-phase, never an
 *     effect, or the next ticket paints one frame of the previous one's data.
 *  4. THE DEFERRED DIFFSTAT. `GET …/diff` creates a worktree and shells out to
 *     `git diff`; it is fetched once, after paint, only when there is a
 *     branch, and never polled. `hooks/useDiff.ts` is deliberately NOT used
 *     here — it fetches eagerly on mount.
 *  5. THE MERGED TIMELINE. The overlay's activity band reads two sources —
 *     the latest session's recorded board effects and the ticket's transition
 *     log — and they are interleaved here, by timestamp, into one chronology.
 *     The transition log follows the same gate as (2): fetched on open and on
 *     every SSE bump, polled only while a session is live.
 */

import { useCallback, useEffect, useMemo, useState } from "react";

import { useAgentDispatch } from "@/hooks/useAgentDispatch";
import { useEpicActivity } from "@/hooks/useEpicActivity";
import { useEpicDependencies } from "@/hooks/useEpicDependencies";
import { useEpicDetail } from "@/hooks/useEpicDetail";
import { useEpicMutations } from "@/hooks/useEpicMutations";
import { useEpicPr } from "@/hooks/useEpicPr";
import { useGitHubConfig } from "@/hooks/useGitHubConfig";
import { useNamedAgentsList } from "@/hooks/useNamedAgentsList";
import { useProjectEpicsList } from "@/hooks/useProjectEpicsList";
import { useProjectEvents } from "@/hooks/useProjectEvents";
import { useTicketComments } from "@/hooks/useTicketComments";
import type { ArijActionItem } from "@/components/shared/ArijActionsList";
import { fetchUnifiedSessions } from "@/lib/agent-sessions/session-list";
import { aggregateGradingStatus, type GradingStatus } from "@/lib/grading/report";
import { buildActivityFeed } from "@/lib/kanban/activity-feed";
import { projectTone, type ProjectTone } from "@/lib/piscine/tokens";
import {
  activeAgentType,
  activityTimelineLines,
  dependencyOptions,
  dependencyRowItems,
  diffTotals,
  mergeTimelineLines,
  projectToneIndex,
  shortId,
  timelineKindForAction,
  toggledWaitsOn,
  UNKNOWN_DIFF_TOTALS,
  type DependencyOption,
  type DependencyRowItem,
  type DiffTotals,
  type EpicIndexEntry,
  type TimelineLineItem,
} from "@/components/ticket/derive";

/**
 * One line of the agent-activity timeline. Declared in `derive.ts` so the
 * mapping and the merge stay pure; re-exported here because the band imports
 * the view model's vocabulary, not the derivation module's.
 */
export type TimelineEntry = TimelineLineItem;

export interface UseTicketOverlayDataOptions {
  /** Bumped by the host page's project SSE stream; forces an immediate refresh. */
  refreshTrigger?: number;
  onMergeSuccess?: () => void;
  onDeleteSuccess?: () => void;
}

/** Row shape the epics route actually returns — wider than ProjectEpicSummary. */
interface ProjectEpicRow {
  id: string;
  title?: string | null;
  readableId?: string | null;
}

interface UnifiedSessionRow {
  id: string;
  kind?: string;
  epicId?: string | null;
}

export function useTicketOverlayData(
  projectId: string,
  epicId: string | null,
  open: boolean,
  {
    refreshTrigger = 0,
    onMergeSuccess,
    onDeleteSuccess,
  }: UseTicketOverlayDataOptions = {},
) {
  /**
   * Every composed hook keys off this, not the raw `epicId`: a closed overlay
   * — or one opened without a resolved project — must not fetch, and each of
   * these hooks already treats a null epic id as "no target".
   */
  const activeEpicId = open && projectId ? epicId : null;

  const {
    epic,
    userStories,
    loading,
    updateEpic,
    refresh,
    setPolling,
    gradingReport,
  } = useEpicDetail(projectId, activeEpicId);

  const { comments, addComment } = useTicketComments(projectId, {
    kind: "epic",
    epicId: activeEpicId,
  });

  const {
    activeSession,
    dispatching,
    isRunning,
    sendToDev,
    sendToReview,
    sendToGrading,
    resolveMerge,
    refreshSessions,
  } = useAgentDispatch(projectId, { kind: "epic", epicId: activeEpicId });

  const {
    merging,
    mergeError,
    mergeConflict,
    conflictFiles,
    setMergeError,
    merge,
    deletingEpic,
    deleteEpicError,
    deleteEpic,
  } = useEpicMutations(projectId, activeEpicId, {
    onMergeSuccess,
    onDeleteSuccess,
  });

  const {
    predecessors,
    successors,
    saving: dependencySaving,
    error: dependencyError,
    saveDependencies,
  } = useEpicDependencies(projectId, activeEpicId);

  const { pr, loading: prLoading, error: prError, createPr, syncPr } =
    useEpicPr(projectId, activeEpicId);

  const { isConfigured: githubConfigured } = useGitHubConfig(
    activeEpicId ? projectId : undefined,
  );

  const { epics: projectEpics } = useProjectEpicsList(
    projectId,
    activeEpicId,
    open,
  );

  const { agents: namedAgents } = useNamedAgentsList();

  /**
   * The ticket's transition log. FETCHED, NOT POLLED, while nothing runs: an
   * idle ticket's status history is static, so the 5s poll is gated on a live
   * session exactly like the epic poll, and the one-shot load below covers
   * open, ticket switch and every SSE refresh.
   */
  const { entries: activityEntries, refresh: refreshActivity } = useEpicActivity(
    projectId,
    activeEpicId,
    open && isRunning,
  );

  /* ---------------- mark-as-read ------------------------------------ */

  // Opening a ticket marks it read: move its ticket_read_cursors row to now
  // so the kanban unread dot and the cross-project inbox both clear. Owned
  // here, not by the caller, so every entry point clears the dot for free.
  useEffect(() => {
    if (!open || !epicId) return;
    const markRead = async () => {
      try {
        await fetch("/api/inbox/read", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ epicId }),
        });
      } catch {
        // Best-effort — the unread dot simply survives until the next open.
      }
    };
    void markRead();
  }, [open, epicId]);

  /* ---------------- polling + SSE ----------------------------------- */

  // Only poll the ticket while an agent is actually running on it.
  useEffect(() => {
    setPolling(isRunning);
  }, [isRunning, setPolling]);

  // The host page bumps this from the project SSE stream.
  useEffect(() => {
    if (refreshTrigger > 0) void refresh();
  }, [refreshTrigger, refresh]);

  // The transition log's one-shot load: on open, on ticket switch, and on
  // every SSE bump. `refreshActivity` is memoised on the activity URL, so this
  // re-runs exactly when the target ticket changes.
  useEffect(() => {
    if (!open || !activeEpicId) return;
    void refreshActivity();
  }, [open, activeEpicId, refreshTrigger, refreshActivity]);

  // Grader/verify completions arrive as session:completed and ticket:updated.
  // Refresh immediately so the overlay does not wait on the next poll. The
  // subscription only exists while the overlay is mounted.
  useProjectEvents(projectId, {
    "session:completed": () => {
      void refresh();
      void refreshSessions();
      void refreshActivity();
    },
    "ticket:updated": (event) => {
      if (!activeEpicId || event.epicId === activeEpicId) {
        void refresh();
        void refreshActivity();
      }
    },
  });

  /* ---------------- derived-state reset on ticket switch ------------ */

  // React's documented render-phase reset. An effect would paint one frame of
  // the previous ticket's diffstat and session timeline.
  const [lastEpicId, setLastEpicId] = useState(activeEpicId);
  const [diffstat, setDiffstat] = useState<DiffTotals>(UNKNOWN_DIFF_TOTALS);
  const [sessionActions, setSessionActions] = useState<ArijActionItem[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [projectName, setProjectName] = useState<string | null>(null);
  const [projectColorIndex, setProjectColorIndex] = useState<number | null>(null);

  if (activeEpicId !== lastEpicId) {
    setLastEpicId(activeEpicId);
    setDiffstat(UNKNOWN_DIFF_TOTALS);
    setSessionActions([]);
    setSessionId(null);
  }

  /* ---------------- project identity -------------------------------- */

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    fetch(`/api/projects/${projectId}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => {
        if (cancelled || !json?.data) return;
        setProjectName(json.data.name ?? null);
        // `projects.colorIndex` does not exist yet; the `??` keeps this
        // working unchanged the day the column lands.
        setProjectColorIndex(
          typeof json.data.colorIndex === "number" ? json.data.colorIndex : null,
        );
      })
      .catch(() => {
        // The chip falls back to the hashed tone and the project id stem.
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const tone: ProjectTone = useMemo(
    () => projectTone(projectToneIndex(projectId, projectColorIndex)),
    [projectId, projectColorIndex],
  );

  /* ---------------- deferred diffstat -------------------------------- */

  const branchName = epic?.branchName ?? null;

  useEffect(() => {
    if (!open || !activeEpicId || !branchName) return;
    let cancelled = false;
    // After paint, once. This route creates a worktree and shells out to
    // `git diff` — far too expensive to run synchronously on open, and far
    // too expensive to poll.
    const timer = setTimeout(() => {
      fetch(`/api/projects/${projectId}/epics/${activeEpicId}/diff`)
        .then((res) => (res.ok ? res.json() : null))
        .then((json) => {
          if (!cancelled) setDiffstat(diffTotals(json?.data));
        })
        .catch(() => {
          if (!cancelled) setDiffstat(UNKNOWN_DIFF_TOTALS);
        });
    }, 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [open, activeEpicId, branchName, projectId]);

  /* ---------------- session timeline --------------------------------- */

  const sessionRefreshToken = `${activeSession?.id ?? ""}:${refreshTrigger}`;

  useEffect(() => {
    if (!open || !activeEpicId) return;
    let cancelled = false;

    async function load(currentEpicId: string) {
      try {
        const rows = await fetchUnifiedSessions<UnifiedSessionRow>(projectId);
        // The route already sorts newest-first, across pages.
        const latest = rows.find(
          (row) => row.kind === "agent_session" && row.epicId === currentEpicId,
        );
        if (!latest || cancelled) return;
        setSessionId(latest.id);

        const res = await fetch(`/api/projects/${projectId}/sessions/${latest.id}`);
        if (!res.ok) return;
        const json = await res.json();
        const next = (json?.data?.arijActions ?? []) as ArijActionItem[];
        if (!cancelled) setSessionActions(Array.isArray(next) ? next : []);
      } catch {
        // Best-effort ambient detail — the band collapses to its label line.
      }
    }

    void load(activeEpicId);
    return () => {
      cancelled = true;
    };
  }, [projectId, activeEpicId, open, sessionRefreshToken]);

  const agentType = activeAgentType(
    activeSession as {
      type?: string | null;
      agentType?: string | null;
      mode?: string | null;
    } | null,
  );

  const liveLabel =
    (activeSession as { label?: string | null } | null)?.label ?? null;

  /**
   * The ticket's status history, as timeline lines.
   *
   * `buildActivityFeed` is called with NO comments: the CONVERSATION band
   * already renders every one of them, and the feed's own job here is the
   * grouping — consecutive automatic transitions collapse into one line that
   * expands in place, so a pipeline burst does not bury the session's work.
   */
  const activityLines = useMemo(
    () =>
      activityTimelineLines(
        // `useEpicActivity` installs `data.data` unvalidated, so a malformed
        // or unexpected payload reaches here as a non-array. The band showing
        // nothing is the correct failure; a thrown render is not.
        buildActivityFeed([], Array.isArray(activityEntries) ? activityEntries : []),
      ),
    [activityEntries],
  );

  const timeline: TimelineEntry[] = useMemo(() => {
    const sessionLines: TimelineEntry[] = sessionActions.map((action, index) => ({
      key: `${index}-${action.at ?? ""}`,
      kind: timelineKindForAction(action.kind),
      text: action.summary,
      at: action.at ?? null,
    }));
    // Two chronological sources, one chronology: a transition recorded after
    // the session's last action must read after it, not before the whole run.
    const lines = mergeTimelineLines<TimelineEntry>(activityLines, sessionLines);
    // The live line is the in-flight marker: a breathing dot and no glyph.
    // It only exists while a session is actually running.
    if (isRunning && liveLabel) {
      lines.push({ key: "live", kind: "live", text: liveLabel, at: null });
    }
    return lines;
  }, [activityLines, sessionActions, isRunning, liveLabel]);

  const displaySessionId = activeSession?.id ?? sessionId;
  const sessionHref = displaySessionId
    ? `/projects/${projectId}/sessions/${displaySessionId}`
    : null;

  const agentName =
    (activeSession as { namedAgentName?: string | null } | null)
      ?.namedAgentName ?? null;

  const sessionMeta = displaySessionId
    ? [agentName, `session #${shortId(displaySessionId)}`]
        .filter(Boolean)
        .join(" · ")
    : null;

  /* ---------------- dependencies ------------------------------------- */

  const epicIndex = useMemo(() => {
    const index = new Map<string, EpicIndexEntry>();
    // The route returns the full epic row; ProjectEpicSummary only types the
    // three fields its own callers use, so the index is built here rather
    // than by widening someone else's exported type.
    for (const row of projectEpics as unknown as ProjectEpicRow[]) {
      index.set(row.id, { readableId: row.readableId, title: row.title });
    }
    return index;
  }, [projectEpics]);

  // `successors` = tickets that depend on this one  → BLOCKS.
  // `predecessors` = tickets this one depends on    → WAITS ON.
  const blocks: DependencyRowItem[] = useMemo(
    () => dependencyRowItems(successors, "ticketId", epicIndex),
    [successors, epicIndex],
  );
  const waitsOn: DependencyRowItem[] = useMemo(
    () => dependencyRowItems(predecessors, "dependsOnTicketId", epicIndex),
    [predecessors, epicIndex],
  );

  /**
   * WAITS ON is the editable side, and the only one: `PUT …/dependencies`
   * replaces THIS ticket's predecessor list, so a BLOCKS edge is edited from
   * the ticket that owns it. The route re-checks for cycles and its refusal
   * comes back as `dependencyError`.
   */
  const waitsOnIds = useMemo(
    () => predecessors.map((record) => record.dependsOnTicketId),
    [predecessors],
  );

  const waitsOnOptions: DependencyOption[] = useMemo(
    () =>
      dependencyOptions(
        projectEpics as unknown as ProjectEpicRow[],
        activeEpicId,
        waitsOnIds,
      ),
    [projectEpics, activeEpicId, waitsOnIds],
  );

  const toggleWaitsOn = useCallback(
    (epicId: string) => {
      // `saveDependencies` clears the previous error itself and refetches on
      // success, so the chips below follow the server, never the click.
      void saveDependencies(toggledWaitsOn(waitsOnIds, epicId));
    },
    [waitsOnIds, saveDependencies],
  );

  /* ---------------- acceptance grading -------------------------------- */

  // One word for the whole report: missed dominates partial dominates met,
  // and an absent or malformed report is `null` — ungraded, never "met".
  const gradingStatus: GradingStatus | null = useMemo(
    () => aggregateGradingStatus(gradingReport?.gradings),
    [gradingReport],
  );
  const gradingSummary = gradingReport?.summary?.trim() || null;

  /* ---------------- stop the running session -------------------------- */

  const activeSessionId = activeSession?.id ?? null;

  const stopSession = useCallback(async () => {
    const id = activeSessionId;
    if (!id) return;
    try {
      await fetch(`/api/projects/${projectId}/sessions/${id}`, {
        method: "DELETE",
      });
    } catch {
      // The monitor's Stop is best-effort too; the poll reconciles.
    }
    await refreshSessions();
  }, [projectId, activeSessionId, refreshSessions]);

  return {
    epic,
    userStories,
    loading,
    updateEpic,
    refresh,

    comments,
    addComment,

    activeSession,
    agentType,
    isRunning,
    dispatching,
    sendToDev,
    sendToReview,
    sendToGrading,
    resolveMerge,
    stopSession,

    merge,
    merging,
    mergeError,
    mergeConflict,
    conflictFiles,
    setMergeError,
    deleteEpic,
    deletingEpic,
    deleteEpicError,

    pr,
    prLoading,
    prError,
    createPr,
    syncPr,
    githubConfigured,

    blocks,
    waitsOn,
    waitsOnOptions,
    toggleWaitsOn,
    dependencySaving,
    dependencyError,
    namedAgents,

    gradingStatus,
    gradingSummary,

    diffstat,
    timeline,
    sessionMeta,
    sessionHref,

    projectName,
    tone,
  };
}
