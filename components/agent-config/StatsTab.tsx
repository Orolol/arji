"use client";

import { useEffect, useState } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Loader2 } from "lucide-react";
import { PROVIDER_LABELS } from "@/lib/agent-config/constants";
import { formatCostUsd } from "@/lib/utils/format-usage";

interface StatsTabProps {
  scope: "global" | "project";
  projectId?: string;
}

interface AgentReliabilityRow {
  agentName: string | null;
  provider: string;
  runCount: number;
  completedCount: number;
  failedCount: number;
  successRate: number | null;
  medianDurationMs: number | null;
  totalCostUsd: number | null;
}

interface ProjectReviewBounceRow {
  projectId: string;
  projectName: string | null;
  reviewedEpics: number;
  bounceTransitions: number;
  bounceRate: number | null;
}

interface StatsPayload {
  agents: AgentReliabilityRow[];
  reviewBounce: ProjectReviewBounceRow[];
}

const EM_DASH = "—";

function formatDurationMs(ms: number | null): string {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return EM_DASH;
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  if (mins < 60) return `${mins}m ${secs}s`;
  const hours = Math.floor(mins / 60);
  return `${hours}h ${mins % 60}m`;
}

function formatPercent(ratio: number | null): string {
  if (typeof ratio !== "number" || !Number.isFinite(ratio)) return EM_DASH;
  return `${Math.round(ratio * 100)}%`;
}

function providerLabel(provider: string): string {
  return (
    PROVIDER_LABELS[provider as keyof typeof PROVIDER_LABELS] ?? provider
  );
}

export function StatsTab({ scope, projectId }: StatsTabProps) {
  const [stats, setStats] = useState<StatsPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const scopedProjectId = scope === "project" ? projectId : undefined;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    const query = scopedProjectId
      ? `?projectId=${encodeURIComponent(scopedProjectId)}`
      : "";
    fetch(`/api/agent-config/stats${query}`)
      .then((r) => r.json())
      .then((json) => {
        if (cancelled) return;
        if (json.error) {
          setError(typeof json.error === "string" ? json.error : "Failed to load stats");
        } else {
          setStats(json.data ?? { agents: [], reviewBounce: [] });
        }
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setError("Failed to load stats");
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [scopedProjectId]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-10 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin mr-2" />
        Loading stats...
      </div>
    );
  }

  if (error) {
    return <p className="text-sm text-destructive py-4">{error}</p>;
  }

  const agents = stats?.agents ?? [];
  const reviewBounce = stats?.reviewBounce ?? [];

  return (
    <ScrollArea className="h-full">
      <div className="space-y-6 py-2 pr-3">
        <section>
          <h3 className="text-sm font-medium mb-1">Agent reliability</h3>
          <p className="text-xs text-muted-foreground mb-2">
            Runs per named agent and CLI
            {scopedProjectId ? " in this project" : " across all projects"}.
            Cost and tokens are only counted when the CLI reports them.
          </p>
          {agents.length === 0 ? (
            <p className="text-xs text-muted-foreground py-2">
              No agent sessions yet.
            </p>
          ) : (
            <div className="rounded-lg border border-border overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border text-muted-foreground">
                    <th className="text-left font-medium px-3 py-2">Agent</th>
                    <th className="text-left font-medium px-3 py-2">CLI</th>
                    <th className="text-right font-medium px-3 py-2">Runs</th>
                    <th className="text-right font-medium px-3 py-2" title="Completed / (completed + failed)">
                      Success
                    </th>
                    <th className="text-right font-medium px-3 py-2" title="Median duration of finished runs">
                      Median
                    </th>
                    <th className="text-right font-medium px-3 py-2" title="Sum of reported session costs">
                      Cost
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {agents.map((row) => (
                    <tr
                      key={`${row.agentName ?? ""}::${row.provider}`}
                      className="border-b border-border/50 last:border-b-0"
                    >
                      <td className="px-3 py-2">
                        {row.agentName ?? (
                          <span className="text-muted-foreground">{EM_DASH}</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">
                        {providerLabel(row.provider)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {row.runCount}
                      </td>
                      <td
                        className="px-3 py-2 text-right tabular-nums"
                        title={`${row.completedCount} completed / ${row.failedCount} failed`}
                      >
                        {formatPercent(row.successRate)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {formatDurationMs(row.medianDurationMs)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {formatCostUsd(row.totalCostUsd) ?? EM_DASH}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section>
          <h3 className="text-sm font-medium mb-1">Review bounce rate</h3>
          <p className="text-xs text-muted-foreground mb-2">
            Review → dev bounces per epic that reached review (from the ticket
            activity log). Over 100% means epics bounced more than once on
            average.
          </p>
          {reviewBounce.length === 0 ? (
            <p className="text-xs text-muted-foreground py-2">
              No epic has reached review yet.
            </p>
          ) : (
            <div className="rounded-lg border border-border overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border text-muted-foreground">
                    <th className="text-left font-medium px-3 py-2">Project</th>
                    <th className="text-right font-medium px-3 py-2">
                      Epics reviewed
                    </th>
                    <th className="text-right font-medium px-3 py-2">Bounces</th>
                    <th className="text-right font-medium px-3 py-2">Rate</th>
                  </tr>
                </thead>
                <tbody>
                  {reviewBounce.map((row) => (
                    <tr
                      key={row.projectId}
                      className="border-b border-border/50 last:border-b-0"
                    >
                      <td className="px-3 py-2">
                        {row.projectName ?? row.projectId}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {row.reviewedEpics}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {row.bounceTransitions}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {formatPercent(row.bounceRate)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </ScrollArea>
  );
}
