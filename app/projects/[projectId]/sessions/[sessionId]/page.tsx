"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  StopCircle,
  Download,
  RefreshCw,
  Clock,
  XCircle,
} from "lucide-react";

interface SessionDetail {
  id: string;
  status: string;
  mode: string;
  provider?: string;
  prompt?: string;
  error?: string;
  branchName?: string;
  worktreePath?: string;
  epicId?: string;
  startedAt?: string;
  endedAt?: string;
  completedAt?: string;
  createdAt: string;
  lastNonEmptyText?: string | null;
  claudeSessionId?: string | null;
  agentType?: string | null;
  logs?: {
    success?: boolean;
    result?: string;
    error?: string;
    duration?: number;
  };
}

const AGENT_TYPE_LABELS: Record<string, string> = {
  build: "Build",
  ticket_build: "Ticket Build",
  team_build: "Team Build",
  review_security: "Security Review",
  review_code: "Code Review",
  review_compliance: "Compliance Review",
  review_feature: "Feature Review",
  merge: "Merge",
};

/**
 * Contained scroll pane for monospace output content.
 * Fixed height, no horizontal spillover, preserves whitespace.
 */
function ScrollPane({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`max-h-[500px] overflow-y-auto overflow-x-hidden font-mono text-xs whitespace-pre-wrap break-words ${className}`}
    >
      {children}
    </div>
  );
}

