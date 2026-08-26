"use client";

import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Board } from "@/components/kanban/Board";
import { EpicDetail } from "@/components/kanban/EpicDetail";
import { UnifiedChatPanel, type UnifiedChatPanelHandle } from "@/components/chat/UnifiedChatPanel";
import { AgentMonitor } from "@/components/monitor/AgentMonitor";
import { useAgentPolling } from "@/hooks/useAgentPolling";
import { useBatchSelection } from "@/hooks/useBatchSelection";
import { NamedAgentSelect } from "@/components/shared/NamedAgentSelect";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Hammer, Layers, Loader2, X, CheckCircle2, XCircle, Plus, Users, Search, GitMerge, Bot, TriangleAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import { BugCreateDialog } from "@/components/kanban/BugCreateDialog";
import { EpicCreateDialog } from "@/components/kanban/EpicCreateDialog";
import { NightRunDialog } from "@/components/night/NightRunDialog";
import { NightRunSummaryDialog } from "@/components/night/NightRunSummaryDialog";
import { AutoModeDialog } from "@/components/auto-mode/AutoModeDialog";
import { AutoModeToggle } from "@/components/auto-mode/AutoModeToggle";
import { RefinementButton } from "@/components/kanban/RefinementButton";
import { QuickCapture } from "@/components/kanban/QuickCapture";
import type { KanbanEpicAgentActivity } from "@/lib/types/kanban";
import { getActiveDetailTicketId, selectOnlyTicket } from "@/lib/kanban/selection";
import { useProjectEvents } from "@/hooks/useProjectEvents";

interface Toast {
  id: string;
  type: "success" | "error" | "warning";
  message: string;
  href?: string;
  actionLabel?: string;
}

