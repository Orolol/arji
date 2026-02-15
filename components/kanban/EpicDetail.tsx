"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { TooltipProvider } from "@/components/ui/tooltip";
import { InlineEdit } from "./InlineEdit";
import { GitSyncBadge } from "./GitSyncBadge";
import { useEpicDetail } from "@/hooks/useEpicDetail";
import { useEpicComments } from "@/hooks/useEpicComments";
import { useEpicAgent } from "@/hooks/useEpicAgent";
import { useGitHubConfig } from "@/hooks/useGitHubConfig";
import { useGitStatus } from "@/hooks/useGitStatus";
import { EpicActions } from "@/components/epic/EpicActions";
import { UserStoryQuickActions } from "@/components/epic/UserStoryQuickActions";
import { CommentThread } from "@/components/story/CommentThread";
import { Badge } from "@/components/ui/badge";
import { PRIORITY_LABELS, KANBAN_COLUMNS, COLUMN_LABELS } from "@/lib/types/kanban";
import { useEpicPr } from "@/hooks/useEpicPr";
import { PrBadge } from "@/components/github/PrBadge";
import { Plus, Trash2, Check, Circle, Loader2, GitBranch, GitMerge, GitPullRequest, Wrench, ArrowUp, ArrowDown, Upload, RefreshCw, Bug } from "lucide-react";
import { useState, useEffect, useRef } from "react";
import Link from "next/link";
import { isAgentAlreadyRunningError } from "@/lib/agents/client-error";
import { NamedAgentSelect } from "@/components/shared/NamedAgentSelect";
import { SessionPicker } from "@/components/shared/SessionPicker";
import { PermanentDeleteDialog } from "@/components/shared/PermanentDeleteDialog";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { DependencyEditor } from "@/components/dependencies/DependencyEditor";

interface EpicDetailProps {
  projectId: string;
  epicId: string | null;
  open: boolean;
  onClose: () => void;
  onMerged?: () => void;
  onDeleted?: () => void;
  onAgentConflict?: (args: { message: string; sessionUrl?: string }) => void;
}

