"use client";

import { useCallback, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { usePolling } from "@/hooks/usePolling";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  StopCircle,
  Download,
  RefreshCw,
  GitCompare,
  XCircle,
  Brain,
} from "lucide-react";
import { PROVIDER_LABELS } from "@/lib/agent-config/constants";
import { MEMORY_WRITER_AGENT_TYPES } from "@/lib/workflow/dreaming-constants";
import { SessionOutcomeBadge } from "@/components/shared/SessionOutcomeBadge";
import {
  ArijActionsList,
  type ArijActionItem,
} from "@/components/shared/ArijActionsList";
import { formatCostUsd, formatTokens } from "@/lib/utils/format-usage";
import { cn } from "@/lib/utils";
import {
  describeProviderOptions,
  parseStoredProviderOptions,
} from "@/lib/providers/options-registry";
import {
  SessionOutputStream,
  type SessionStreamSeed,
} from "@/components/sessions/SessionOutputStream";
import type { AgentSessionStreamType } from "@/lib/agent-sessions/chunks";

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
  cliSessionId?: string | null;
  agentType?: string | null;
  outcome?: string | null;
  namedAgentName?: string | null;
  model?: string | null;
  /** JSON object of the per-CLI options in effect for this run. */
  cliOptions?: string | null;
  cliCommand?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  totalCostUsd?: number | null;
  estimatedPromptTokens?: number | null;
  estimatedPromptBreakdown?: string | null;
  arijActions?: ArijActionItem[] | null;
  logs?: {
    success?: boolean;
    result?: string;
    error?: string;
    duration?: number;
  } | null;
  /** Bounded first page of each stream; the rest is paged in on demand. */
  chunkStreams?: Partial<Record<AgentSessionStreamType, SessionStreamSeed>> | null;
  /** The chunk read failed — distinct from a session that wrote nothing. */
  chunkStreamsUnavailable?: boolean;
  /** `logs.json` was too large to serve whole, or its result was capped. */
  logsTruncated?: boolean;
  /** `logs.json` exists but could not be read or parsed. */
  logsUnavailable?: boolean;
}

const AGENT_TYPE_LABELS: Record<string, string> = {
  build: "Build",
  ticket_build: "Ticket Build",
  team_build: "Team Build",
  review_security: "Security Review",
  review_code: "Code Review",
  review_compliance: "Compliance Review",
  review_feature: "Feature Review",
  review_second_opinion: "Second Opinion",
  grading: "Acceptance Grading",
  merge: "Merge",
  tech_check: "Tech Check",
  memory_distill: "Memory Distill",
  dreaming: "Dreaming",
  forensic: "Forensic",
  failure_digest: "Failure Digest",
};

/** Token-only colouring for the state pill. */
const STATUS_PILL: Record<string, string> = {
  completed: "bg-agent-bg text-agent",
  failed: "bg-destructive/10 text-destructive",
  running: "bg-agent-bg text-agent",
  queued: "bg-priority-yellow/10 text-priority-yellow",
  cancelled: "bg-band text-meta",
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
      className={`max-h-[500px] overflow-y-auto overflow-x-hidden font-mono text-[11.5px] leading-[1.7] whitespace-pre-wrap break-words ${className}`}
    >
      {children}
    </div>
  );
}

