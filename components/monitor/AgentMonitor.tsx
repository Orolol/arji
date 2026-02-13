"use client";

import { useState, useEffect } from "react";
import {
  Hammer,
  Search,
  GitMerge,
  MessageSquare,
  Sparkles,
  FileText,
  StopCircle,
  ChevronUp,
  ChevronDown,
  Loader2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import type { UnifiedActivity } from "@/hooks/useAgentPolling";

interface AgentMonitorProps {
  projectId: string;
  activities: UnifiedActivity[];
}

const typeIcons: Record<UnifiedActivity["type"], typeof Hammer> = {
  build: Hammer,
  review: Search,
  merge: GitMerge,
  chat: MessageSquare,
  spec_generation: Sparkles,
  release: FileText,
};

export function AgentMonitor({ projectId, activities }: AgentMonitorProps) {
  const [expanded, setExpanded] = useState(true);
  const [elapsed, setElapsed] = useState<Record<string, string>>({});

  useEffect(() => {
    if (activities.length === 0) return;

    function updateElapsed() {
      const now = Date.now();
      const newElapsed: Record<string, string> = {};
      for (const a of activities) {
        if (a.startedAt) {
          const seconds = Math.floor(
            (now - new Date(a.startedAt).getTime()) / 1000
          );
          const mins = Math.floor(seconds / 60);
          const secs = seconds % 60;
          newElapsed[a.id] =
            mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
        }
      }
      setElapsed(newElapsed);
    }

    updateElapsed();
    const interval = setInterval(updateElapsed, 1000);
    return () => clearInterval(interval);
  }, [activities]);

  if (activities.length === 0) return null;

  async function handleCancel(activityId: string) {
    await fetch(`/api/projects/${projectId}/sessions/${activityId}`, {
      method: "DELETE",
    });
  }

  return (
    <div className="border-t border-border bg-muted/30">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full px-4 py-1.5 flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground"
      >
        <span className="relative flex h-2 w-2">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
          <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500" />
        </span>
        <span className="font-medium">
          {activities.length} active agent{activities.length > 1 ? "s" : ""}
        </span>
        {expanded ? (
          <ChevronDown className="h-3 w-3 ml-auto" />
        ) : (
          <ChevronUp className="h-3 w-3 ml-auto" />
        )}
      </button>

      {expanded && (
        <div className="px-4 pb-2 space-y-1">
          {activities.map((activity) => {
            const Icon = typeIcons[activity.type] || Loader2;
            return (
              <div
                key={activity.id}
                className="flex items-center gap-2 text-xs py-1"
              >
                <Icon className="h-3 w-3 text-green-500 shrink-0" />
                <span className="truncate">{activity.label}</span>
                <span className="text-muted-foreground text-[10px] font-medium uppercase tracking-wide shrink-0">
                  {activity.provider === "codex" ? "Codex" : "CC"}
                </span>
                <span className="text-muted-foreground font-mono shrink-0">
                  {elapsed[activity.id] || "0s"}
                </span>
                {activity.cancellable && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-5 w-5 ml-auto shrink-0 text-muted-foreground hover:text-destructive"
                    onClick={() => handleCancel(activity.id)}
                    title="Cancel"
                  >
                    <StopCircle className="h-3 w-3" />
                  </Button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