export default function SessionDetailPage() {
  const params = useParams();
  const router = useRouter();
  const projectId = params.projectId as string;
  const sessionId = params.sessionId as string;
  const [session, setSession] = useState<SessionDetail | null>(null);
  const [loading, setLoading] = useState(true);

  async function loadSession() {
    const res = await fetch(
      `/api/projects/${projectId}/sessions/${sessionId}`
    );
    const data = await res.json();
    setSession(data.data);
    setLoading(false);
  }

  useEffect(() => {
    loadSession();
    // Poll if running
    const interval = setInterval(() => {
      loadSession();
    }, 3000);
    return () => clearInterval(interval);
  }, [projectId, sessionId]);

  async function handleCancel() {
    await fetch(`/api/projects/${projectId}/sessions/${sessionId}`, {
      method: "DELETE",
    });
    loadSession();
  }

  function handleExportLogs() {
    if (!session?.logs) return;
    const blob = new Blob([JSON.stringify(session.logs, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `session-${sessionId}-logs.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function getDuration(): string {
    if (!session?.startedAt) return "-";
    const start = new Date(session.startedAt).getTime();
    const endAt = session.endedAt || session.completedAt;
    const end = endAt
      ? new Date(endAt).getTime()
      : Date.now();
    const seconds = Math.floor((end - start) / 1000);
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    if (mins > 0) return `${mins}m ${secs}s`;
    return `${secs}s`;
  }

  if (loading || !session) {
    return <div className="p-6 text-muted-foreground">Loading...</div>;
  }

  return (
    <div className="p-6 max-w-4xl">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-xl font-bold">Session #{session.id.slice(0, 8)}</h2>
          <div className="flex items-center gap-2 mt-1">
            <Badge
              className={
                session.status === "completed"
                  ? "bg-green-500/10 text-green-500"
                  : session.status === "failed"
                    ? "bg-red-500/10 text-red-500"
                    : session.status === "running"
                      ? "bg-yellow-500/10 text-yellow-500"
                      : ""
              }
            >
              {session.status}
            </Badge>
            <Badge variant="outline">{session.mode}</Badge>
            {session.agentType && (
              <Badge variant="secondary" className="text-[10px]">
                {AGENT_TYPE_LABELS[session.agentType] || session.agentType}
              </Badge>
            )}
            {session.provider && (
              <Badge variant="outline" className="text-[10px] uppercase tracking-wide">
                {session.provider === "codex" ? "Codex" : "CC"}
              </Badge>
            )}
            {session.claudeSessionId && (
              <Badge variant="outline" className="text-[10px] text-blue-400 border-blue-400/30">
                resumable
              </Badge>
            )}
            <span className="text-sm text-muted-foreground flex items-center gap-1">
              <Clock className="h-3 w-3" />
              {getDuration()}
            </span>
          </div>
          {session.lastNonEmptyText && (
            <p className="mt-1 text-xs text-muted-foreground/70 font-mono truncate max-w-lg">
              {session.lastNonEmptyText}
            </p>
          )}
        </div>
        <div className="flex gap-2">
          {session.status === "running" && (
            <Button
              variant="destructive"
              size="sm"
              onClick={handleCancel}
            >
              <StopCircle className="h-4 w-4 mr-1" />
              Cancel
            </Button>
          )}
          {session.logs && (
            <Button variant="outline" size="sm" onClick={handleExportLogs}>
              <Download className="h-4 w-4 mr-1" />
              Export Logs
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={loadSession}>
            <RefreshCw className="h-4 w-4 mr-1" />
            Refresh
          </Button>
        </div>
      </div>

      {/* Metadata */}
      <div className="grid grid-cols-2 gap-4 mb-6">
        {session.branchName && (
          <Card className="p-3">
            <div className="text-xs text-muted-foreground">Branch</div>
            <div className="text-sm font-mono">{session.branchName}</div>
          </Card>
        )}
        {session.worktreePath && (
          <Card className="p-3">
            <div className="text-xs text-muted-foreground">Worktree</div>
            <div className="text-sm font-mono truncate">
              {session.worktreePath}
            </div>
          </Card>
        )}
        <Card className="p-3">
          <div className="text-xs text-muted-foreground">Started</div>
          <div className="text-sm">
            {session.startedAt
              ? new Date(session.startedAt).toLocaleString()
              : "-"}
          </div>
        </Card>
        <Card className="p-3">
          <div className="text-xs text-muted-foreground">Completed</div>
          <div className="text-sm">
            {session.endedAt || session.completedAt
              ? new Date(session.endedAt || session.completedAt || "").toLocaleString()
              : session.status === "running"
                ? "In progress..."
                : "-"}
          </div>
        </Card>
        {session.claudeSessionId && (
          <Card className="p-3 col-span-2">
            <div className="text-xs text-muted-foreground">CLI Session ID</div>
            <div className="text-sm font-mono text-blue-400 truncate">
              {session.claudeSessionId}
            </div>
          </Card>
        )}
      </div>

      {/* Error */}
      {session.error && (
        <Card className="p-4 mb-6 border-destructive/50">
          <div className="flex items-center gap-2 mb-2">
            <XCircle className="h-4 w-4 text-destructive" />
            <h3 className="text-sm font-medium text-destructive">Error</h3>
          </div>
          <ScrollPane className="max-h-[200px] text-destructive/80">
            {session.error}
          </ScrollPane>
        </Card>
      )}

      {/* Tabs: Response / Prompt / Raw Logs */}
      <Tabs defaultValue="response">
        <TabsList>
          <TabsTrigger value="response">Response</TabsTrigger>
          <TabsTrigger value="prompt">Prompt</TabsTrigger>
          <TabsTrigger value="raw">Raw Logs</TabsTrigger>
        </TabsList>

        <TabsContent value="response">
          <Card className="p-4 overflow-hidden">
            {session.logs?.result ? (
              <ScrollPane className="text-muted-foreground">
                {session.logs.result}
              </ScrollPane>
            ) : session.status === "running" ? (
              <p className="text-sm text-muted-foreground">
                Waiting for agent to respond...
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">
                No response available
              </p>
            )}
          </Card>
        </TabsContent>

        <TabsContent value="prompt">
          <Card className="p-4 overflow-hidden">
            {session.prompt ? (
              <ScrollPane className="text-muted-foreground">
                {session.prompt}
              </ScrollPane>
            ) : (
              <p className="text-sm text-muted-foreground">
                No prompt available
              </p>
            )}
          </Card>
        </TabsContent>

        <TabsContent value="raw">
          <Card className="p-4 overflow-hidden">
            {session.logs ? (
              <ScrollPane className="text-muted-foreground">
                {JSON.stringify(session.logs, null, 2)}
              </ScrollPane>
            ) : (
              <p className="text-sm text-muted-foreground">
                No logs available
              </p>
            )}
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