/** One key/value line of the detail body. */
function DetailRow({
  label,
  children,
  last = false,
}: {
  label: string;
  children: React.ReactNode;
  last?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex items-start justify-between gap-4 border-t border-border-soft py-[11px]",
        last && "border-b"
      )}
    >
      <span className="shrink-0 text-[12.5px] text-muted-foreground">
        {label}
      </span>
      <div className="min-w-0 text-right text-[13px]">{children}</div>
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
  const [distilling, setDistilling] = useState(false);
  const [distillError, setDistillError] = useState<string | null>(null);
  const [tab, setTab] = useState("response");
  const [prompt, setPrompt] = useState<string | null>(null);
  const [promptState, setPromptState] = useState<
    "idle" | "loading" | "loaded" | "error"
  >("idle");

  const loadSession = useCallback(async () => {
    const res = await fetch(
      `/api/projects/${projectId}/sessions/${sessionId}`
    );
    const data = await res.json();
    setSession(data.data);
    setLoading(false);
  }, [projectId, sessionId]);

  /**
   * The prompt is up to 1.8 MB on the live database and is only ever looked
   * at in the Prompt tab, so the route leaves it out unless it is asked for.
   * Fetched once, on the first open of that tab.
   */
  const loadPrompt = useCallback(async () => {
    setPromptState((current) => (current === "idle" || current === "error" ? "loading" : current));
    try {
      const res = await fetch(
        `/api/projects/${projectId}/sessions/${sessionId}?include=prompt`
      );
      if (!res.ok) throw new Error(`Prompt request failed (${res.status})`);
      const data = await res.json();
      setPrompt(data.data?.prompt ?? null);
      setPromptState("loaded");
    } catch {
      setPromptState("error");
    }
  }, [projectId, sessionId]);

  function handleTabChange(next: string) {
    setTab(next);
    if (next === "prompt" && promptState === "idle") void loadPrompt();
  }

  // Initial load + poll if running
  usePolling(loadSession, 3000);

  async function handleCancel() {
    await fetch(`/api/projects/${projectId}/sessions/${sessionId}`, {
      method: "DELETE",
    });
    loadSession();
  }

  async function handleDistill() {
    setDistilling(true);
    setDistillError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/memory/distill`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceSessionId: sessionId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setDistillError(data.error || "Failed to start memory distillation.");
        return;
      }
      const distillSessionId = data.data?.sessionId;
      if (distillSessionId) {
        router.push(`/projects/${projectId}/sessions/${distillSessionId}`);
      }
    } catch {
      setDistillError("Failed to start memory distillation.");
    } finally {
      setDistilling(false);
    }
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
    const end = endAt ? new Date(endAt).getTime() : Date.now();
    const seconds = Math.floor((end - start) / 1000);
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    if (mins > 0) return `${mins}m ${secs}s`;
    return `${secs}s`;
  }

  if (loading || !session) {
    return <div className="p-6 text-muted-foreground">Loading...</div>;
  }

  const isRunning = session.status === "running";
  const sessionCliOptions = describeProviderOptions(
    session.provider,
    parseStoredProviderOptions(session.provider, session.cliOptions),
  );
  const providerLabel =
    session.namedAgentName ||
    (session.provider
      ? (PROVIDER_LABELS[session.provider as keyof typeof PROVIDER_LABELS] ??
        session.provider)
      : "Agent");
  const typeLabel = session.agentType
    ? (AGENT_TYPE_LABELS[session.agentType] ?? session.agentType)
    : session.mode;

  return (
    <div className="flex max-w-[900px] flex-col gap-[16px] p-[24px]">
      {/* Identity line */}
      <div className="flex flex-wrap items-center gap-[10px]">
        <span className="font-mono text-[11.5px] text-meta">
          {session.id.slice(0, 8)}
        </span>
        <span
          className={cn(
            "inline-flex items-center gap-[7px] rounded-full px-[10px] py-[4px] text-[12px]",
            STATUS_PILL[session.status] ?? "bg-band text-meta"
          )}
        >
          {isRunning && <span className="breathing-dot h-[7px] w-[7px]" />}
          {session.status}
        </span>
        <SessionOutcomeBadge outcome={session.outcome} />
        <Badge
          variant="outline"
          className="rounded-full px-[8px] py-[1px] text-[11px] font-normal text-meta"
        >
          {session.mode}
        </Badge>
        {session.provider && (
          <Badge
            variant="outline"
            className="rounded-full px-[8px] py-[1px] text-[11px] font-normal text-meta"
          >
            {PROVIDER_LABELS[
              session.provider as keyof typeof PROVIDER_LABELS
            ] ?? session.provider}
          </Badge>
        )}
        {session.model && (
          <span className="font-mono text-[11px] text-meta">
            {session.model}
          </span>
        )}
        {/* Options actually in effect for this run, read from the session row
            rather than from the named agent — the agent may have been edited
            or deleted since. */}
        {sessionCliOptions.map((option) => (
          <Badge
            key={option.key}
            variant="outline"
            className="rounded-full px-[8px] py-[1px] text-[11px] font-normal text-meta"
          >
            {option.label}: {option.value}
          </Badge>
        ))}
        {session.cliSessionId && (
          <Badge
            variant="outline"
            className="rounded-full px-[8px] py-[1px] text-[11px] font-normal text-agent border-agent-border"
          >
            resumable
          </Badge>
        )}

        <div className="ml-auto flex items-center gap-2">
          {/* Mirrors evaluateDistillSourceEligibility, which the endpoint
              enforces: never a session that WROTE the memory (a distill of a
              distill has no source learnings), and never one that stopped to
              ask a question — those are `completed` too, but the agent is
              still waiting for a reply, so there is nothing settled to fold
              into a document every future prompt reads. */}
          {session.status === "completed" &&
            session.outcome !== "asked_question" &&
            !MEMORY_WRITER_AGENT_TYPES.includes(session.agentType ?? "") && (
              <Button
                variant="outline"
                size="sm"
                className="h-[31px] rounded-[8px] px-[12px] text-[13px]"
                onClick={handleDistill}
                disabled={distilling}
                title="Merge this session's learnings into the project memory"
              >
                <Brain className="h-4 w-4 mr-1" />
                {distilling ? "Distilling..." : "Distill learnings"}
              </Button>
            )}
          {session.logs && (
            <Button
              variant="outline"
              size="sm"
              className="h-[31px] rounded-[8px] px-[12px] text-[13px]"
              onClick={handleExportLogs}
            >
              <Download className="h-4 w-4 mr-1" />
              Export Logs
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            className="h-[31px] rounded-[8px] px-[12px] text-[13px]"
            onClick={loadSession}
          >
            <RefreshCw className="h-4 w-4 mr-1" />
            Refresh
          </Button>
        </div>
      </div>

      {/* Title + target */}
      <div className="flex flex-col gap-[6px]">
        <h2 className="text-[18px] font-medium leading-[1.3]">
          {providerLabel} · {typeLabel}
        </h2>
        {(session.epicId || session.branchName) && (
          <span className="font-mono text-[12px] text-muted-foreground">
            {[session.epicId, session.branchName].filter(Boolean).join(" · ")}
          </span>
        )}
        {session.lastNonEmptyText && (
          <p className="truncate font-mono text-[11.5px] text-meta">
            {session.lastNonEmptyText}
          </p>
        )}
      </div>

      {isRunning && (
        <div className="progress-track">
          <div className="crawl-fill" />
        </div>
      )}

      {distillError && (
        <p className="text-[13px] text-destructive">{distillError}</p>
      )}

      {/* Key/value rows */}
      <div className="flex flex-col">
        <DetailRow label="Started">
          {session.startedAt
            ? new Date(session.startedAt).toLocaleString()
            : "-"}
        </DetailRow>
        <DetailRow label="Completed">
          {session.endedAt || session.completedAt
            ? new Date(
                session.endedAt || session.completedAt || ""
              ).toLocaleString()
            : isRunning
              ? "In progress..."
              : "-"}
        </DetailRow>
        <DetailRow label="Duration">
          <span className="font-mono">{getDuration()}</span>
        </DetailRow>
        <DetailRow label="Cost">
          <span className="font-mono">
            {formatCostUsd(session.totalCostUsd) ?? "—"}
          </span>
        </DetailRow>
        <DetailRow label="Tokens">
          <div className="flex flex-col gap-0.5 font-mono">
            <span>
              {session.inputTokens != null || session.outputTokens != null
                ? `${formatTokens(session.inputTokens) ?? "—"} in · ${
                    formatTokens(session.outputTokens) ?? "—"
                  } out`
                : "—"}
            </span>
            {session.estimatedPromptTokens != null && (
              <span
                className="text-[11.5px] font-normal text-muted-foreground"
                data-testid="session-estimated-tokens"
              >
                Estimated input: ~{formatTokens(session.estimatedPromptTokens)} tokens
                {session.estimatedPromptBreakdown && (() => {
                  try {
                    const b = JSON.parse(session.estimatedPromptBreakdown);
                    const parts: string[] = [];
                    if (b.spec) parts.push(`Spec ${formatTokens(b.spec)}`);
                    if (b.memory) parts.push(`Mem ${formatTokens(b.memory)}`);
                    if (b.ticket) parts.push(`Ticket ${formatTokens(b.ticket)}`);
                    if (b.comments) parts.push(`Comments ${formatTokens(b.comments)}`);
                    if (b.findings) parts.push(`Findings ${formatTokens(b.findings)}`);
                    if (b.documents) parts.push(`Docs ${formatTokens(b.documents)}`);
                    if (b.system) parts.push(`System ${formatTokens(b.system)}`);
                    if (b.other) parts.push(`Other ${formatTokens(b.other)}`);
                    return parts.length > 0 ? ` (${parts.join(" · ")})` : "";
                  } catch {
                    return "";
                  }
                })()}
              </span>
            )}
          </div>
        </DetailRow>
        {session.worktreePath && (
          <DetailRow label="Worktree">
            <span className="block truncate font-mono text-[12px]">
              {session.worktreePath}
            </span>
          </DetailRow>
        )}
        {session.cliSessionId && (
          <DetailRow label="CLI session">
            <span className="block truncate font-mono text-[12px] text-agent">
              {session.cliSessionId}
            </span>
          </DetailRow>
        )}
        {session.cliCommand && (
          <DetailRow label="Command" last>
            <span className="block max-h-[80px] overflow-y-auto break-all font-mono text-[12px] text-muted-foreground whitespace-pre-wrap">
              {session.cliCommand}
            </span>
          </DetailRow>
        )}
      </div>

      {/* Structured board effects (MCP tool calls + dispatch artifacts) */}
      <ArijActionsList actions={session.arijActions} />

      {/* Error */}
      {session.error && (
        <div className="rounded-[11px] border border-destructive/50 bg-band p-[14px]">
          <div className="mb-2 flex items-center gap-2">
            <XCircle className="h-4 w-4 text-destructive" />
            <h3 className="text-[13px] font-medium text-destructive">Error</h3>
          </div>
          <ScrollPane className="max-h-[200px] text-destructive/80">
            {session.error}
          </ScrollPane>
        </div>
      )}

      {/* Failed without a captured error message (legacy rows predating the
          failure-message synthesis, or a loss that escaped it): say so
          explicitly instead of showing nothing — and point at the Raw Logs
          tab, which keeps whatever the process actually wrote. */}
      {!session.error && session.status === "failed" && (
        <div className="rounded-[11px] border border-destructive/50 bg-band p-[14px]">
          <div className="mb-2 flex items-center gap-2">
            <XCircle className="h-4 w-4 text-destructive" />
            <h3 className="text-[13px] font-medium text-destructive">
              Failed — no error message captured
            </h3>
          </div>
          <p className="text-[12.5px] leading-relaxed text-muted-foreground">
            This session failed before Arij could record an error message: the
            process exited (or was lost) without writing stderr or text.
            Whatever it did produce is kept in the Raw Logs tab below.
          </p>
        </div>
      )}

      {/* Output: Response / Prompt / Raw Logs */}
      <Tabs value={tab} onValueChange={handleTabChange}>
        <TabsList>
          <TabsTrigger value="response">Response</TabsTrigger>
          <TabsTrigger value="prompt">Prompt</TabsTrigger>
          <TabsTrigger value="raw">Raw Logs</TabsTrigger>
        </TabsList>

        <TabsContent value="response">
          <div className="overflow-hidden rounded-[11px] bg-band p-[14px]">
            <SessionOutputStream
              projectId={projectId}
              sessionId={sessionId}
              streamType="response"
              seed={session.chunkStreams?.response ?? null}
              unavailable={session.chunkStreamsUnavailable}
              isRunning={isRunning}
              waitingLabel="Waiting for agent to respond..."
              emptyLabel="No response available"
              // Sessions predating the chunk store have no response stream;
              // their text only exists in logs.json.
              fallback={
                session.logs?.result ? (
                  <ScrollPane className="text-muted-foreground">
                    {session.logs.result}
                  </ScrollPane>
                ) : null
              }
            />
          </div>
        </TabsContent>

        <TabsContent value="prompt">
          <div className="overflow-hidden rounded-[11px] bg-band p-[14px]">
            {prompt ? (
              <ScrollPane className="text-muted-foreground">{prompt}</ScrollPane>
            ) : promptState === "loading" ? (
              <p className="text-[13px] text-muted-foreground">
                Loading prompt...
              </p>
            ) : promptState === "error" ? (
              <div className="flex flex-col items-start gap-[8px]">
                <p className="text-[13px] text-destructive">
                  Could not load the prompt.
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-[29px] rounded-[8px] px-[12px] text-[12.5px]"
                  onClick={loadPrompt}
                >
                  Retry
                </Button>
              </div>
            ) : (
              <p className="text-[13px] text-muted-foreground">
                No prompt available
              </p>
            )}
          </div>
        </TabsContent>

        <TabsContent value="raw">
          <div className="flex flex-col gap-[10px] overflow-hidden rounded-[11px] bg-band p-[14px]">
            {session.logsUnavailable && (
              <p className="text-[12.5px] text-destructive/90">
                This session&apos;s logs.json could not be read. The raw stream
                below is what the process actually wrote.
              </p>
            )}
            {session.logsTruncated && (
              <p className="text-[12.5px] text-meta">
                logs.json was too large to serve in full — the stream below is
                the same output, paged.
              </p>
            )}
            <SessionOutputStream
              projectId={projectId}
              sessionId={sessionId}
              streamType="raw"
              seed={session.chunkStreams?.raw ?? null}
              unavailable={session.chunkStreamsUnavailable}
              isRunning={isRunning}
              emptyLabel="No logs available"
              fallback={
                session.logs ? (
                  <ScrollPane className="text-muted-foreground">
                    {JSON.stringify(session.logs, null, 2)}
                  </ScrollPane>
                ) : null
              }
            />
          </div>
        </TabsContent>
      </Tabs>

      {/* Session actions */}
      {(session.epicId || isRunning || session.status === "queued") && (
        <div className="flex gap-[10px]">
          {session.epicId && (
            <Button
              asChild
              variant="outline"
              className="h-[31px] rounded-[8px] px-[12px] text-[13px]"
            >
              <Link href={`/projects/${projectId}?ticket=${session.epicId}`}>
                <GitCompare className="h-4 w-4 mr-1" />
                View diff
              </Link>
            </Button>
          )}
          {(isRunning || session.status === "queued") && (
            <Button
              variant="outline"
              className="h-[31px] rounded-[8px] border-destructive px-[12px] text-[13px] text-destructive hover:bg-destructive/10 hover:text-destructive"
              onClick={handleCancel}
            >
              <StopCircle className="h-4 w-4 mr-1" />
              Stop
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
