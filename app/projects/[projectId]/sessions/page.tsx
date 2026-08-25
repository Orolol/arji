"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import {
  ArrowUpDown,
  Ban,
  Circle,
  CircleCheck,
  Clock,
  LoaderCircle,
  MessageSquare,
  Moon,
  Search,
  Sparkles,
  TriangleAlert,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { PROVIDER_LABELS } from "@/lib/agent-config/constants";
import { SessionOutcomeBadge } from "@/components/shared/SessionOutcomeBadge";
import { NightRunSummaryDialog } from "@/components/night/NightRunSummaryDialog";
import {
  formatNightRunCounts,
  formatNightRunDuration,
} from "@/components/night/night-run-format";
import { useNightRuns } from "@/hooks/useNightRuns";
import { formatCostUsd } from "@/lib/utils/format-usage";
import { formatTime } from "@/lib/utils/format-date";
import { isNightRunId, type NightRunListEntry } from "@/lib/night/constants";
import { cn } from "@/lib/utils";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { parseStoredTimestamp } from "@/lib/agent-sessions/last-activity";

// --- Discriminated union types ---

interface AgentSession {
  kind: "agent_session";
  id: string;
  status: string;
  mode: string;
  provider?: string;
  epicId?: string;
  branchName?: string;
  startedAt?: string;
  endedAt?: string;
  completedAt?: string;
  lastNonEmptyText?: string;
  error?: string;
  agentType?: string;
  outcome?: string | null;
  cliSessionId?: string | null;
  namedAgentName?: string | null;
  model?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  totalCostUsd?: number | null;
  /** Batch run tag — `night_*` for epics dispatched by a night run. */
  batchRunId?: string | null;
  createdAt: string | null;
  lastActivityAt: string | null;
}

interface ChatSession {
  kind: "chat_session";
  id: string;
  type: string;
  label: string;
  status: string | null;
  epicId?: string | null;
  provider?: string | null;
  namedAgentId?: string | null;
  namedAgentName?: string | null;
  messageCount: number;
  lastMessagePreview: string | null;
  createdAt: string | null;
  lastActivityAt: string | null;
}

type UnifiedSession = AgentSession | ChatSession;

const AGENT_TYPE_LABELS: Record<string, string> = {
  build: "Build",
  ticket_build: "Ticket",
  team_build: "Team",
  review_security: "Security",
  review_code: "Code Review",
  review_compliance: "Compliance",
  review_feature: "Feature Review",
  grading: "Acceptance Grading",
  merge: "Merge",
  tech_check: "Tech Check",
  release_notes: "Release Notes",
  memory_distill: "Memory Distill",
  dreaming: "Dreaming",
  forensic: "Forensic",
};

const STATUS_CONFIG: Record<
  string,
  { icon: LucideIcon; color: string; label: string }
> = {
  queued: { icon: Clock, color: "text-priority-yellow", label: "Queued" },
  pending: { icon: Circle, color: "text-meta", label: "Pending" },
  running: { icon: LoaderCircle, color: "text-agent", label: "Running" },
  completed: {
    icon: CircleCheck,
    color: "text-agent",
    label: "Completed",
  },
  failed: { icon: TriangleAlert, color: "text-destructive", label: "Failed" },
  cancelled: { icon: Ban, color: "text-meta", label: "Cancelled" },
};

/** State chips (single-select) and provider chips (toggle) of the filter bar. */
type StateFilter = "all" | "running" | "failed" | "night";
type ProviderFilter = "claude-code" | "codex" | null;
type SortOption = "created" | "last_activity";

const TABLE_GRID = "grid-cols-[1.5fr_0.9fr_0.75fr_0.8fr_0.55fr_0.4fr]";

function isToday(iso: string | null | undefined): boolean {
  if (!iso) return false;
  const timestamp = parseStoredTimestamp(iso);
  if (timestamp === null) return false;
  const date = new Date(timestamp);
  const now = new Date();
  return (
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  );
}

