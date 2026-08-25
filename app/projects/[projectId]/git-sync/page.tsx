"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NamedAgentSelect } from "@/components/shared/NamedAgentSelect";
import { SessionPicker } from "@/components/shared/SessionPicker";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useNamedAgentsList } from "@/hooks/useNamedAgentsList";
import { useWorktrees, type WorktreeState } from "@/hooks/useWorktrees";
import { cn } from "@/lib/utils";
import { timeAgo } from "@/lib/utils/format-date";
import {
  Loader2,
  ArrowDownToLine,
  ArrowUpToLine,
  RefreshCw,
  TriangleAlert,
} from "lucide-react";

interface Toast {
  id: string;
  type: "success" | "error";
  message: string;
}

interface StatusResponse {
  data?: {
    branch: string;
    remote: string;
    ahead: number;
    behind: number;
    hasRemoteBranch: boolean;
    lastFetchedAt?: number | null;
    lastFetchError?: string | null;
  };
  error?: string;
}

interface ConflictDiff {
  filePath: string;
  diff: string;
}

/** Worktree state → the token that colors it (agent teal / meta / bug). */
const WORKTREE_STATE_TONE: Record<WorktreeState, string> = {
  running: "text-agent",
  idle: "text-meta",
  orphan: "text-destructive",
};

const WORKTREE_STATE_LABELS: Record<WorktreeState, string> = {
  running: "running",
  idle: "idle",
  orphan: "orphan",
};

function diffLineTone(line: string): string {
  if (line.startsWith("@@")) return "text-meta";
  if (line.startsWith("+++") || line.startsWith("---")) return "text-meta";
  if (line.startsWith("+")) return "text-agent";
  if (line.startsWith("-")) return "text-destructive";
  return "";
}

