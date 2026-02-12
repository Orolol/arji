"use client";

import { useState, useEffect, useRef } from "react";
import { useParams } from "next/navigation";
import { Board } from "@/components/kanban/Board";
import { EpicDetail } from "@/components/kanban/EpicDetail";
import { CreateEpicSheet } from "@/components/kanban/CreateEpicSheet";
import { AgentMonitor } from "@/components/monitor/AgentMonitor";
import { useAgentPolling } from "@/hooks/useAgentPolling";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Hammer, Loader2, X, CheckCircle2, XCircle, Plus } from "lucide-react";

interface Toast {
  id: string;
  type: "success" | "error";
  message: string;
}

export default function KanbanPage() {
  const params = useParams();
  const projectId = params.projectId as string;
  const [selectedEpicId, setSelectedEpicId] = useState<string | null>(null);
  const [selectedEpics, setSelectedEpics] = useState<Set<string>>(new Set());
  const [buildMode, setBuildMode] = useState<"parallel" | "sequential">(
    "parallel"
  );
  const [building, setBuilding] = useState(false);
  const [showCreateEpic, setShowCreateEpic] = useState(false);
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const { activeSessions } = useAgentPolling(projectId);
  const prevSessionIds = useRef<Set<string>>(new Set());

  // Detect session completions for notifications + board refresh
  useEffect(() => {
    const currentIds = new Set(activeSessions.map((s) => s.id));
    let hasCompleted = false;
    for (const prevId of prevSessionIds.current) {
      if (!currentIds.has(prevId)) {
        hasCompleted = true;
        // Session disappeared — fetch its status
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
    // Refresh the board when any session completes or fails
    if (hasCompleted) {
      setRefreshTrigger((t) => t + 1);
    }
    prevSessionIds.current = currentIds;
  }, [activeSessions, projectId]);

  function addToast(type: "success" | "error", message: string) {
    const id = Date.now().toString();
    setToasts((t) => [...t, { id, type, message }]);
    setTimeout(() => {
      setToasts((t) => t.filter((toast) => toast.id !== id));
    }, 5000);
  }

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
        }),
      });

      const data = await res.json();
      if (data.error) {
        addToast("error", data.error);
      } else {
        addToast(
          "success",
          `Launched ${data.data.count} build session${data.data.count > 1 ? "s" : ""}`
        );
        setSelectedEpics(new Set());
        setRefreshTrigger((t) => t + 1);
      }
    } catch {
      addToast("error", "Failed to launch build");
    }

    setBuilding(false);
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header bar */}
      <div className="border-b border-border px-4 py-2 flex items-center gap-3">
        <Button
          size="sm"
          variant="outline"
          onClick={() => setShowCreateEpic(true)}
          className="h-7 text-xs"
        >
          <Plus className="h-3 w-3 mr-1" />
          New Epic
        </Button>
      </div>

      {/* Build toolbar */}
      {selectedEpics.size > 0 && (
        <div className="border-b border-border px-4 py-2 bg-muted/30 flex items-center gap-3">
          <span className="text-sm">
            {selectedEpics.size} epic{selectedEpics.size > 1 ? "s" : ""}{" "}
            selected
          </span>
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
          <Button
            size="sm"
            onClick={handleBuild}
            disabled={building}
            className="h-7 text-xs"
          >
            {building ? (
              <Loader2 className="h-3 w-3 animate-spin mr-1" />
            ) : (
              <Hammer className="h-3 w-3 mr-1" />
            )}
            Build with Claude Code
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
        />
      </div>

      {/* Agent monitor bar */}
      <AgentMonitor projectId={projectId} sessions={activeSessions} />

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

      <EpicDetail
        projectId={projectId}
        epicId={selectedEpicId}
        open={!!selectedEpicId}
        onClose={() => setSelectedEpicId(null)}
        onMerged={() => {
          setRefreshTrigger((t) => t + 1);
          addToast("success", "Branch merged into main");
        }}
      />

      <CreateEpicSheet
        projectId={projectId}
        open={showCreateEpic}
        onClose={() => setShowCreateEpic(false)}
        onCreated={(epicId) => {
          setShowCreateEpic(false);
          setRefreshTrigger((t) => t + 1);
          addToast("success", `Epic created successfully`);
        }}
      />
    </div>
  );
}