function isTerminal(status: string): boolean {
  return (
    status === "completed" || status === "failed" || status === "cancelled"
  );
}

export default function SessionsPage() {
  const params = useParams();
  const projectId = params.projectId as string;
  const [items, setItems] = useState<UnifiedSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [stateFilter, setStateFilter] = useState<StateFilter>("all");
  const [providerFilter, setProviderFilter] = useState<ProviderFilter>(null);
  const [ticketQuery, setTicketQuery] = useState("");
  const [sortBy, setSortBy] = useState<SortOption>("created");
  const [summaryRunId, setSummaryRunId] = useState<string | null>(null);

  /**
   * Night-run history. This list is the only durable way back into a past
   * run's morning summary — the "Night run finished" notification carrying
   * the `?nightRun=` deep link is transient.
   *
   * Polled only while the "Night run" chip is active: the default Sessions
   * view must not pay for a surface it is not showing.
   */
  const nightFilterActive = stateFilter === "night";
  const {
    runs: nightRuns,
    loading: nightRunsLoading,
    error: nightRunsError,
    refresh: refreshNightRuns,
  } = useNightRuns(projectId, nightFilterActive);

  useEffect(() => {
    loadSessions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  async function loadSessions() {
    const res = await fetch(`/api/projects/${projectId}/sessions`);
    const data = await res.json();
    setItems(data.data || []);
    setLoading(false);
  }

  function getDuration(session: AgentSession): string {
    if (!session.startedAt) return "-";
    const start = new Date(session.startedAt).getTime();
    const endAt = session.endedAt || session.completedAt;
    const end = endAt ? new Date(endAt).getTime() : Date.now();
    const seconds = Math.floor((end - start) / 1000);
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    if (mins > 0) return `${mins}m ${secs}s`;
    return `${secs}s`;
  }

  const agentSessions = useMemo(
    () => items.filter((i): i is AgentSession => i.kind === "agent_session"),
    [items]
  );

  /** Synthesis band — derived from the list the page already has. */
  const band = useMemo(() => {
    const running = agentSessions.filter((s) => s.status === "running");
    const queued = agentSessions.filter((s) => s.status === "queued");
    const todayTerminal = agentSessions.filter(
      (s) => isTerminal(s.status) && isToday(s.createdAt)
    );
    const todayCost = todayTerminal.reduce(
      (sum, s) => sum + (typeof s.totalCostUsd === "number" ? s.totalCostUsd : 0),
      0
    );
    const completed = todayTerminal.filter(
      (s) => s.status === "completed"
    ).length;
    const failed = todayTerminal.filter((s) => s.status === "failed").length;
    return {
      running: running.length,
      queued: queued.length,
      today: todayTerminal.length,
      todayCost,
      completed,
      failed,
    };
  }, [agentSessions]);

  const visible = useMemo(() => {
    const query = ticketQuery.trim().toLowerCase();
    const filtered = items.filter((item) => {
      if (item.kind === "agent_session") {
        if (stateFilter === "running" && item.status !== "running") return false;
        if (stateFilter === "failed" && item.status !== "failed") return false;
        if (stateFilter === "night" && !isNightRunId(item.batchRunId))
          return false;
        if (providerFilter && item.provider !== providerFilter) return false;
        if (query) {
          const haystack = [item.epicId, item.branchName, item.id]
            .filter(Boolean)
            .join(" ")
            .toLowerCase();
          if (!haystack.includes(query)) return false;
        }
        return true;
      }
      // Chat conversations have no run state: only "All" and "Running"
      // (while generating) can show them.
      if (stateFilter === "failed" || stateFilter === "night") return false;
      if (stateFilter === "running" && item.status !== "generating")
        return false;
      if (providerFilter && item.provider !== providerFilter) return false;
      if (query) {
        const haystack = [item.label, item.epicId]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        if (!haystack.includes(query)) return false;
      }
      return true;
    });

    // The API's existing creation-time order remains the default. Selecting
    // Last activity explicitly reorders the already-filtered unified list.
    if (sortBy === "created") return filtered;

    return filtered.sort((a, b) => {
      const activityA = a.lastActivityAt
        ? (parseStoredTimestamp(a.lastActivityAt) ?? Number.NEGATIVE_INFINITY)
        : Number.NEGATIVE_INFINITY;
      const activityB = b.lastActivityAt
        ? (parseStoredTimestamp(b.lastActivityAt) ?? Number.NEGATIVE_INFINITY)
        : Number.NEGATIVE_INFINITY;
      if (activityA !== activityB) return activityB - activityA;
      return a.id.localeCompare(b.id);
    });
  }, [items, stateFilter, providerFilter, ticketQuery, sortBy]);

  if (loading) {
    return <div className="p-6 text-muted-foreground">Loading sessions...</div>;
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Synthesis band */}
      <div
        data-testid="sessions-band"
        className="flex h-[72px] shrink-0 border-b border-border bg-band"
      >
        <BandCell
          label="RUNNING"
          testId="sessions-band-running"
          value={
            band.running === 0
              ? "None right now"
              : `${band.running} session${band.running === 1 ? "" : "s"}`
          }
        />
        <BandCell
          label="TODAY"
          testId="sessions-band-today"
          value={
            band.today === 0
              ? "Nothing today"
              : `${band.today} session${band.today === 1 ? "" : "s"}${
                  band.todayCost > 0 ? ` · ${formatCostUsd(band.todayCost)}` : ""
                }`
          }
        />
        <BandCell
          label="SUCCESS RATE"
          testId="sessions-band-success"
          value={
            band.completed + band.failed === 0
              ? "No finished sessions"
              : `${band.completed} / ${band.completed + band.failed}`
          }
        />
        <BandCell
          label="QUEUE"
          testId="sessions-band-queue"
          last
          value={band.queued === 0 ? "Nothing queued" : `${band.queued} queued`}
          valueClassName={band.queued > 0 ? "text-priority-yellow" : undefined}
        />
      </div>

      {/* Filter bar */}
      <div className="flex h-[46px] shrink-0 items-center gap-[7px] border-b border-border px-[22px]">
        <FilterChip
          testId="sessions-filter-all"
          active={stateFilter === "all" && providerFilter === null}
          onClick={() => {
            setStateFilter("all");
            setProviderFilter(null);
          }}
        >
          All
        </FilterChip>
        <FilterChip
          testId="sessions-filter-running"
          active={stateFilter === "running"}
          onClick={() =>
            setStateFilter((s) => (s === "running" ? "all" : "running"))
          }
        >
          Running
        </FilterChip>
        <FilterChip
          testId="sessions-filter-failed"
          active={stateFilter === "failed"}
          onClick={() =>
            setStateFilter((s) => (s === "failed" ? "all" : "failed"))
          }
        >
          Failed
        </FilterChip>
        <FilterChip
          testId="sessions-filter-night"
          active={stateFilter === "night"}
          onClick={() =>
            setStateFilter((s) => (s === "night" ? "all" : "night"))
          }
        >
          Night run
        </FilterChip>
        <span className="mx-[5px] h-4 w-px bg-border" />
        <FilterChip
          testId="sessions-filter-claude-code"
          active={providerFilter === "claude-code"}
          onClick={() =>
            setProviderFilter((p) => (p === "claude-code" ? null : "claude-code"))
          }
        >
          Claude Code
        </FilterChip>
        <FilterChip
          testId="sessions-filter-codex"
          active={providerFilter === "codex"}
          onClick={() => setProviderFilter((p) => (p === "codex" ? null : "codex"))}
        >
          Codex
        </FilterChip>

        <div className="ml-auto flex items-center gap-[7px] text-[12.5px] text-muted-foreground">
          <ArrowUpDown className="h-[13px] w-[13px] shrink-0" />
          <Select
            value={sortBy}
            onValueChange={(value) => setSortBy(value as SortOption)}
          >
            <SelectTrigger
              aria-label="Sort sessions"
              data-testid="sessions-sort"
              size="sm"
              className="h-7 min-w-[116px] border-0 px-1.5 text-[12.5px] shadow-none focus-visible:ring-1"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="end">
              <SelectItem value="created">Created</SelectItem>
              <SelectItem value="last_activity">Last activity</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <span className="mx-[5px] h-4 w-px bg-border" />

        <label className="flex items-center gap-[7px] text-[12.5px] text-muted-foreground">
          <Search className="h-[13px] w-[13px] shrink-0" />
          <span className="sr-only">Filter by ticket</span>
          <input
            type="text"
            value={ticketQuery}
            onChange={(e) => setTicketQuery(e.target.value)}
            placeholder="Filter by ticket"
            className="w-[150px] bg-transparent text-[12.5px] text-foreground placeholder:text-muted-foreground focus:outline-none"
          />
        </label>
      </div>

      {/* Run-level night history, above the session-level rows the same chip
          filters to. Hidden until the chip is on, so the default view keeps
          its shape. */}
      {nightFilterActive && (
        <div
          data-testid="night-runs-list"
          className="shrink-0 border-b border-border bg-band px-[22px] py-[14px]"
        >
          <span className="text-[11.5px] uppercase tracking-[.08em] text-meta">
            Night runs
          </span>
          {nightRuns.length === 0 && nightRunsError ? (
            /* Never let a dead request read as "you have no night runs" —
               this list is the only durable way back into a past summary. */
            <div className="flex items-center gap-[10px] pt-[8px]">
              <p
                data-testid="night-runs-error"
                className="text-[13px] text-priority-yellow"
              >
                {nightRunsError}
              </p>
              <button
                type="button"
                data-testid="night-runs-retry"
                onClick={() => void refreshNightRuns()}
                className="text-[12.5px] text-muted-foreground underline underline-offset-2 transition-colors hover:text-primary"
              >
                Retry
              </button>
            </div>
          ) : nightRuns.length === 0 ? (
            <p className="pt-[8px] text-[13px] text-muted-foreground">
              {nightRunsLoading
                ? "Loading night runs…"
                : "No night runs recorded yet."}
            </p>
          ) : (
            <div className="mt-[8px] flex max-h-[180px] flex-col overflow-y-auto">
              {nightRuns.map((run) => (
                <NightRunRow
                  key={run.runId}
                  run={run}
                  onOpen={() => setSummaryRunId(run.runId)}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {/* Same dialog the `?nightRun=` deep link opens on the board, driven by
          the same hook — opening a run from here is the identical surface. */}
      <NightRunSummaryDialog
        projectId={projectId}
        runId={summaryRunId}
        open={summaryRunId !== null}
        onOpenChange={(open) => {
          if (!open) setSummaryRunId(null);
        }}
      />

      {items.length === 0 ? (
        <p className="p-6 text-sm text-muted-foreground">No sessions yet</p>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <div
            className={cn(
              "grid shrink-0 items-center gap-[14px] border-b border-border px-[22px] py-[12px]",
              TABLE_GRID
            )}
          >
            <span className="text-[11.5px] uppercase tracking-[.08em] text-meta">
              Session
            </span>
            <span className="text-[11.5px] uppercase tracking-[.08em] text-meta">
              State
            </span>
            <span className="text-[11.5px] uppercase tracking-[.08em] text-meta">
              Duration
            </span>
            <span className="text-[11.5px] uppercase tracking-[.08em] text-meta">
              Activity
            </span>
            <span className="text-[11.5px] uppercase tracking-[.08em] text-meta">
              Cost
            </span>
            <span />
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {visible.length === 0 ? (
              <p className="px-[22px] py-[18px] text-[13px] text-muted-foreground">
                No sessions match these filters.
              </p>
            ) : (
              visible.map((item) =>
                item.kind === "agent_session" ? (
                  <AgentSessionRow
                    key={`agent-${item.id}`}
                    session={item}
                    projectId={projectId}
                    getDuration={getDuration}
                  />
                ) : (
                  <ChatSessionRow
                    key={`chat-${item.id}`}
                    session={item}
                    projectId={projectId}
                  />
                )
              )
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function BandCell({
  label,
  value,
  testId,
  last = false,
  valueClassName,
}: {
  label: string;
  value: string;
  testId: string;
  last?: boolean;
  valueClassName?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-1 flex-col justify-center gap-[5px] px-[22px]",
        !last && "border-r border-border"
      )}
    >
      <span className="text-[11.5px] tracking-[.08em] text-meta">{label}</span>
      <span
        data-testid={testId}
        className={cn("truncate text-[13.5px]", valueClassName)}
      >
        {value}
      </span>
    </div>
  );
}

/**
 * One past (or live) night run, opening the morning summary.
 *
 * Cost is deliberately absent: the list payload has `totalCostUsd` but not
 * `costIsPartial`, so it cannot say whether the number is exact or a lower
 * bound. The dialog has both and prints it honestly — better than a figure
 * here that silently drops the `≥`.
 *
 * `interrupted` is reported as provenance, not as a cause. The server sets it
 * on every run it rebuilds from session rows (`detailFromDb`), and the registry
 * that would say otherwise is in-memory and ring-capped — so a *cleanly
 * finished* run earns the flag simply by outliving a restart or falling off the
 * ring. "Rebuilt from history" is all the flag actually supports.
 */
function NightRunRow({
  run,
  onOpen,
}: {
  run: NightRunListEntry;
  onOpen: () => void;
}) {
  const isLive = run.state === "running" && !run.interrupted;
  const subline = [
    run.runId,
    formatTime(run.startedAt),
    formatNightRunDuration(run.startedAt, run.endedAt),
    run.interrupted ? "rebuilt from history" : null,
    run.abortReason,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <button
      type="button"
      data-testid={`night-run-row-${run.runId}`}
      onClick={onOpen}
      className="flex items-center gap-[10px] border-t border-border-soft py-[9px] text-left transition-colors first:border-t-0 hover:text-primary"
    >
      {isLive ? (
        <span className="breathing-dot h-[7px] w-[7px] shrink-0" />
      ) : (
        <Moon className="h-[14px] w-[14px] shrink-0 text-meta" />
      )}
      <div className="flex min-w-0 flex-col">
        <span className="truncate text-[13.5px]">
          {formatNightRunCounts(run.counts)}
        </span>
        <span className="truncate font-mono text-[11px] text-meta">
          {subline}
        </span>
      </div>
      <span className="ml-auto shrink-0 pl-[10px] text-[12.5px] text-muted-foreground">
        {isLive ? "Running" : "Summary"}
      </span>
    </button>
  );
}

function FilterChip({
  active,
  onClick,
  testId,
  children,
}: {
  active: boolean;
  onClick: () => void;
  testId: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "rounded-full px-[11px] py-[3px] text-[12.5px] transition-colors",
        active
          ? "bg-foreground text-background"
          : "border border-border text-muted-foreground hover:bg-band"
      )}
    >
      {children}
    </button>
  );
}

function AgentSessionRow({
  session,
  projectId,
  getDuration,
}: {
  session: AgentSession;
  projectId: string;
  getDuration: (s: AgentSession) => string;
}) {
  const config = STATUS_CONFIG[session.status] || STATUS_CONFIG.pending;
  const Icon = config.icon;
  const isRunning = session.status === "running";

  const providerLabel =
    session.namedAgentName ||
    (session.provider
      ? (PROVIDER_LABELS[session.provider as keyof typeof PROVIDER_LABELS] ??
        session.provider)
      : "Agent");
  const typeLabel = session.agentType
    ? (AGENT_TYPE_LABELS[session.agentType] ?? session.agentType)
    : session.mode;
  const target = [`${session.id.slice(0, 8)}`, session.branchName || session.mode]
    .filter(Boolean)
    .join(" · ");

  return (
    <Link
      href={`/projects/${projectId}/sessions/${session.id}`}
      data-testid={`session-row-${session.id}`}
      className={cn(
        "grid items-center gap-[14px] border-b border-border-soft px-[22px] py-[14px] transition-colors hover:bg-card",
        TABLE_GRID
      )}
    >
      <div className="flex min-w-0 items-center gap-[10px]">
        {isRunning ? (
          <span className="breathing-dot h-[7px] w-[7px] shrink-0" />
        ) : (
          <Icon className={cn("h-[14px] w-[14px] shrink-0", config.color)} />
        )}
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-[13.5px] font-medium">
            {providerLabel} · {typeLabel}
          </span>
          <span className="truncate font-mono text-[11px] text-meta">
            {target}
          </span>
        </div>
      </div>

      <div className="flex min-w-0 flex-col gap-[3px]">
        <span className={cn("truncate text-[13px]", config.color)}>
          {config.label}
        </span>
        {session.error ? (
          <span className="truncate font-mono text-[11px] text-destructive">
            {session.error}
          </span>
        ) : (
          <SessionOutcomeBadge outcome={session.outcome} />
        )}
      </div>

      <span className="truncate font-mono text-[12px] text-muted-foreground">
        {getDuration(session)}
      </span>
      <LastActivity value={session.lastActivityAt} sessionId={session.id} />
      <span
        className="truncate font-mono text-[12px] text-muted-foreground"
        title="Session cost (when reported by the provider)"
      >
        {formatCostUsd(session.totalCostUsd) ?? "—"}
      </span>
      <span className="justify-self-end text-[12.5px] text-muted-foreground">
        Open
      </span>
    </Link>
  );
}

function ChatSessionRow({
  session,
  projectId,
}: {
  session: ChatSession;
  projectId: string;
}) {
  const isGenerating = session.status === "generating";
  const TypeIcon = session.type === "epic" ? Sparkles : MessageSquare;
  const providerLabel =
    session.namedAgentName ||
    (session.provider
      ? (PROVIDER_LABELS[session.provider as keyof typeof PROVIDER_LABELS] ??
        session.provider)
      : "Chat");

  return (
    <Link
      href={`/projects/${projectId}/sessions/chat/${session.id}`}
      data-testid={`session-row-${session.id}`}
      className={cn(
        "grid items-center gap-[14px] border-b border-border-soft px-[22px] py-[14px] transition-colors hover:bg-card",
        TABLE_GRID
      )}
    >
      <div className="flex min-w-0 items-center gap-[10px]">
        {isGenerating ? (
          <span className="breathing-dot h-[7px] w-[7px] shrink-0" />
        ) : (
          <TypeIcon className="h-[14px] w-[14px] shrink-0 text-meta" />
        )}
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-[13.5px] font-medium">
            {providerLabel} · chat
          </span>
          <span className="truncate font-mono text-[11px] text-meta">
            {session.label}
            {session.messageCount > 0
              ? ` · ${session.messageCount} message${
                  session.messageCount === 1 ? "" : "s"
                }`
              : ""}
          </span>
        </div>
      </div>

      <span
        className={cn(
          "truncate text-[13px]",
          isGenerating ? "text-agent" : "text-muted-foreground"
        )}
      >
        {isGenerating ? "Generating" : "Chat"}
      </span>
      <span className="font-mono text-[12px] text-muted-foreground">—</span>
      <LastActivity value={session.lastActivityAt} sessionId={session.id} />
      <span className="font-mono text-[12px] text-muted-foreground">—</span>
      <span className="justify-self-end text-[12.5px] text-muted-foreground">
        Open
      </span>
    </Link>
  );
}

function LastActivity({
  value,
  sessionId,
}: {
  value: string | null;
  sessionId: string;
}) {
  return (
    <span
      data-testid={`session-activity-${sessionId}`}
      className="truncate font-mono text-[12px] text-muted-foreground"
      title={value ?? undefined}
    >
      {value ? formatTime(value) : "—"}
    </span>
  );
}