export default function GitSyncPage() {
  const params = useParams();
  const projectId = params.projectId as string;

  const [remote, setRemote] = useState("origin");
  const [branch, setBranch] = useState("");
  const [ahead, setAhead] = useState(0);
  const [behind, setBehind] = useState(0);
  const [hasRemoteBranch, setHasRemoteBranch] = useState(true);
  const [lastFetchedAt, setLastFetchedAt] = useState<number | null>(null);
  const [lastFetchError, setLastFetchError] = useState<string | null>(null);
  const [loadingStatus, setLoadingStatus] = useState(true);
  const [pulling, setPulling] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [namedAgentId, setNamedAgentId] = useState<string | null>(null);
  const [resumeSessionId, setResumeSessionId] = useState<string | undefined>(undefined);
  const { agents } = useNamedAgentsList();

  const selectedProvider =
    agents.find((agent) => agent.id === namedAgentId)?.provider || "claude-code";
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [conflictDiffs, setConflictDiffs] = useState<ConflictDiff[]>([]);
  const [autoResolveConflicts, setAutoResolveConflicts] = useState(true);

  const showToast = useCallback((type: "success" | "error", message: string) => {
    const id = crypto.randomUUID();
    setToasts((prev) => [...prev, { id, type, message }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4000);
  }, []);

  const statusUrl = useMemo(() => {
    const q = new URLSearchParams();
    q.set("remote", remote);
    if (branch.trim()) q.set("branch", branch.trim());
    return `/api/projects/${projectId}/git/status?${q.toString()}`;
  }, [projectId, remote, branch]);

  const refreshStatus = useCallback(async () => {
    setLoadingStatus(true);
    setError(null);
    try {
      const res = await fetch(statusUrl);
      const json = (await res.json()) as StatusResponse;
      if (!res.ok || !json.data) {
        setError(json.error || "Failed to fetch git status");
        return;
      }

      setBranch(json.data.branch);
      setAhead(json.data.ahead);
      setBehind(json.data.behind);
      setHasRemoteBranch(json.data.hasRemoteBranch);
      setLastFetchedAt(json.data.lastFetchedAt ?? null);
      setLastFetchError(json.data.lastFetchError ?? null);
    } catch {
      setError("Failed to fetch git status");
    } finally {
      setLoadingStatus(false);
    }
  }, [statusUrl]);

  useEffect(() => {
    refreshStatus();
  }, [refreshStatus]);

  // Declared after the status effect on purpose: the branch counters are the
  // page's headline, so their request must go out first.
  const {
    worktrees,
    orphanCount,
    loading: worktreesLoading,
    error: worktreeError,
    prune: pruneWorktrees,
    pruning: pruningWorktrees,
  } = useWorktrees(projectId);

  async function handlePull() {
    setPulling(true);
    setError(null);
    setMessage(null);
    setConflictDiffs([]);

    try {
      const res = await fetch(`/api/projects/${projectId}/git/pull`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          remote,
          branch: branch.trim() || undefined,
          autoResolveConflicts,
          namedAgentId,
          resumeSessionId,
        }),
      });

      const json = await res.json();
      if (res.status === 202) {
        setMessage(`Conflicts detected. Resolution agent started (session ${json.data?.sessionId}).`);
        showToast("success", "Conflict resolution agent started");
        await refreshStatus();
        return;
      }

      if (res.status === 409 && json.conflicted) {
        setError(json.error || "Merge conflicts detected");
        showToast("error", "Merge conflicts detected");
        setConflictDiffs(Array.isArray(json.conflictDiffs) ? json.conflictDiffs : []);
        return;
      }

      if (!res.ok) {
        setError(json.error || "Pull failed");
        showToast("error", json.error || "Pull failed");
        return;
      }

      setMessage("Pull completed successfully.");
      showToast("success", "Pull completed successfully");
      await refreshStatus();
    } catch {
      setError("Pull failed");
      showToast("error", "Pull failed");
    } finally {
      setPulling(false);
    }
  }

  async function handlePush() {
    setPushing(true);
    setError(null);
    setMessage(null);

    try {
      const res = await fetch(`/api/projects/${projectId}/git/push`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          remote,
          branch: branch.trim() || undefined,
        }),
      });

      const json = await res.json();
      if (!res.ok) {
        setError(json.error || "Push failed");
        showToast("error", json.error || "Push failed");
        return;
      }

      setMessage("Push completed successfully.");
      showToast("success", "Push completed successfully");
      await refreshStatus();
    } catch {
      setError("Push failed");
      showToast("error", "Push failed");
    } finally {
      setPushing(false);
    }
  }

  const rows: Array<{ key: string; value: ReactNode }> = [
    {
      key: "Ahead",
      value: `${ahead} commit${ahead === 1 ? "" : "s"}`,
    },
    {
      key: "Behind",
      value: `${behind} commit${behind === 1 ? "" : "s"}`,
    },
    {
      key: "Remote branch",
      value: hasRemoteBranch ? "yes" : "no",
    },
    {
      key: "Last fetch",
      value:
        lastFetchedAt !== null || lastFetchError ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                className={
                  lastFetchError ? "text-priority-yellow" : "text-muted-foreground"
                }
              >
                {lastFetchedAt !== null
                  ? `Synced ${timeAgo(new Date(lastFetchedAt).toISOString())}`
                  : "Never synced"}
              </span>
            </TooltipTrigger>
            <TooltipContent>
              {lastFetchError
                ? `Could not fetch from remote: ${lastFetchError}`
                : "Last successful fetch from the remote"}
            </TooltipContent>
          </Tooltip>
        ) : (
          <span className="text-meta">—</span>
        ),
    },
  ];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-none items-start gap-[16px] px-[26px] pb-[18px] pt-[24px]">
        <div className="flex flex-col gap-[5px]">
          <h2 className="text-[19px] font-semibold">Git Sync</h2>
          <p className="text-[13px] text-muted-foreground">
            Repository state and assisted conflict resolution.
          </p>
        </div>
        <div className="ml-auto flex items-center gap-[9px]">
          <Button
            variant="outline"
            className="h-[31px] rounded-[8px] px-[12px] text-[13px]"
            onClick={refreshStatus}
            disabled={loadingStatus}
          >
            {loadingStatus ? (
              <Loader2 className="h-[14px] w-[14px] animate-spin" />
            ) : (
              <RefreshCw className="h-[14px] w-[14px]" />
            )}
            Refresh
          </Button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 gap-[22px] overflow-y-auto px-[26px] pb-[26px]">
        <div className="flex min-w-0 flex-1 flex-col gap-[18px]">
          <div className="flex flex-col gap-[18px] rounded-[12px] border border-border bg-card p-[20px]">
            <div className="flex flex-wrap gap-[16px]">
              <div className="flex flex-col gap-[6px]">
                <label className="text-[12px] text-muted-foreground">
                  Remote
                </label>
                <Input
                  value={remote}
                  onChange={(e) => setRemote(e.target.value)}
                  className="h-[34px] w-[160px] rounded-[8px] font-mono text-[12.5px]"
                />
              </div>
              <div className="flex flex-col gap-[6px]">
                <label className="text-[12px] text-muted-foreground">
                  Branch
                </label>
                <Input
                  value={branch}
                  onChange={(e) => setBranch(e.target.value)}
                  className="h-[34px] w-[160px] rounded-[8px] font-mono text-[12.5px]"
                />
              </div>
            </div>

            <div className="flex flex-col">
              {rows.map((row, index) => (
                <div
                  key={row.key}
                  className={cn(
                    "flex items-center justify-between border-t border-border-soft py-[11px]",
                    index === rows.length - 1 && "border-b"
                  )}
                >
                  <span className="text-[12.5px] text-muted-foreground">
                    {row.key}
                  </span>
                  <span className="text-[13px]">{row.value}</span>
                </div>
              ))}
            </div>

            <div className="flex flex-wrap items-center gap-[9px] text-[13px]">
              <label className="flex items-center gap-[9px]">
                <input
                  type="checkbox"
                  checked={autoResolveConflicts}
                  onChange={(e) => setAutoResolveConflicts(e.target.checked)}
                  className="h-[15px] w-[15px] accent-primary"
                />
                Auto-resolve pull conflicts with agent
              </label>
              <div className="ml-auto flex flex-wrap items-center gap-[9px]">
                <NamedAgentSelect
                  value={namedAgentId}
                  onChange={(next: string) => setNamedAgentId(next)}
                  className="h-[31px] w-[220px] rounded-[8px] text-[12.5px]"
                  dispatchRole="merge"
                />
                <SessionPicker
                  projectId={projectId}
                  agentType="merge"
                  namedAgentId={namedAgentId}
                  provider={selectedProvider}
                  selectedSessionId={resumeSessionId}
                  onSelect={setResumeSessionId}
                />
              </div>
            </div>

            <div className="flex gap-[10px]">
              <Button
                className="h-[31px] rounded-[8px] px-[13px] text-[13px]"
                onClick={handlePull}
                disabled={pulling || loadingStatus}
              >
                {pulling ? (
                  <Loader2 className="h-[14px] w-[14px] animate-spin" />
                ) : (
                  <ArrowDownToLine className="h-[14px] w-[14px]" />
                )}
                Pull
              </Button>
              <Button
                variant="outline"
                className="h-[31px] rounded-[8px] px-[12px] text-[13px]"
                onClick={handlePush}
                disabled={pushing || loadingStatus}
              >
                {pushing ? (
                  <Loader2 className="h-[14px] w-[14px] animate-spin" />
                ) : (
                  <ArrowUpToLine className="h-[14px] w-[14px]" />
                )}
                Push
              </Button>
            </div>

            {message && <p className="text-[13px] text-agent">{message}</p>}
            {error && <p className="text-[13px] text-destructive">{error}</p>}
          </div>

          {conflictDiffs.length > 0 && (
            <div className="flex flex-col gap-[12px] rounded-[12px] border border-border bg-card p-[20px]">
              <div className="flex items-center gap-[10px]">
                <TriangleAlert className="h-[15px] w-[15px] flex-none text-destructive" />
                <h3 className="text-[14px] font-semibold">
                  Manual Conflict Review
                </h3>
              </div>
              {conflictDiffs.map((item) => (
                <div key={item.filePath} className="flex flex-col gap-[8px]">
                  <div className="font-mono text-[11.5px] text-meta">
                    {item.filePath}
                  </div>
                  <div className="overflow-x-auto rounded-[10px] bg-band p-[14px] font-mono text-[11.5px] leading-[1.8]">
                    {(item.diff || "No diff output available.")
                      .split("\n")
                      .map((line, index) => (
                        <div
                          key={index}
                          className={cn(
                            "whitespace-pre-wrap",
                            diffLineTone(line)
                          )}
                        >
                          {line || " "}
                        </div>
                      ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <aside className="hidden w-[330px] flex-none flex-col gap-[16px] lg:flex">
          <div
            className="flex flex-col gap-[10px] rounded-[12px] border border-border p-[18px]"
            data-testid="git-sync-worktrees"
          >
            <span className="text-[11.5px] uppercase tracking-[.08em] text-meta">
              Agent worktrees
            </span>

            {worktreeError ? (
              <span className="text-[13px] leading-[1.55] text-muted-foreground">
                {worktreeError}
              </span>
            ) : worktrees.length === 0 ? (
              <span className="text-[13px] leading-[1.55] text-muted-foreground">
                {worktreesLoading
                  ? "Reading worktrees…"
                  : "No agent worktrees right now."}
              </span>
            ) : (
              <div className="flex flex-col">
                {worktrees.map((worktree) => (
                  <div
                    key={worktree.path}
                    data-testid={`worktree-row-${worktree.branch ?? worktree.path}`}
                    className="flex items-center justify-between gap-[10px] border-b border-border-soft py-[9px] last:border-b-0"
                  >
                    <div className="flex min-w-0 flex-col gap-[2px]">
                      <span className="truncate font-mono text-[12px]">
                        {worktree.branch ?? "(detached)"}
                      </span>
                      {worktree.epicReadableId && (
                        <span className="font-mono text-[11px] text-meta">
                          {worktree.epicReadableId}
                        </span>
                      )}
                    </div>
                    <span
                      className={cn(
                        "flex-none text-[11.5px]",
                        WORKTREE_STATE_TONE[worktree.state]
                      )}
                    >
                      {WORKTREE_STATE_LABELS[worktree.state]}
                    </span>
                  </div>
                ))}
              </div>
            )}

            <button
              type="button"
              onClick={() => void pruneWorktrees()}
              disabled={orphanCount === 0 || pruningWorktrees}
              data-testid="worktree-prune-button"
              className="self-start text-[12.5px] text-primary hover:underline disabled:cursor-not-allowed disabled:text-meta disabled:no-underline"
            >
              {orphanCount > 0
                ? `Clean orphan worktrees (${orphanCount})`
                : "Clean orphan worktrees"}
            </button>
          </div>

          <div className="flex flex-col gap-[10px] rounded-[12px] border border-border p-[18px]">
            <span className="text-[11.5px] uppercase tracking-[.08em] text-meta">
              arji.json sync
            </span>
            <span className="text-[13.5px] leading-[1.55] text-muted-foreground">
              The board is also a versioned file. Importing it overwrites the
              local database — run it from the sync action in the project
              header.
            </span>
          </div>
        </aside>
      </div>

      {toasts.length > 0 && (
        <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2">
          {toasts.map((toast) => (
            <div
              key={toast.id}
              className={cn(
                "animate-in fade-in slide-in-from-bottom-2 rounded-[10px] px-4 py-2 text-[13px] font-medium shadow-[0_8px_20px_rgba(58,48,44,.16)] transition-all",
                toast.type === "success"
                  ? "bg-agent text-background"
                  : "bg-destructive text-background"
              )}
            >
              {toast.message}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
