"use client";

import { useState, useEffect } from "react";
import { Loader2, StopCircle, ChevronUp, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";

interface ActiveSession {
  id: string;
  epicId: string | null;
  status: string;
  mode: string;
  provider: string | null;
  startedAt: string | null;
  lastNonEmptyText?: string | null;
}

interface AgentMonitorProps {
  projectId: string;
  sessions: ActiveSession[];
}

export function AgentMonitor({ projectId, sessions }: AgentMonitorProps) {
  const [expanded, setExpanded] = useState(true);
  const [elapsed, setElapsed] = useState<Record<string, string>>({});

  // Update elapsed time every second
  useEffect(() => {
    if (sessions.length === 0) return;

    function updateElapsed() {
      const now = Date.now();
      const newElapsed: Record<string, string> = {};
      for (const s of sessions) {
        if (s.startedAt) {
          const seconds = Math.floor(
            (now - new Date(s.startedAt).getTime()) / 1000
          );
          const mins = Math.floor(seconds / 60);
          const secs = seconds % 60;
          newElapsed[s.id] =
            mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
        }
      }
      setElapsed(newElapsed);
    }

    updateElapsed();
    const interval = setInterval(updateElapsed, 1000);
    return () => clearInterval(interval);
  }, [sessions]);

  if (sessions.length === 0) return null;

  async function handleCancel(sessionId: string) {
    await fetch(`/api/projects/${projectId}/sessions/${sessionId}`, {
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
          {sessions.length} active agent{sessions.length > 1 ? "s" : ""}
        </span>
        {expanded ? (
          <ChevronDown className="h-3 w-3 ml-auto" />
        ) : (
          <ChevronUp className="h-3 w-3 ml-auto" />
        )}
      </button>

      {expanded && (
        <div className="px-4 pb-2 space-y-1">
          {sessions.map((session) => (
            <div
              key={session.id}
              className="flex items-center gap-2 text-xs py-1"
            >
              <Loader2 className="h-3 w-3 animate-spin text-green-500 shrink-0" />
              <span className="text-muted-foreground">
                #{session.id.slice(0, 6)}
              </span>
              <span className="inline-flex items-center gap-1">
                <span className="text-muted-foreground text-[10px] font-medium uppercase tracking-wide">
                  {session.provider === "codex" ? "Codex" : "CC"}
                </span>
                {session.mode}
              </span>
              <span className="text-muted-foreground font-mono">
                {elapsed[session.id] || "0s"}
              </span>
              {session.lastNonEmptyText && (
                <span className="text-muted-foreground truncate max-w-56">
                  {session.lastNonEmptyText}
                </span>
              )}
              <Button
                variant="ghost"
                size="icon"
                className="h-5 w-5 ml-auto shrink-0 text-muted-foreground hover:text-destructive"
                onClick={() => handleCancel(session.id)}
                title="Cancel"
              >
                <StopCircle className="h-3 w-3" />
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
