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
import { Hammer, Loader2, X, CheckCircle2, XCircle, Plus, Users, MessageSquare, Bug, Search, GitMerge, Lock, Bot } from "lucide-react";
import { BugCreateDialog } from "@/components/kanban/BugCreateDialog";
import type { KanbanEpicAgentActivity } from "@/lib/types/kanban";

interface Toast {
  id: string;
  type: "success" | "error";
  message: string;
  href?: string;
  actionLabel?: string;
}

export default function KanbanPage() {
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const projectId = params.projectId as string;
  const [selectedEpicId, setSelectedEpicId] = useState<string | null>(null);
  const batch = useBatchSelection(projectId);
  const [buildMode, setBuildMode] = useState<"parallel" | "sequential">(
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
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [highlightedActivityId, setHighlightedActivityId] = useState<string | null>(null);
  const { activities } = useAgentPolling(projectId);
  const prevSessionIds = useRef<Set<string>>(new Set());
  const panelRef = useRef<UnifiedChatPanelHandle>(null);
  const activeAgentActivities = useMemo<Record<string, KanbanEpicAgentActivity>>(
    () => {
      const map: Record<string, KanbanEpicAgentActivity> = {};

      for (const activity of activities) {
        if (!activity.epicId) continue;
        if (!["build", "review", "merge"].includes(activity.type)) continue;

        map[activity.epicId] = {
          sessionId: activity.id,
          actionType: activity.type as KanbanEpicAgentActivity["actionType"],
          agentName: `Agent ${activity.id.slice(0, 6)}`,
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
    type: "success" | "error",
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
        >
          <div className="flex h-full flex-col">
            {/* Header bar */}
            <div className="border-b border-border px-4 py-2 flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => panelRef.current?.openChat()}
                className="h-7 text-xs"
              >
                <MessageSquare className="h-3 w-3 mr-1" />
                Chat
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => panelRef.current?.openNewEpic()}
                className="h-7 text-xs"
              >
                <Plus className="h-3 w-3 mr-1" />
                New Epic
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setBugDialogOpen(true)}
                className="h-7 text-xs text-red-400 border-red-400/30 hover:bg-red-400/10"
              >
                <Bug className="h-3 w-3 mr-1" />
                New Bug
              </Button>
            </div>

            {/* Batch action toolbar */}
            {totalSelected > 0 && (
              <div className="border-b border-border px-4 py-2 bg-muted/30 flex items-center gap-3 flex-wrap">
                <span className="text-sm">
                  {batch.userSelected.size} epic{batch.userSelected.size > 1 ? "s" : ""} selected
                  {autoCount > 0 && (
                    <span className="text-amber-500 ml-1">
                      <Lock className="h-3 w-3 inline mr-0.5" />
                      +{autoCount} required
                    </span>
                  )}
                </span>

                <NamedAgentSelect
                  value={namedAgentId}
                  onChange={setNamedAgentId}
                />

                <Select
                  value={buildMode}
                  onValueChange={(v) =>
                    setBuildMode(v as "parallel" | "sequential")
                  }
                >
                  <SelectTrigger className="w-32 h-7 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="parallel">Parallel</SelectItem>
                    <SelectItem value="sequential">Sequential</SelectItem>
                  </SelectContent>
                </Select>

                {/* Team mode checkbox — visible when 2+ epics selected */}
                {totalSelected >= 2 && (
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <label
                          className={`flex items-center gap-1.5 text-xs cursor-pointer ${
                            !canTeamMode ? "opacity-50 cursor-not-allowed" : ""
                          }`}
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

                <Button
                  size="sm"
                  onClick={handleBuild}
                  disabled={building}
                  className="h-7 text-xs"
                >
                  {building ? (
                    <Loader2 className="h-3 w-3 animate-spin mr-1" />
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
                    className="h-7 text-xs"
                  >
                    {reviewing ? (
                      <Loader2 className="h-3 w-3 animate-spin mr-1" />
                    ) : (
                      <Search className="h-3 w-3 mr-1" />
                    )}
                    Review all
                  </Button>
                )}

                {/* Merge all — appears when multiple selected */}
                {totalSelected >= 2 && (
                  <>
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <label className="flex items-center gap-1.5 text-xs cursor-pointer">
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
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={handleBatchMerge}
                      disabled={batchMerging}
                      className="h-7 text-xs"
                    >
                      {batchMerging ? (
                        <Loader2 className="h-3 w-3 animate-spin mr-1" />
                      ) : (
                        <GitMerge className="h-3 w-3 mr-1" />
                      )}
                      Merge all
                    </Button>
                  </>
                )}

                <Button
                  size="sm"
                  variant="ghost"
                  onClick={batch.clear}
                  className="h-7 text-xs"
                >
                  Clear
                </Button>
              </div>
            )}

            <div className="flex-1 overflow-hidden">
              <Board
                projectId={projectId}
                onEpicClick={(id) => setSelectedEpicId(id)}
                selectedEpics={batch.allSelected}
                autoIncludedEpics={batch.autoIncluded}
                onToggleSelect={batch.toggle}
                refreshTrigger={refreshTrigger}
                runningEpicIds={runningEpicIds}
                activeAgentActivities={activeAgentActivities}
                onLinkedAgentHoverChange={setHighlightedActivityId}
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
            className={`flex items-center gap-2 px-4 py-2 rounded-lg shadow-lg text-sm ${
              toast.type === "success"
                ? "bg-green-900/90 text-green-100"
                : "bg-red-900/90 text-red-100"
            }`}
          >
            {toast.type === "success" ? (
              <CheckCircle2 className="h-4 w-4" />
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

      <BugCreateDialog
        projectId={projectId}
        open={bugDialogOpen}
        onOpenChange={setBugDialogOpen}
        onCreated={() => setRefreshTrigger((t) => t + 1)}
        namedAgentId={namedAgentId}
      />

      <EpicDetail
        projectId={projectId}
        epicId={selectedEpicId}
        open={!!selectedEpicId}
        onClose={() => setSelectedEpicId(null)}
        onAgentConflict={({ message, sessionUrl }) =>
          addToast(
            "error",
            message,
            sessionUrl ? { href: sessionUrl, label: "Open active session" } : undefined
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

    </div>
  );
}