export function EpicDetail({
  projectId,
  epicId,
  open,
  onClose,
  onMerged,
  onDeleted,
  onAgentConflict,
}: EpicDetailProps) {
  const {
    epic,
    userStories,
    loading,
    updateEpic,
    addUserStory,
    updateUserStory,
    deleteUserStory,
    refresh,
    setPolling,
  } = useEpicDetail(projectId, epicId);

  const {
    comments,
    loading: commentsLoading,
    addComment,
  } = useEpicComments(projectId, epicId);

  const {
    activeSession,
    dispatching,
    isRunning,
    sendToDev,
    sendToReview,
    resolveMerge,
    approve,
  } = useEpicAgent(projectId, epicId);

  const {
    pr,
    loading: prLoading,
    error: prError,
    createPr,
    syncPr,
  } = useEpicPr(projectId, epicId);

  const { isConfigured: githubConfigured } = useGitHubConfig(projectId);
  const {
    ahead,
    behind,
    loading: gitStatusLoading,
    error: gitStatusError,
    refresh: refreshGitStatus,
    push: pushToRemote,
    pushing,
  } = useGitStatus(projectId, epic?.branchName ?? null, githubConfigured);

  // Only poll epic detail when an agent is actively running
  useEffect(() => {
    setPolling(isRunning);
  }, [isRunning, setPolling]);

  const [newUSTitle, setNewUSTitle] = useState("");
  const [projectEpics, setProjectEpics] = useState<
    Array<{ id: string; title: string; status: string }>
  >([]);

  // Fetch all epics in the project for the dependency dropdown
  useEffect(() => {
    if (!open || !epicId) return;
    fetch(`/api/projects/${projectId}/epics`)
      .then((r) => r.json())
      .then((d) => {
        if (d.data) setProjectEpics(d.data);
      })
      .catch(() => {});
  }, [projectId, epicId, open]);

  const [merging, setMerging] = useState(false);
  const [mergeError, setMergeError] = useState<string | null>(null);
  const [resolvingMerge, setResolvingMerge] = useState(false);
  const [resolveMergeOpen, setResolveMergeOpen] = useState(false);
  const [resolveMergeAgentId, setResolveMergeAgentId] = useState<string | null>(null);
  const [resolveMergeResumeSessionId, setResolveMergeResumeSessionId] = useState<string | undefined>();
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deletingEpic, setDeletingEpic] = useState(false);
  const [deleteEpicError, setDeleteEpicError] = useState<string | null>(null);
  const deleteInFlightRef = useRef(false);

  async function handleMerge() {
    if (!epicId) return;
    setMerging(true);
    setMergeError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/epics/${epicId}/merge`, {
        method: "POST",
      });
      const data = await res.json();
      if (data.error) {
        setMergeError(data.error);
      } else {
        onMerged?.();
        onClose();
      }
    } catch {
      setMergeError("Failed to merge");
    }
    setMerging(false);
  }

  async function handleResolveMerge(namedAgentId?: string | null, resumeSessionId?: string) {
    if (!epicId) return;
    setResolvingMerge(true);
    try {
      const result = await resolveMerge(namedAgentId, resumeSessionId);
      if (result?.clean) {
        setMergeError(null);
        onMerged?.();
        onClose();
      } else {
        setMergeError(null);
      }
      setResolveMergeOpen(false);
      setResolveMergeResumeSessionId(undefined);
    } catch (e) {
      if (isAgentAlreadyRunningError(e)) {
        onAgentConflict?.({
          message: e.message,
          sessionUrl: e.sessionUrl || `/projects/${projectId}/sessions/${e.activeSessionId}`,
        });
      }
      setMergeError(e instanceof Error ? e.message : "Failed to resolve merge");
    }
    setResolvingMerge(false);
  }

  async function handleApprove() {
    await approve();
    refresh();
  }

  async function handleSendToDev(comment?: string, namedAgentId?: string | null, resumeSessionId?: string) {
    await sendToDev(comment, namedAgentId, resumeSessionId);
    refresh();
  }

  async function handleSendToReview(types: string[], namedAgentId?: string | null, resumeSessionId?: string) {
    await sendToReview(types, namedAgentId, resumeSessionId);
    refresh();
  }

  async function handleDeleteEpic() {
    if (!epicId || deleteInFlightRef.current) return;
    deleteInFlightRef.current = true;
    setDeletingEpic(true);
    setDeleteEpicError(null);

    try {
      const res = await fetch(`/api/projects/${projectId}/epics/${epicId}`, {
        method: "DELETE",
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok || data.error) {
        setDeleteEpicError(data.error || "Failed to delete epic");
        return;
      }

      setDeleteDialogOpen(false);
      onClose();
      onDeleted?.();
    } catch {
      setDeleteEpicError("Failed to delete epic");
    } finally {
      deleteInFlightRef.current = false;
      setDeletingEpic(false);
    }
  }

  function handleAddUS() {
    if (!newUSTitle.trim()) return;
    addUserStory(newUSTitle.trim());
    setNewUSTitle("");
  }

  const statusIcon = (status: string) => {
    switch (status) {
      case "done":
        return <Check className="h-3.5 w-3.5 text-green-500" />;
      case "in_progress":
        return <Loader2 className="h-3.5 w-3.5 text-yellow-500" />;
      default:
        return <Circle className="h-3.5 w-3.5 text-muted-foreground" />;
    }
  };

  if (!open) return null;

  return (
    <div className="h-full overflow-y-auto" data-testid="epic-detail-panel">
      {loading || !epic ? (
        <>
          <div className="border-b border-border px-4 py-3">
            <h2 className="text-base font-semibold">Epic</h2>
          </div>
          <div className="py-8 text-center text-muted-foreground">
            Loading...
          </div>
        </>
      ) : (
        <>
          <div className="border-b border-border px-4 py-3 space-y-2">
            <InlineEdit
              value={epic.title}
              onSave={(v) => updateEpic({ title: v })}
              className="text-lg font-bold"
            />
            {epic.type === "bug" && (
              <Badge className="bg-red-500/10 text-red-400 text-xs w-fit">
                <Bug className="h-3 w-3 mr-1" />
                Bug
              </Badge>
            )}
          </div>

          <div className="px-4 py-4 space-y-4">
            {/* Epic Actions Bar */}
            <EpicActions
              projectId={projectId}
              epic={epic}
              dispatching={dispatching}
              isRunning={isRunning}
              activeSessionId={activeSession?.id || null}
              onSendToDev={handleSendToDev}
              onSendToReview={handleSendToReview}
              onApprove={handleApprove}
              onActionError={(error) => {
                if (isAgentAlreadyRunningError(error)) {
                  onAgentConflict?.({
                    message: error.message,
                    sessionUrl:
                      error.sessionUrl ||
                      `/projects/${projectId}/sessions/${error.activeSessionId}`,
                  });
                  return;
                }
                onAgentConflict?.({
                  message:
                    error instanceof Error
                      ? error.message
                      : "Failed to run agent action",
                });
              }}
            />

            <div>
              <label className="text-xs text-muted-foreground block mb-1">
                Description
              </label>
              <InlineEdit
                value={epic.description || ""}
                onSave={(v) => updateEpic({ description: v })}
                multiline
                markdown
                className="text-sm"
              />
            </div>

            <div className="flex gap-4">
              <div className="flex-1">
                <label className="text-xs text-muted-foreground block mb-1">
                  Priority
                </label>
                <Select
                  value={String(epic.priority)}
                  onValueChange={(v) => updateEpic({ priority: Number(v) } as never)}
                >
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(PRIORITY_LABELS).map(([k, v]) => (
                      <SelectItem key={k} value={k}>
                        {v}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex-1">
                <label className="text-xs text-muted-foreground block mb-1">
                  Status
                </label>
                <Select
                  value={epic.status}
                  onValueChange={(v) => updateEpic({ status: v })}
                >
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {KANBAN_COLUMNS.map((col) => (
                      <SelectItem key={col} value={col}>
                        {COLUMN_LABELS[col]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {epic.type === "bug" && epic.linkedEpicId && (
              <div className="text-xs text-muted-foreground">
                Linked to epic: <span className="font-mono">{epic.linkedEpicId}</span>
              </div>
            )}

            {epic.branchName && (
              <div className="space-y-2">
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground font-mono">
                  <GitBranch className="h-3 w-3" />
                  <span className="flex-1 truncate">{epic.branchName}</span>
                  {githubConfigured && (
                    <GitSyncBadge
                      projectId={projectId}
                      branchName={epic.branchName}
                      disabled={isRunning}
                    />
                  )}
                </div>

                {/* Git sync status — only shown when GitHub is configured */}
                {githubConfigured && (
                  <div className="flex items-center gap-2 flex-wrap">
                    {gitStatusLoading ? (
                      <Badge variant="outline" className="gap-1 text-xs">
                        <Loader2 className="h-3 w-3 animate-spin" />
                        Checking...
                      </Badge>
                    ) : (
                      <>
                        <Badge variant="outline" className="gap-1 text-xs">
                          <ArrowUp className="h-3 w-3" />
                          {ahead}
                        </Badge>
                        <Badge variant="outline" className="gap-1 text-xs">
                          <ArrowDown className="h-3 w-3" />
                          {behind}
                        </Badge>
                      </>
                    )}

                    {gitStatusError && (
                      <span className="text-xs text-destructive">{gitStatusError}</span>
                    )}

                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={refreshGitStatus}
                      disabled={gitStatusLoading}
                      className="h-6 w-6 p-0"
                    >
                      <RefreshCw className={`h-3 w-3 ${gitStatusLoading ? "animate-spin" : ""}`} />
                    </Button>

                    {ahead > 0 && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={pushToRemote}
                        disabled={pushing || gitStatusLoading}
                        className="h-7 text-xs"
                      >
                        {pushing ? (
                          <Loader2 className="h-3 w-3 animate-spin mr-1" />
                        ) : (
                          <Upload className="h-3 w-3 mr-1" />
                        )}
                        Push
                      </Button>
                    )}
                  </div>
                )}

                {/* PR Section */}
                {githubConfigured && (
                  <div className="space-y-2">
                    {pr ? (
                      <div className="flex items-center gap-2 flex-wrap">
                        <PrBadge
                          status={pr.status}
                          number={pr.number}
                          url={pr.url}
                        />
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={syncPr}
                          disabled={prLoading}
                          className="h-6 text-xs px-2"
                        >
                          {prLoading ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            <RefreshCw className="h-3 w-3" />
                          )}
                          <span className="ml-1">Sync</span>
                        </Button>
                      </div>
                    ) : (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => createPr()}
                        disabled={prLoading}
                        className="h-7 text-xs"
                      >
                        {prLoading ? (
                          <Loader2 className="h-3 w-3 animate-spin mr-1" />
                        ) : (
                          <GitPullRequest className="h-3 w-3 mr-1" />
                        )}
                        Create PR
                      </Button>
                    )}
                    {prError && (
                      <p className="text-xs text-destructive">{prError}</p>
                    )}
                  </div>
                )}

                {(epic.status === "review" || epic.status === "done") && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={handleMerge}
                    disabled={merging}
                    className="h-7 text-xs"
                  >
                    {merging ? (
                      <Loader2 className="h-3 w-3 animate-spin mr-1" />
                    ) : (
                      <GitMerge className="h-3 w-3 mr-1" />
                    )}
                    Merge into main
                  </Button>
                )}
                {mergeError && (
                  <div className="flex items-center gap-2">
                    <p className="text-xs text-destructive flex-1">{mergeError}</p>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setResolveMergeOpen(true)}
                      disabled={resolvingMerge || isRunning}
                      className="h-7 text-xs shrink-0"
                    >
                      {resolvingMerge ? (
                        <Loader2 className="h-3 w-3 animate-spin mr-1" />
                      ) : (
                        <Wrench className="h-3 w-3 mr-1" />
                      )}
                      Resolve with Agent
                    </Button>
                  </div>
                )}
              </div>
            )}

            <Separator />

            {/* User Stories */}
            {epic.type !== "bug" && (
            <div>
              <div className="flex items-center justify-between mb-2">
                <h4 className="text-sm font-medium">
                  User Stories ({userStories.length})
                </h4>
              </div>

              <TooltipProvider>
                <div className="space-y-1">
                  {userStories.map((us) => (
                    <div
                      key={us.id}
                      className="flex items-center gap-2 p-2 rounded hover:bg-accent/50 group"
                    >
                      <button
                        onClick={() => {
                          const next =
                            us.status === "done"
                              ? "todo"
                              : us.status === "todo"
                                ? "in_progress"
                                : "done";
                          updateUserStory(us.id, { status: next });
                        }}
                      >
                        {statusIcon(us.status)}
                      </button>
                      <Link
                        href={`/projects/${projectId}/stories/${us.id}`}
                        className={`flex-1 text-sm hover:underline ${
                          us.status === "done"
                            ? "line-through text-muted-foreground"
                            : ""
                        }`}
                      >
                        {us.title}
                      </Link>
                      <UserStoryQuickActions
                        projectId={projectId}
                        story={us}
                        onRefresh={refresh}
                        isLocked={dispatching || isRunning}
                        lockReason="Another agent is already running for this epic."
                      />
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6 opacity-0 group-hover:opacity-100"
                        onClick={() => deleteUserStory(us.id)}
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </div>
                  ))}
                </div>
              </TooltipProvider>

              <div className="flex gap-2 mt-2">
                <Input
                  value={newUSTitle}
                  onChange={(e) => setNewUSTitle(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleAddUS()}
                  placeholder="Add user story..."
                  className="text-sm h-8"
                />
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handleAddUS}
                  disabled={!newUSTitle.trim()}
                  className="h-8"
                >
                  <Plus className="h-3 w-3" />
                </Button>
              </div>
            </div>
            )}

            <Separator />

            {/* Dependencies */}
            {epicId && (
              <DependencyEditor
                projectId={projectId}
                epicId={epicId}
                projectEpics={projectEpics}
              />
            )}

            <Separator />

            {/* Comment Thread */}
            <div className="min-h-[200px]">
                <CommentThread
                  projectId={projectId}
                  comments={comments}
                  loading={commentsLoading}
                  onAddComment={addComment}
              />
            </div>

            <Separator />

            <div className="space-y-2">
              <h4 className="text-sm font-medium text-destructive">Danger Zone</h4>
              <p className="text-xs text-muted-foreground">
                Permanently delete this epic, all child stories, and dependent
                planning records.
              </p>
              {deleteEpicError && (
                <p className="text-xs text-destructive">{deleteEpicError}</p>
              )}
              <Button
                size="sm"
                variant="destructive"
                className="h-8 text-xs"
                onClick={() => setDeleteDialogOpen(true)}
                disabled={deletingEpic}
              >
                Delete Epic
              </Button>
            </div>
          </div>
        </>
      )}

      <Dialog open={resolveMergeOpen} onOpenChange={(open) => { setResolveMergeOpen(open); if (!open) setResolveMergeResumeSessionId(undefined); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Resolve Merge Conflicts</DialogTitle>
            <DialogDescription>
              Launch an agent to resolve merge conflicts for this epic.
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-2 mb-2">
            <span className="text-sm text-muted-foreground">Agent:</span>
            <NamedAgentSelect
              value={resolveMergeAgentId}
              onChange={setResolveMergeAgentId}
              className="w-44 h-8 text-xs"
            />
          </div>
          {epicId && (
            <SessionPicker
              projectId={projectId}
              epicId={epicId}
              agentType="merge"
              namedAgentId={resolveMergeAgentId}
              provider="claude-code"
              selectedSessionId={resolveMergeResumeSessionId}
              onSelect={setResolveMergeResumeSessionId}
            />
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setResolveMergeOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => handleResolveMerge(resolveMergeAgentId, resolveMergeResumeSessionId)}
              disabled={resolvingMerge || isRunning}
            >
              {resolvingMerge ? (
                <Loader2 className="h-4 w-4 animate-spin mr-1" />
              ) : (
                <Wrench className="h-4 w-4 mr-1" />
              )}
              Dispatch Agent
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <PermanentDeleteDialog
        open={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        title="Delete Epic"
        description="Permanently delete this epic and all related user stories."
        confirmLabel="Confirm Delete"
        deleting={deletingEpic}
        onConfirm={handleDeleteEpic}
      />
    </div>
  );
}
