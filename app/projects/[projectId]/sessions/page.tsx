"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import Link from "next/link";
import {
  Clock,
  Play,
  CheckCircle2,
  XCircle,
  Ban,
  Loader2,
} from "lucide-react";

interface Session {
  id: string;
  status: string;
  mode: string;
  epicId?: string;
  branchName?: string;
  startedAt?: string;
  endedAt?: string;
  completedAt?: string;
  lastNonEmptyText?: string;
  error?: string;
  agentType?: string;
  claudeSessionId?: string;
  createdAt: string;
}

const AGENT_TYPE_LABELS: Record<string, string> = {
  build: "Build",
  ticket_build: "Ticket",
  team_build: "Team",
  review_security: "Security",
  review_code: "Code Review",
  review_compliance: "Compliance",
  review_feature: "Feature Review",
  merge: "Merge",
};

const STATUS_CONFIG: Record<
  string,
  { icon: typeof Clock; color: string; label: string }
> = {
  queued: { icon: Clock, color: "text-muted-foreground", label: "Queued" },
  pending: { icon: Clock, color: "text-muted-foreground", label: "Pending" },
  running: { icon: Loader2, color: "text-yellow-500", label: "Running" },
  completed: {
    icon: CheckCircle2,
    color: "text-green-500",
    label: "Completed",
  },
  failed: { icon: XCircle, color: "text-red-500", label: "Failed" },
  cancelled: { icon: Ban, color: "text-muted-foreground", label: "Cancelled" },
};

export default function SessionsPage() {
  const params = useParams();
  const projectId = params.projectId as string;
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadSessions();
  }, [projectId]);

  async function loadSessions() {
    const res = await fetch(`/api/projects/${projectId}/sessions`);
    const data = await res.json();
    setSessions(data.data || []);
    setLoading(false);
  }

  function getDuration(session: Session): string {
    if (!session.startedAt) return "-";
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

  if (loading) {
    return (
      <div className="p-6 text-muted-foreground">Loading sessions...</div>
    );
  }

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-bold">Sessions</h2>
        <div className="flex gap-2 text-xs text-muted-foreground">
          <span>{sessions.filter((s) => s.status === "running").length} running</span>
          <span>{sessions.filter((s) => s.status === "completed").length} completed</span>
          <span>{sessions.filter((s) => s.status === "failed").length} failed</span>
        </div>
      </div>

      {sessions.length === 0 ? (
        <p className="text-muted-foreground text-sm">No sessions yet</p>
      ) : (
        <div className="space-y-2">
          {sessions.map((session) => {
            const config =
              STATUS_CONFIG[session.status] || STATUS_CONFIG.pending;
            const Icon = config.icon;

            return (
              <Link
                key={session.id}
                href={`/projects/${projectId}/sessions/${session.id}`}
              >
                <Card className="p-4 hover:bg-accent/50 transition-colors cursor-pointer">
                  <div className="flex items-center gap-3">
                    <Icon
                      className={`h-4 w-4 shrink-0 ${config.color} ${
                        session.status === "running" ? "animate-spin" : ""
                      }`}
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium">
                          #{session.id.slice(0, 8)}
                        </span>
                        {session.agentType && (
                          <Badge variant="secondary" className="text-[10px]">
                            {AGENT_TYPE_LABELS[session.agentType] || session.agentType}
                          </Badge>
                        )}
                        <Badge variant="outline" className="text-xs">
                          {session.mode}
                        </Badge>
                        {session.claudeSessionId && (
                          <Badge variant="outline" className="text-[10px] text-blue-400 border-blue-400/30">
                            resumable
                          </Badge>
                        )}
                        {session.branchName && (
                          <span className="text-xs text-muted-foreground font-mono truncate">
                            {session.branchName}
                          </span>
                        )}
                      </div>
                      {session.error && (
                        <p className="text-xs text-destructive mt-1 truncate">
                          {session.error}
                        </p>
                      )}
                    </div>
                    <div className="text-right shrink-0">
                      <div className="text-xs text-muted-foreground">
                        {getDuration(session)}
                      </div>
                      {session.status === "running" &&
                        session.lastNonEmptyText && (
                          <div className="text-xs text-muted-foreground max-w-56 truncate">
                            {session.lastNonEmptyText}
                          </div>
                        )}
                      <div className="text-xs text-muted-foreground">
                        {new Date(session.createdAt).toLocaleDateString()}{" "}
                        {new Date(session.createdAt).toLocaleTimeString()}
                      </div>
                    </div>
                  </div>
                </Card>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
