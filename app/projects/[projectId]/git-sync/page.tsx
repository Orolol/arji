"use client";

import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ToastStack } from "@/components/notifications/ToastStack";
import { useToastStack } from "@/components/notifications/useToastStack";
import { NamedAgentSelect } from "@/components/shared/NamedAgentSelect";
import { RepoStrataBand } from "@/components/github/RepoStrataBand";
import { SessionPicker } from "@/components/shared/SessionPicker";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useNamedAgentsList } from "@/hooks/useNamedAgentsList";
import { useWorktrees, type WorktreeState } from "@/hooks/useWorktrees";
import { cn } from "@/lib/utils";
import type { TranslationKey } from "@/lib/i18n/catalogue";
import { formatRelative } from "@/lib/i18n/format";
import {
  Loader2,
  ArrowDownToLine,
  ArrowUpToLine,
  RefreshCw,
  TriangleAlert,
} from "lucide-react";

interface StatusResponse {
  data?: {
    branch: string;
    remote: string;
    ahead: number;
    behind: number;
    hasRemoteBranch: boolean;
    /** null when the server could not read the repository's remote list. */
    remoteConfigured?: boolean | null;
    configuredRemotes?: string[] | null;
    remoteFetchConfigured?: boolean | null;
    remotePushConfigured?: boolean | null;
    fetchRemotes?: string[] | null;
    pushRemotes?: string[] | null;
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

/**
 * A MODULE-SCOPE COPY TABLE, so it holds catalogue KEY REFERENCES and the
 * aside resolves them at render with the namespace-less translator
 * (`lib/i18n/catalogue.ts`, pattern 3).
 */
const WORKTREE_STATE_LABEL_KEYS: Record<WorktreeState, TranslationKey> = {
  running: "GitSync.worktrees.running",
  idle: "GitSync.worktrees.idle",
  orphan: "GitSync.worktrees.orphan",
};

/** The `<mono>` of the missing-remote prose — the remote name, in mono. */
const monoTag = (chunks: ReactNode) => <span className="font-mono">{chunks}</span>;

function diffLineTone(line: string): string {
  if (line.startsWith("@@")) return "text-meta";
  if (line.startsWith("+++") || line.startsWith("---")) return "text-meta";
  if (line.startsWith("+")) return "text-agent";
  if (line.startsWith("-")) return "text-destructive";
  return "";
}

export default function GitSyncPage() {
  const locale = useLocale();
  const t = useTranslations("GitSync");
  // The worktree-state table holds full dotted paths, so it resolves through
  // the namespace-less translator.
  const tKey = useTranslations();
  const params = useParams();
  const projectId = params.projectId as string;

  /**
   * The project record, for the band below: ahead/behind must be measured
   * against the STORED default branch (the one worktrees are cut from), not
   * against whatever branch this page currently has typed in its input.
   */
  const [project, setProject] = useState<{
    gitRepoPath: string | null;
    githubOwnerRepo: string | null;
    defaultBranch: string | null;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/projects/${projectId}`)
      .then((res) => res.json())
      .then((json) => {
        if (cancelled || !json?.data) return;
        setProject({
          gitRepoPath: json.data.gitRepoPath ?? null,
          githubOwnerRepo: json.data.githubOwnerRepo ?? null,
          defaultBranch: json.data.defaultBranch ?? null,
        });
      })
      .catch(() => {
        // The band renders its own "not connected" state; a failed project
        // read must not blank the rest of the page.
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const [remote, setRemote] = useState("origin");
  const [branch, setBranch] = useState("");
  const [ahead, setAhead] = useState(0);
  const [behind, setBehind] = useState(0);
  const [hasRemoteBranch, setHasRemoteBranch] = useState(true);
  // These come from the status read, so the missing-remote affordance is
  // re-derived on every mount instead of living in a push/pull response.
  const [configuredRemotes, setConfiguredRemotes] = useState<string[]>([]);
  const [remoteFetchConfigured, setRemoteFetchConfigured] = useState<
    boolean | null
  >(null);
  const [remotePushConfigured, setRemotePushConfigured] = useState<
    boolean | null
  >(null);
  const [fetchRemotes, setFetchRemotes] = useState<string[]>([]);
  const [pushRemotes, setPushRemotes] = useState<string[]>([]);
  const [lastFetchedAt, setLastFetchedAt] = useState<number | null>(null);
  const [lastFetchError, setLastFetchError] = useState<string | null>(null);
  const [loadingStatus, setLoadingStatus] = useState(true);
  const [pulling, setPulling] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  /**
   * The error line, plus WHERE it came from.
   *
   * On a project with no local repository the status read cannot succeed, and
   * the Repository band above already says so in prose — so that one failure
   * is not repeated in coral underneath it. Every other error is the answer to
   * something the user asked for and is always shown.
   *
   * The provenance is bundled with the message rather than kept beside it: as
   * two independent `useState`s the flag survived an action's `setError(null)`
   * and went on suppressing the action's own failure. Set them together and
   * that cannot drift — `setError` is the ordinary path and always clears the
   * flag; only `refreshStatus` reaches for `setStatusReadError`.
   */
  const [errorState, setErrorState] = useState<{
    message: string | null;
    fromStatusRead: boolean;
  }>({ message: null, fromStatusRead: false });
  const error = errorState.message;
  const setError = useCallback((message: string | null) => {
    setErrorState({ message, fromStatusRead: false });
  }, []);
  const setStatusReadError = useCallback((message: string) => {
    setErrorState({ message, fromStatusRead: true });
  }, []);
  const [namedAgentId, setNamedAgentId] = useState<string | null>(null);
  const [resumeSessionId, setResumeSessionId] = useState<string | undefined>(undefined);
  const { agents } = useNamedAgentsList();

  const selectedProvider =
    agents.find((agent) => agent.id === namedAgentId)?.provider || "claude-code";
  const { toasts, raise: showToast, dismiss: dismissToast } = useToastStack();
  const [conflictDiffs, setConflictDiffs] = useState<ConflictDiff[]>([]);
  const [autoResolveConflicts, setAutoResolveConflicts] = useState(true);

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
        // `json.error` is the route's own text and ships as it came; only the
        // fallback beside it is this screen's copy.
        setStatusReadError(json.error || t("status.readFailed"));
        return;
      }

      setBranch(json.data.branch);
      setAhead(json.data.ahead);
      setBehind(json.data.behind);
      setHasRemoteBranch(json.data.hasRemoteBranch);
      setConfiguredRemotes(json.data.configuredRemotes ?? []);
      setRemoteFetchConfigured(
        json.data.remoteFetchConfigured ?? json.data.remoteConfigured ?? null
      );
      setRemotePushConfigured(
        json.data.remotePushConfigured ?? json.data.remoteConfigured ?? null
      );
      setFetchRemotes(
        json.data.fetchRemotes ?? json.data.configuredRemotes ?? []
      );
      setPushRemotes(
        json.data.pushRemotes ?? json.data.configuredRemotes ?? []
      );
      setLastFetchedAt(json.data.lastFetchedAt ?? null);
      setLastFetchError(json.data.lastFetchError ?? null);
    } catch {
      setStatusReadError(t("status.readFailed"));
    } finally {
      setLoadingStatus(false);
    }
    // Both setters are useCallback([]) and so never change; listed because the
    // exhaustive-deps rule cannot see that, and a silenced warning here is how
    // a real missing dependency gets in later.
  }, [statusUrl, setError, setStatusReadError, t]);

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

  /**
   * The server's own 409 for "this repository has no usable remote" — the one
   * condition on these routes that is a precondition rather than a fault.
   */
  function isRemoteMissingResponse(res: Response, json: { code?: string }) {
    return res.status === 409 && json?.code === "remote_not_configured";
  }

  /**
   * Re-reads the status endpoint so the missing-remote panel comes from the
   * server's view of the repository, then restores the message: `refreshStatus`
   * clears `error` on entry, so setting it first would lose it.
   */
  async function reportMissingRemote(json: { error?: string }) {
    showToast("error", t("remoteMissing.toast"));
    await refreshStatus();
    // The user pressed Push; this is their answer, not the status read's, and
    // `setError` marks it as such.
    setError(json?.error || t("remoteMissing.error"));
  }

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
        setMessage(t("pull.agentStarted", { sessionId: json.data?.sessionId }));
        showToast("success", t("pull.agentStartedToast"));
        await refreshStatus();
        return;
      }

      if (res.status === 409 && json.conflicted) {
        setError(json.error || t("pull.conflicts"));
        showToast("error", t("pull.conflicts"));
        setConflictDiffs(Array.isArray(json.conflictDiffs) ? json.conflictDiffs : []);
        return;
      }

      if (isRemoteMissingResponse(res, json)) {
        await reportMissingRemote(json);
        return;
      }

      if (!res.ok) {
        setError(json.error || t("pull.failed"));
        showToast("error", json.error || t("pull.failed"));
        return;
      }

      setMessage(t("pull.done"));
      showToast("success", t("pull.doneToast"));
      await refreshStatus();
    } catch {
      setError(t("pull.failed"));
      showToast("error", t("pull.failed"));
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
      if (isRemoteMissingResponse(res, json)) {
        await reportMissingRemote(json);
        return;
      }

      if (!res.ok) {
        setError(json.error || t("push.failed"));
        showToast("error", json.error || t("push.failed"));
        return;
      }

      setMessage(t("push.done"));
      showToast("success", t("push.doneToast"));
      await refreshStatus();
    } catch {
      setError(t("push.failed"));
      showToast("error", t("push.failed"));
    } finally {
      setPushing(false);
    }
  }

  // `null` means the server could not read the remote list — unknown, not
  // missing, so the actions stay available.
  const fetchMissing = remoteFetchConfigured === false;
  const pushMissing = remotePushConfigured === false;
  const remoteMissing = fetchMissing && pushMissing;
  const operationMissing = fetchMissing || pushMissing;
  const recoveryRemotes = remoteMissing
    ? configuredRemotes
    : fetchMissing
      ? fetchRemotes
      : pushRemotes;

  const rows: Array<{ id: string; label: string; value: ReactNode }> = [
    {
      id: "ahead",
      label: t("status.ahead"),
      value: t("status.commits", { count: ahead }),
    },
    {
      id: "behind",
      label: t("status.behind"),
      value: t("status.commits", { count: behind }),
    },
    {
      id: "remote-branch",
      label: t("status.remoteBranch"),
      value: hasRemoteBranch ? t("status.yes") : t("status.no"),
    },
    {
      id: "last-fetch",
      label: t("status.lastFetch"),
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
                  ? t("status.synced", {
                      age: formatRelative(lastFetchedAt, { locale }),
                    })
                  : t("status.neverSynced")}
              </span>
            </TooltipTrigger>
            <TooltipContent>
              {lastFetchError
                ? t("status.fetchError", { error: lastFetchError })
                : t("status.lastFetchHint")}
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
          <h2 className="text-[19px] font-semibold">{t("header.title")}</h2>
          <p className="text-[13px] text-muted-foreground">
            {t("header.subtitle")}
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
            {t("header.refresh")}
          </Button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-[18px] overflow-y-auto px-[26px] pb-[26px]">
        {/*
          Repository state, relocated from the pre-redesign RepoStatusBar that
          used to hang under the project board. Full width above the two
          columns: it is the headline of this page.
        */}
        {project ? (
          <RepoStrataBand
            projectId={projectId}
            ownerRepo={project.githubOwnerRepo}
            gitRepoPath={project.gitRepoPath}
            defaultBranch={project.defaultBranch}
          />
        ) : null}

        <div className="flex min-h-0 gap-[22px]">
        <div className="flex min-w-0 flex-1 flex-col gap-[18px]">
          <div className="flex flex-col gap-[18px] rounded-[12px] border border-border bg-card p-[20px]">
            <div className="flex flex-wrap gap-[16px]">
              <div className="flex flex-col gap-[6px]">
                <label
                  htmlFor="git-sync-remote"
                  className="text-[12px] text-muted-foreground"
                >
                  {t("fields.remote")}
                </label>
                <Input
                  id="git-sync-remote"
                  value={remote}
                  onChange={(e) => setRemote(e.target.value)}
                  className="h-[34px] w-[160px] rounded-[8px] font-mono text-[12.5px]"
                />
              </div>
              <div className="flex flex-col gap-[6px]">
                <label
                  htmlFor="git-sync-branch"
                  className="text-[12px] text-muted-foreground"
                >
                  {t("fields.branch")}
                </label>
                <Input
                  id="git-sync-branch"
                  value={branch}
                  onChange={(e) => setBranch(e.target.value)}
                  className="h-[34px] w-[160px] rounded-[8px] font-mono text-[12.5px]"
                />
              </div>
            </div>

            <div className="flex flex-col">
              {rows.map((row, index) => (
                <div
                  key={row.id}
                  className={cn(
                    "flex items-center justify-between border-t border-border-soft py-[11px]",
                    index === rows.length - 1 && "border-b"
                  )}
                >
                  <span className="text-[12.5px] text-muted-foreground">
                    {row.label}
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
                {t("fields.autoResolve")}
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

            {operationMissing && (
              <div
                data-testid={
                  remoteMissing
                    ? "git-remote-missing"
                    : fetchMissing
                      ? "git-remote-fetch-missing"
                      : "git-remote-push-missing"
                }
                className="flex flex-col gap-[10px] rounded-[10px] border border-border-soft bg-band p-[14px]"
              >
                <div className="flex items-center gap-[9px]">
                  <TriangleAlert className="h-[15px] w-[15px] flex-none text-priority-yellow" />
                  <h3 className="text-[13.5px] font-semibold">
                    {remoteMissing
                      ? t("remoteMissing.titleBoth")
                      : fetchMissing
                        ? t("remoteMissing.titleFetch")
                        : t("remoteMissing.titlePush")}
                  </h3>
                </div>
                <p className="text-[12.5px] leading-[1.55] text-muted-foreground">
                  {remoteMissing
                    ? t.rich("remoteMissing.bodyBoth", { remote, mono: monoTag })
                    : fetchMissing
                      ? t.rich("remoteMissing.bodyFetch", {
                          remote,
                          mono: monoTag,
                        })
                      : t.rich("remoteMissing.bodyPush", {
                          remote,
                          mono: monoTag,
                        })}
                </p>
                {recoveryRemotes.length > 0 ? (
                  <div className="flex flex-wrap items-center gap-[9px]">
                    <span className="text-[12.5px] text-muted-foreground">
                      {t("remoteMissing.available")}
                    </span>
                    {recoveryRemotes.map((name) => (
                      <Button
                        key={name}
                        variant="outline"
                        data-testid={`use-remote-${name}`}
                        className="h-[27px] rounded-[8px] px-[10px] font-mono text-[12px]"
                        onClick={() => setRemote(name)}
                      >
                        {t("remoteMissing.use", { remote: name })}
                      </Button>
                    ))}
                  </div>
                ) : (
                  <p
                    data-testid="git-remote-add-hint"
                    className="text-[12.5px] leading-[1.55] text-muted-foreground"
                  >
                    {t("remoteMissing.configureHint")}{" "}
                    {/* A shell command, not copy: it is typed verbatim. */}
                    <span className="font-mono">
                      {remoteMissing
                        ? `git remote add ${remote} <url>`
                        : fetchMissing
                          ? `git remote set-url ${remote} <url>`
                          : `git remote set-url --push ${remote} <url>`}
                    </span>
                  </p>
                )}
              </div>
            )}

            <div className="flex gap-[10px]">
              <Button
                className="h-[31px] rounded-[8px] px-[13px] text-[13px]"
                onClick={handlePull}
                disabled={pulling || loadingStatus || fetchMissing}
              >
                {pulling ? (
                  <Loader2 className="h-[14px] w-[14px] animate-spin" />
                ) : (
                  <ArrowDownToLine className="h-[14px] w-[14px]" />
                )}
                {t("actions.pull")}
              </Button>
              <Button
                variant="outline"
                className="h-[31px] rounded-[8px] px-[12px] text-[13px]"
                onClick={handlePush}
                disabled={pushing || loadingStatus || pushMissing}
              >
                {pushing ? (
                  <Loader2 className="h-[14px] w-[14px] animate-spin" />
                ) : (
                  <ArrowUpToLine className="h-[14px] w-[14px]" />
                )}
                {t("actions.push")}
              </Button>
            </div>

            {message && <p className="text-[13px] text-agent">{message}</p>}
            {/*
              Missing configuration is not an error. With no repository path
              the status read cannot succeed, and the band above already names
              what is missing and how to supply it; repeating that in coral
              would make an unconfigured project look broken.

              ONLY the status read is silenced. An action's failure is the
              user's own request answering back — a mid-session 409 from Push
              on a repository whose remote disappeared has to be visible, and
              suppressing every error on an unconfigured project swallowed it.
            */}
            {error && !(errorState.fromStatusRead && project?.gitRepoPath === null) && (
              <p data-testid="git-sync-error" className="text-[13px] text-destructive">
                {error}
              </p>
            )}
          </div>

          {conflictDiffs.length > 0 && (
            <div className="flex flex-col gap-[12px] rounded-[12px] border border-border bg-card p-[20px]">
              <div className="flex items-center gap-[10px]">
                <TriangleAlert className="h-[15px] w-[15px] flex-none text-destructive" />
                <h3 className="text-[14px] font-semibold">
                  {t("conflicts.title")}
                </h3>
              </div>
              {conflictDiffs.map((item) => (
                <div key={item.filePath} className="flex flex-col gap-[8px]">
                  <div className="font-mono text-[11.5px] text-meta">
                    {item.filePath}
                  </div>
                  <div className="overflow-x-auto rounded-[10px] bg-band p-[14px] font-mono text-[11.5px] leading-[1.8]">
                    {(item.diff || t("conflicts.noDiff"))
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
              {t("worktrees.title")}
            </span>

            {worktreeError ? (
              <span className="text-[13px] leading-[1.55] text-muted-foreground">
                {worktreeError}
              </span>
            ) : worktrees.length === 0 ? (
              <span className="text-[13px] leading-[1.55] text-muted-foreground">
                {worktreesLoading
                  ? t("worktrees.loading")
                  : t("worktrees.empty")}
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
                        {worktree.branch ?? t("worktrees.detached")}
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
                      {tKey(WORKTREE_STATE_LABEL_KEYS[worktree.state])}
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
                ? t("worktrees.pruneCount", { count: orphanCount })
                : t("worktrees.prune")}
            </button>
          </div>

          <div className="flex flex-col gap-[10px] rounded-[12px] border border-border p-[18px]">
            <span className="text-[11.5px] uppercase tracking-[.08em] text-meta">
              {t("arji.title")}
            </span>
            <span className="text-[13.5px] leading-[1.55] text-muted-foreground">
              {t("arji.body")}
            </span>
          </div>
        </aside>
        </div>
      </div>

      <ToastStack items={toasts} onDismiss={dismissToast} testId="git-sync-toast" />
    </div>
  );
}