export default function KanbanPage() {
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const projectId = params.projectId as string;
  const batch = useBatchSelection(projectId);
  const [buildMode, setBuildMode] = useState<"parallel" | "sequential" | "dag">(
    "parallel"
  );
  const [teamMode, setTeamMode] = useState(false);
  const [autoMergeAgent, setAutoMergeAgent] = useState(false);
  const [namedAgentId, setNamedAgentId] = useState<string | null>(null);
  const [building, setBuilding] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [batchMerging, setBatchMerging] = useState(false);
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const [bugDialogOpen, setBugDialogOpen] = useState(false);
  const [epicDialogOpen, setEpicDialogOpen] = useState(false);
  const [nightDialogOpen, setNightDialogOpen] = useState(false);
  const [autoModeDialogOpen, setAutoModeDialogOpen] = useState(false);
  const [nightSummaryRunId, setNightSummaryRunId] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [highlightedActivityId, setHighlightedActivityId] = useState<string | null>(null);
  // The Released digest yields its width to the side panel while it is open
  // (the panel reports its own expanded state — see UnifiedChatPanel).
  const [panelOpen, setPanelOpen] = useState(false);
  const [visibleCount, setVisibleCount] = useState(0);
  const { activities, failedSessions } = useAgentPolling(projectId, 3000, refreshTrigger);
  const prevSessionIds = useRef<Set<string>>(new Set());
  const panelRef = useRef<UnifiedChatPanelHandle>(null);

  // Real-time events via SSE — auto-refresh board on ticket/session changes
  // pollTick increments on fallback polling when SSE is disconnected
  const { status: sseStatus, pollTick } = useProjectEvents(projectId, {
    "ticket:moved": () => setRefreshTrigger((t) => t + 1),
    "ticket:created": () => setRefreshTrigger((t) => t + 1),
    "ticket:updated": () => setRefreshTrigger((t) => t + 1),
    "ticket:deleted": () => setRefreshTrigger((t) => t + 1),
    "session:started": () => setRefreshTrigger((t) => t + 1),
    "session:completed": () => setRefreshTrigger((t) => t + 1),
    "session:failed": () => setRefreshTrigger((t) => t + 1),
    "session:progress": () => setRefreshTrigger((t) => t + 1),
    "artifact:created": () => setRefreshTrigger((t) => t + 1),
    "release:created": () => setRefreshTrigger((t) => t + 1),
  });

  // Fallback: refresh board when SSE is down and polling kicks in
  useEffect(() => {
    if (pollTick > 0) {
      setRefreshTrigger((t) => t + 1);
    }
  }, [pollTick]);

  const activeAgentActivities = useMemo<Record<string, KanbanEpicAgentActivity>>(
    () => {
      const map: Record<string, KanbanEpicAgentActivity> = {};

      for (const activity of activities) {
        if (!activity.epicId) continue;
        // Queued sessions surface in the AgentMonitor; the kanban agent
        // chip stays reserved for agents that are actually running.
        if (activity.status !== "running") continue;
        if (!["build", "review", "merge"].includes(activity.type)) continue;

        map[activity.epicId] = {
          sessionId: activity.id,
          actionType: activity.type as KanbanEpicAgentActivity["actionType"],
          agentName: activity.namedAgentName || `Agent ${activity.id.slice(0, 6)}`,
          provider: activity.provider,
          startedAt: activity.startedAt,
        };
      }

      return map;
    },
    [activities]
  );
  const runningEpicIds = useMemo(
    () =>
      new Set(
        activities
          .filter(
            (session) =>
              session.status === "running" &&
              session.epicId &&
              ["build", "review", "merge"].includes(session.type)
          )
          .map((session) => session.epicId as string)
      ),
    [activities]
  );
  const activeDetailTicketId = getActiveDetailTicketId(batch.selectedTicketIds);

  function handlePrimaryTicketClick(epicId: string) {
    batch.setSelectedTicketIds(selectOnlyTicket(epicId));
  }

  function handleCloseDetailPanel() {
    batch.clear();
  }

  useEffect(() => {
    if (!highlightedActivityId) return;
    if (!activities.some((activity) => activity.id === highlightedActivityId)) {
      setHighlightedActivityId(null);
    }
  }, [activities, highlightedActivityId]);

  // Refresh board when layout triggers a sync from arji.json
  useEffect(() => {
    const onSynced = () => setRefreshTrigger((t) => t + 1);
    window.addEventListener("arji:synced", onSynced);
    return () => window.removeEventListener("arji:synced", onSynced);
  }, []);

  const addToast = useCallback((
    type: "success" | "error" | "warning",
    message: string,
    action?: { href: string; label?: string }
  ) => {
    const id = Date.now().toString();
    setToasts((t) => [
      ...t,
      {
        id,
        type,
        message,
        href: action?.href,
        actionLabel: action?.label || "Open session",
      },
    ]);
    setTimeout(() => {
      setToasts((t) => t.filter((toast) => toast.id !== id));
    }, 5000);
  }, []);

  /**
   * A refinement pass reshapes columns, priorities and dependency edges
   * without emitting one event per write, so the board is reloaded once when
   * the pass ends rather than trusting the incremental SSE stream.
   */
  const handleRefinementFinished = useCallback(() => {
    setRefreshTrigger((t) => t + 1);
    addToast("success", "Board refinement finished — see the notification for the summary");
  }, [addToast]);

  const handleRetryBuild = useCallback(async (epicId: string) => {
    try {
      const res = await fetch(`/api/projects/${projectId}/build`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          epicIds: [epicId],
          mode: "parallel",
          namedAgentId,
        }),
      });

      const data = await res.json();
      if (!res.ok || data.error) {
        addToast("error", data.error || "Failed to retry build");
      } else {
        addToast("success", `Retrying build for epic`);
        setRefreshTrigger((t) => t + 1);
      }
    } catch {
      addToast("error", "Failed to retry build");
    }
  }, [projectId, namedAgentId, addToast]);

  useEffect(() => {
    const deleted = searchParams.get("deleted");
    if (!deleted) return;

    if (deleted === "story") {
      addToast("success", "User story deleted permanently");
    } else if (deleted === "epic") {
      addToast("success", "Epic deleted permanently");
    }

    const next = new URLSearchParams(searchParams.toString());
    next.delete("deleted");
    const query = next.toString();
    router.replace(query ? `/projects/${projectId}?${query}` : `/projects/${projectId}`);
  }, [addToast, projectId, router, searchParams]);

  // Deep link: /projects/<id>?ticket=<epicId> opens the ticket detail
  // (used by "Agent asked a question" notifications), then strips the param.
  useEffect(() => {
    const ticket = searchParams.get("ticket");
    if (!ticket) return;

    batch.setSelectedTicketIds(selectOnlyTicket(ticket));

    const next = new URLSearchParams(searchParams.toString());
    next.delete("ticket");
    const query = next.toString();
    router.replace(query ? `/projects/${projectId}?${query}` : `/projects/${projectId}`);
  }, [batch.setSelectedTicketIds, projectId, router, searchParams]);

  // Header actions live in the project chrome (a layout that outlives this
  // page), so they reach the board through the URL rather than through a
  // shared event bus: ?panel=chat|new-epic|new-bug, stripped once handled.
  // Consumed once per value: opening the chat is an imperative act, and the
  // ref keeps a re-render (or a replace() that has not landed yet) from
  // firing it a second time or re-opening a dialog the user just closed.
  const handledPanelParam = useRef<string | null>(null);
  const handledNightParam = useRef<string | null>(null);

  useEffect(() => {
    const panel = searchParams.get("panel");
    if (!panel) {
      handledPanelParam.current = null;
      return;
    }
    if (handledPanelParam.current === panel) return;
    handledPanelParam.current = panel;

    if (panel === "chat") {
      panelRef.current?.openChat();
    } else if (panel === "new-epic") {
      panelRef.current?.openNewEpic();
    } else if (panel === "new-epic-manual") {
      setEpicDialogOpen(true);
    } else if (panel === "new-bug") {
      setBugDialogOpen(true);
    }

    const next = new URLSearchParams(searchParams.toString());
    next.delete("panel");
    const query = next.toString();
    router.replace(query ? `/projects/${projectId}?${query}` : `/projects/${projectId}`);
  }, [projectId, router, searchParams]);

  // Same mechanism for the header's Night run button: ?night=start.
  useEffect(() => {
    const night = searchParams.get("night");
    if (night !== "start") {
      handledNightParam.current = null;
      return;
    }
    if (handledNightParam.current === night) return;
    handledNightParam.current = night;

    setNightDialogOpen(true);

    const next = new URLSearchParams(searchParams.toString());
    next.delete("night");
    const query = next.toString();
    router.replace(query ? `/projects/${projectId}?${query}` : `/projects/${projectId}`);
  }, [projectId, router, searchParams]);

  // Deep link: /projects/<id>?nightRun=<runId> opens the morning summary
  // (used by the "Night run finished" notification), then strips the param.
  useEffect(() => {
    const nightRun = searchParams.get("nightRun");
    if (!nightRun) return;

    setNightSummaryRunId(nightRun);

    const next = new URLSearchParams(searchParams.toString());
    next.delete("nightRun");
    const query = next.toString();
    router.replace(query ? `/projects/${projectId}?${query}` : `/projects/${projectId}`);
  }, [projectId, router, searchParams]);

  // Reset team mode when selection drops below 2
  useEffect(() => {
    if (batch.allSelected.size < 2) {
      setTeamMode(false);
    }
  }, [batch.allSelected.size]);

  // Detect session completions for notifications + board refresh
  useEffect(() => {
    const currentIds = new Set(activities.map((a) => a.id));
    let hasCompleted = false;
    for (const prevId of prevSessionIds.current) {
      if (!currentIds.has(prevId)) {
        hasCompleted = true;
        fetch(`/api/projects/${projectId}/sessions/${prevId}`)
          .then((r) => r.json())
          .then((d) => {
            if (d.data) {
              const s = d.data;
              if (s.status === "completed") {
                addToast("success", `Agent #${prevId.slice(0, 6)} completed`);
              } else if (s.status === "failed") {
                addToast(
                  "error",
                  `Agent #${prevId.slice(0, 6)} failed: ${s.error || "Unknown error"}`
                );
              }
            }
          })
          .catch(() => {});
      }
    }
    if (hasCompleted) {
      setRefreshTrigger((t) => t + 1);
    }
    prevSessionIds.current = currentIds;
  }, [activities, projectId]);

  async function handleBuild() {
    if (batch.allSelected.size === 0) return;
    setBuilding(true);

    try {
      const res = await fetch(`/api/projects/${projectId}/build`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          epicIds: Array.from(batch.allSelected),
          mode: buildMode,
          team: teamMode,
          namedAgentId,
        }),
      });

      const data = await res.json();
      if (!res.ok || data.error) {
        if (
          res.status === 409 &&
          data.code === "AGENT_ALREADY_RUNNING" &&
          data.data?.activeSessionId
        ) {
          addToast("error", data.error, {
            href:
              data.data.sessionUrl ||
              `/projects/${projectId}/sessions/${data.data.activeSessionId}`,
            label: "Open active session",
          });
        } else {
          addToast("error", data.error || "Failed to launch build");
        }
      } else {
        addToast(
          "success",
          teamMode
            ? `Launched team build session coordinating ${batch.allSelected.size} epics`
            : data.data.orchestrationMode === "dag"
              ? `Launched wave 1/${data.data.waves} — later waves start as dependencies finish`
              : `Launched ${data.data.count} build session${data.data.count > 1 ? "s" : ""}`
        );
        batch.clear();
        setRefreshTrigger((t) => t + 1);
      }
    } catch {
      addToast("error", "Failed to launch build");
    }

    setBuilding(false);
  }

  async function handleBatchReview() {
    if (batch.allSelected.size === 0) return;
    setReviewing(true);

    let launched = 0;
    for (const epicId of batch.allSelected) {
      try {
        const res = await fetch(
          `/api/projects/${projectId}/epics/${epicId}/review`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              reviewTypes: ["code_review"],
              namedAgentId,
            }),
          }
        );
        if (res.ok) launched++;
      } catch {
        // continue with other epics
      }
    }

    if (launched > 0) {
      addToast("success", `Launched review for ${launched} epic${launched > 1 ? "s" : ""}`);
      batch.clear();
      setRefreshTrigger((t) => t + 1);
    } else {
      addToast("error", "Failed to launch any reviews");
    }
    setReviewing(false);
  }

  async function handleBatchMerge() {
    if (batch.allSelected.size === 0) return;
    setBatchMerging(true);

    let merged = 0;
    let failed = 0;
    let agentLaunched = 0;
    for (const epicId of batch.allSelected) {
      try {
        const res = await fetch(
          `/api/projects/${projectId}/epics/${epicId}/merge`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ autoAgent: autoMergeAgent }),
          }
        );
        if (res.ok) {
          const data = await res.json();
          if (data.data?.autoAgent) {
            agentLaunched++;
          } else {
            merged++;
          }
        } else {
          failed++;
        }
      } catch {
        failed++;
      }
    }

    if (merged > 0) {
      addToast("success", `Merged ${merged} epic${merged > 1 ? "s" : ""}`);
    }
    if (agentLaunched > 0) {
      addToast(
        "success",
        `Launched merge-fix agent for ${agentLaunched} epic${agentLaunched > 1 ? "s" : ""}`
      );
    }
    if (failed > 0) {
      addToast("error", `${failed} merge${failed > 1 ? "s" : ""} failed`);
    }
    batch.clear();
    setRefreshTrigger((t) => t + 1);
    setBatchMerging(false);
  }

  const totalSelected = batch.allSelected.size;
  const autoCount = batch.autoIncluded.size;
  const canTeamMode = totalSelected >= 2;

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-hidden">
        <UnifiedChatPanel
          projectId={projectId}
          ref={panelRef}
          onEpicCreated={() => setRefreshTrigger((t) => t + 1)}
          onExpandedChange={setPanelOpen}
          sharedPanelView={
            activeDetailTicketId
              ? {
                  panelId: activeDetailTicketId,
                  label: "Ticket",
                  onClose: handleCloseDetailPanel,
                  content: (
                    <EpicDetail
                      projectId={projectId}
                      epicId={activeDetailTicketId}
                      open
                      refreshTrigger={refreshTrigger}
                      onClose={handleCloseDetailPanel}
                      onAgentConflict={({ message, sessionUrl }) =>
                        addToast(
                          "error",
                          message,
                          sessionUrl
                            ? { href: sessionUrl, label: "Open active session" }
                            : undefined
                        )
                      }
                      onMerged={() => {
                        setRefreshTrigger((t) => t + 1);
                        addToast("success", "Branch merged into main");
                      }}
                      onDeleted={() => {
                        setRefreshTrigger((t) => t + 1);
                        addToast("success", "Epic deleted permanently");
                      }}
                    />
                  ),
                }
              : null
          }
        >
          <div className="flex h-full flex-col">
            {/* Quick capture bar */}
            <div
              className="flex h-[46px] shrink-0 items-center gap-[12px] border-b border-border bg-card px-[22px]"
              data-testid="board-capture-bar"
            >
              <Plus className="h-[13px] w-[13px] shrink-0 text-meta" aria-hidden />
              <div className="flex max-w-[420px] flex-1 items-center">
                <QuickCapture
                  projectId={projectId}
                  onCreated={() => setRefreshTrigger((t) => t + 1)}
                  onError={(message) => addToast("error", message)}
                />
              </div>
              <AutoModeToggle
                projectId={projectId}
                onOpen={() => setAutoModeDialogOpen(true)}
                refreshTrigger={refreshTrigger}
              />
              <RefinementButton
                projectId={projectId}
                refreshTrigger={refreshTrigger}
                onError={(message) => addToast("error", message)}
                onStarted={() =>
                  addToast(
                    "success",
                    "Agent Refinement started — re-passing Backlog and To do"
                  )
                }
                onFinished={handleRefinementFinished}
              />
              <span className="ml-auto truncate text-[12.5px] text-muted-foreground">
                {visibleCount} ticket{visibleCount === 1 ? "" : "s"} visible
                {panelOpen && " · Released returns when the panel closes"}
              </span>
            </div>

            {/* Batch action toolbar */}
            {totalSelected > 0 && (
              <div className="flex min-h-[48px] shrink-0 flex-wrap items-center gap-[10px] border-b border-border bg-card px-[22px] py-[8px]">
                <span className="text-[13px] font-medium">
                  {batch.userSelected.size} epic{batch.userSelected.size > 1 ? "s" : ""} selected
                  {autoCount > 0 && (
                    <span className="ml-[8px] font-normal text-agent">
                      +{autoCount} required
                    </span>
                  )}
                </span>

                <NamedAgentSelect
                  value={namedAgentId}
                  onChange={setNamedAgentId}
                  dispatchRole="build"
                />

                <Select
                  value={buildMode}
                  onValueChange={(v) =>
                    setBuildMode(v as "parallel" | "sequential" | "dag")
                  }
                >
                  <SelectTrigger className="h-[29px] w-32 rounded-[7px] text-[12.5px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="parallel">Parallel</SelectItem>
                    <SelectItem value="sequential">Sequential</SelectItem>
                    <SelectItem value="dag">Waves (DAG)</SelectItem>
                  </SelectContent>
                </Select>

                {/* Waves mode explainer — visible only when selected */}
                {buildMode === "dag" && (
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span
                          data-testid="dag-mode-hint"
                          className="flex cursor-help items-center gap-1 text-[12.5px] text-meta"
                        >
                          <Layers className="h-3 w-3" />
                          Waves
                        </span>
                      </TooltipTrigger>
                      <TooltipContent>
                        Dependencies build first: epics run in dependency
                        waves, each wave waiting for the previous one. A
                        failed epic (or one that asks a question) skips its
                        dependents.
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                )}

                {/* Team mode checkbox — visible when 2+ epics selected */}
                {totalSelected >= 2 && (
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <label
                          className={cn(
                            "flex cursor-pointer items-center gap-1.5 text-[12.5px]",
                            !canTeamMode && "cursor-not-allowed opacity-50"
                          )}
                        >
                          <input
                            type="checkbox"
                            checked={teamMode}
                            onChange={(e) => setTeamMode(e.target.checked)}
                            disabled={!canTeamMode}
                            className="h-3.5 w-3.5 rounded border-border"
                          />
                          <Users className="h-3 w-3" />
                          Team mode
                        </label>
                      </TooltipTrigger>
                      <TooltipContent>
                        {"Launch a single CC session that coordinates sub-agents for each epic"}
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                )}

                {/* Merge auto-fix — sits with its Merge all button on the right */}
                {totalSelected >= 2 && (
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <label className="flex cursor-pointer items-center gap-1.5 text-[12.5px]">
                          <input
                            type="checkbox"
                            checked={autoMergeAgent}
                            onChange={(e) => setAutoMergeAgent(e.target.checked)}
                            className="h-3.5 w-3.5 rounded border-border"
                            data-testid="auto-merge-agent-checkbox"
                          />
                          <Bot className="h-3 w-3" />
                          Auto-fix
                        </label>
                      </TooltipTrigger>
                      <TooltipContent>
                        When a merge fails, automatically launch an agent to resolve conflicts
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                )}

                <div className="ml-auto flex flex-wrap items-center gap-[8px]">
                  <Button
                    size="sm"
                    onClick={handleBuild}
                    disabled={building}
                    className="h-[29px] rounded-[7px] text-[12.5px]"
                  >
                    {building ? (
                      <Loader2 className="h-3 w-3 animate-spin mr-1 motion-reduce:animate-none" />
                    ) : teamMode ? (
                      <Users className="h-3 w-3 mr-1" />
                    ) : (
                      <Hammer className="h-3 w-3 mr-1" />
                    )}
                    {teamMode ? "Build as Team" : "Build all"}
                  </Button>

                  {/* Review all — appears when multiple selected */}
                  {totalSelected >= 2 && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={handleBatchReview}
                      disabled={reviewing}
                      className="h-[29px] rounded-[7px] text-[12.5px]"
                    >
                      {reviewing ? (
                        <Loader2 className="h-3 w-3 animate-spin mr-1 motion-reduce:animate-none" />
                      ) : (
                        <Search className="h-3 w-3 mr-1" />
                      )}
                      Review all
                    </Button>
                  )}

                  {/* Merge all — appears when multiple selected */}
                  {totalSelected >= 2 && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={handleBatchMerge}
                      disabled={batchMerging}
                      className="h-[29px] rounded-[7px] text-[12.5px]"
                    >
                      {batchMerging ? (
                        <Loader2 className="h-3 w-3 animate-spin mr-1 motion-reduce:animate-none" />
                      ) : (
                        <GitMerge className="h-3 w-3 mr-1" />
                      )}
                      Merge all
                    </Button>
                  )}

                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={batch.clear}
                    className="h-[29px] rounded-[7px] text-[12.5px] text-meta"
                  >
                    Clear
                  </Button>
                </div>
              </div>
            )}

            <div className="flex-1 overflow-hidden relative">
              {sseStatus !== "connected" && (
                <div
                  className="absolute top-[10px] right-[10px] z-10 flex items-center gap-1.5 rounded-full border border-border bg-card px-[10px] py-[3px] text-[11.5px] text-muted-foreground"
                  title={sseStatus === "connecting" ? "Connecting to real-time updates..." : "Offline — reconnecting..."}
                >
                  <span
                    className={cn(
                      "h-2 w-2 rounded-full",
                      sseStatus === "connecting"
                        ? "bg-priority-yellow animate-pulse motion-reduce:animate-none"
                        : "bg-destructive"
                    )}
                  />
                  {sseStatus === "connecting" ? "Connecting..." : "Offline"}
                </div>
              )}
              <Board
                projectId={projectId}
                onEpicClick={handlePrimaryTicketClick}
                selectedEpics={batch.allSelected}
                autoIncludedEpics={batch.autoIncluded}
                onToggleSelect={batch.toggle}
                refreshTrigger={refreshTrigger}
                runningEpicIds={runningEpicIds}
                activeAgentActivities={activeAgentActivities}
                onLinkedAgentHoverChange={setHighlightedActivityId}
                onMoveError={(error) => addToast("error", error)}
                onMoveWarning={(message) => addToast("warning", message)}
                failedSessions={failedSessions}
                onRetryBuild={handleRetryBuild}
                hideReleased={panelOpen}
                onVisibleCountChange={setVisibleCount}
              />
            </div>

            {/* Agent monitor bar */}
            <AgentMonitor
              projectId={projectId}
              activities={activities}
              highlightedActivityId={highlightedActivityId}
            />
          </div>
        </UnifiedChatPanel>
      </div>

      {/* Toast notifications */}
      <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={cn(
              "flex items-center gap-2 rounded-[11px] border px-[14px] py-[10px] text-[13px] shadow-[0_18px_40px_rgba(58,48,44,.14)]",
              toast.type === "success"
                ? "border-agent-border bg-agent-bg text-agent"
                : toast.type === "warning"
                  ? "border-amber-500/40 bg-card text-amber-600 dark:text-amber-400"
                  : "border-destructive/40 bg-card text-destructive"
            )}
          >
            {toast.type === "success" ? (
              <CheckCircle2 className="h-4 w-4" />
            ) : toast.type === "warning" ? (
              <TriangleAlert className="h-4 w-4" />
            ) : (
              <XCircle className="h-4 w-4" />
            )}
            <span>{toast.message}</span>
            {toast.href && (
              <a href={toast.href} className="underline text-xs whitespace-nowrap">
                {toast.actionLabel || "Open session"}
              </a>
            )}
            <button
              onClick={() =>
                setToasts((t) => t.filter((x) => x.id !== toast.id))
              }
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        ))}
      </div>

      <EpicCreateDialog
        projectId={projectId}
        open={epicDialogOpen}
        onOpenChange={setEpicDialogOpen}
        onCreated={() => {
          setRefreshTrigger((t) => t + 1);
          addToast("success", "Epic created");
        }}
      />

      <BugCreateDialog
        projectId={projectId}
        open={bugDialogOpen}
        onOpenChange={setBugDialogOpen}
        onCreated={() => setRefreshTrigger((t) => t + 1)}
        namedAgentId={namedAgentId}
      />

      <NightRunDialog
        projectId={projectId}
        open={nightDialogOpen}
        onOpenChange={setNightDialogOpen}
        defaultNamedAgentId={namedAgentId}
        onStarted={(result) => {
          addToast("success", result.message);
          setRefreshTrigger((t) => t + 1);
        }}
        onError={(message) => addToast("error", message)}
      />

      <AutoModeDialog
        projectId={projectId}
        open={autoModeDialogOpen}
        onOpenChange={setAutoModeDialogOpen}
        defaultNamedAgentId={namedAgentId}
        onSaved={(status) => {
          addToast(
            "success",
            status.enabled
              ? `Full Auto Mode is on — ${status.candidates.build} to build, ${status.candidates.review} to review`
              : "Full Auto Mode is off"
          );
          setRefreshTrigger((t) => t + 1);
        }}
        onError={(message) => addToast("error", message)}
      />

      <NightRunSummaryDialog
        projectId={projectId}
        runId={nightSummaryRunId}
        open={nightSummaryRunId !== null}
        onOpenChange={(open) => {
          if (!open) setNightSummaryRunId(null);
        }}
      />

    </div>
  );
}
