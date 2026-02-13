"use client";

import { useState, useEffect, useRef, useMemo } from "react";
import { useParams } from "next/navigation";
import { Board } from "@/components/kanban/Board";
import { EpicDetail } from "@/components/kanban/EpicDetail";
import { UnifiedChatPanel, type UnifiedChatPanelHandle } from "@/components/chat/UnifiedChatPanel";
import { AgentMonitor } from "@/components/monitor/AgentMonitor";
import { useAgentPolling } from "@/hooks/useAgentPolling";
import { useCodexAvailable } from "@/hooks/useCodexAvailable";
import { ProviderSelect, type ProviderType } from "@/components/shared/ProviderSelect";
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
import { Hammer, Loader2, X, CheckCircle2, XCircle, Plus, Users, MessageSquare, Bug } from "lucide-react";
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
  const projectId = params.projectId as string;
  const [selectedEpicId, setSelectedEpicId] = useState<string | null>(null);
  const [selectedEpics, setSelectedEpics] = useState<Set<string>>(new Set());
  const [buildMode, setBuildMode] = useState<"parallel" | "sequential">(
    "parallel"
  );
  const [teamMode, setTeamMode] = useState(false);
  const [provider, setProvider] = useState<ProviderType>("claude-code");
  const [building, setBuilding] = useState(false);
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const [bugDialogOpen, setBugDialogOpen] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [highlightedActivityId, setHighlightedActivityId] = useState<string | null>(null);
  const { activities } = useAgentPolling(projectId);
  const { codexAvailable, codexInstalled } = useCodexAvailable();
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
          agentName:
            activity.provider === "codex"
              ? `Codex agent ${activity.id.slice(0, 6)}`
              : `Claude Code agent ${activity.id.slice(0, 6)}`,
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

  function addToast(
    type: "success" | "error",
    message: string,
    action?: { href: string; label?: string }
  ) {
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
  }

  // Reset team mode when selection drops below 2 or provider changes to codex
  useEffect(() => {
    if (selectedEpics.size < 2 || provider === "codex") {
      setTeamMode(false);
    }
  }, [selectedEpics.size, provider]);

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

  function toggleEpicSelection(epicId: string) {
    setSelectedEpics((prev) => {
      const next = new Set(prev);
      if (next.has(epicId)) {
        next.delete(epicId);
      } else {
        next.add(epicId);
      }
      return next;
    });
  }

  async function handleBuild() {
    if (selectedEpics.size === 0) return;
    setBuilding(true);

    try {
      const res = await fetch(`/api/projects/${projectId}/build`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          epicIds: Array.from(selectedEpics),
          mode: buildMode,
          team: teamMode,
          provider,
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
            ? `Launched team build session coordinating ${selectedEpics.size} epics`
            : `Launched ${data.data.count} build session${data.data.count > 1 ? "s" : ""}`
        );
        setSelectedEpics(new Set());
        setRefreshTrigger((t) => t + 1);
      }
    } catch {
      addToast("error", "Failed to launch build");
    }

    setBuilding(false);
  }

  const canTeamMode = selectedEpics.size >= 2 && provider === "claude-code";

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

            {/* Build toolbar */}
            {selectedEpics.size > 0 && (
              <div className="border-b border-border px-4 py-2 bg-muted/30 flex items-center gap-3 flex-wrap">
                <span className="text-sm">
                  {selectedEpics.size} epic{selectedEpics.size > 1 ? "s" : ""}{" "}
                  selected
                </span>

                <ProviderSelect
                  value={provider}
                  onChange={setProvider}
                  codexAvailable={codexAvailable}
                  codexInstalled={codexInstalled}
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
                {selectedEpics.size >= 2 && (
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
                        {provider === "codex"
                          ? "Team mode is only available with Claude Code"
                          : "Launch a single CC session that coordinates sub-agents for each epic"}
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
                  {teamMode ? "Build as Team" : `Build with ${provider === "codex" ? "Codex" : "Claude Code"}`}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setSelectedEpics(new Set())}
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
                selectedEpics={selectedEpics}
                onToggleSelect={toggleEpicSelection}
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

      />

    </div>
  );
}
