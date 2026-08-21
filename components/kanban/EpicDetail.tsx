"use client";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { InlineEdit } from "./InlineEdit";
import { useEpicDetail } from "@/hooks/useEpicDetail";
import { useTicketComments } from "@/hooks/useTicketComments";
import { useAgentDispatch } from "@/hooks/useAgentDispatch";
import { useGitHubConfig } from "@/hooks/useGitHubConfig";
import { useGitStatus } from "@/hooks/useGitStatus";
import { useProjectEpicsList } from "@/hooks/useProjectEpicsList";
import { useEpicMutations } from "@/hooks/useEpicMutations";
import { AgentActionsBar } from "@/components/shared/AgentActionsBar";
import { AgentDispatchDialog } from "@/components/shared/AgentDispatchDialog";
import { TicketTypeBadge } from "@/components/shared/TicketTypeBadge";
import { EpicActivityFeed } from "./epic-detail/EpicActivityFeed";
import { PRIORITY_LABELS, KANBAN_COLUMNS, COLUMN_LABELS } from "@/lib/types/kanban";
import { useEpicPr } from "@/hooks/useEpicPr";
import { Wrench, FileCode, MoreHorizontal, X } from "lucide-react";
import { useState, useEffect } from "react";
import { isAgentAlreadyRunningError } from "@/lib/agents/client-error";
import { PermanentDeleteDialog } from "@/components/shared/PermanentDeleteDialog";
import { DependencyEditor } from "@/components/dependencies/DependencyEditor";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { DiffViewer } from "@/components/review/DiffViewer";
import { EpicGitSection } from "./epic-detail/EpicGitSection";
import { EpicUserStoriesSection } from "./epic-detail/EpicUserStoriesSection";
import { TicketImagesSection } from "./epic-detail/TicketImagesSection";
import { WhatTheAgentDid } from "./epic-detail/WhatTheAgentDid";
import { formatCostUsd } from "@/lib/utils/format-usage";
import { formatElapsed } from "@/lib/utils/format-elapsed";
import { cn } from "@/lib/utils";

/** Human label for the agent-state pill: "Build", "Review", "Merge"… */
function agentTypeLabel(agentType?: string | null): string {
  if (!agentType) return "Agent";
  return agentType.charAt(0).toUpperCase() + agentType.slice(1);
}

const TAB_TRIGGER_CLASS = cn(
  "rounded-none border-0 bg-transparent px-0 pb-[10px] text-[13px] text-muted-foreground shadow-none",
  "data-[state=active]:bg-transparent data-[state=active]:font-medium data-[state=active]:text-foreground",
  "data-[state=active]:shadow-[inset_0_-2px_0_var(--primary)]",
);

/** Section label shared by the body blocks (uppercase 12px meta). */
const SECTION_LABEL_CLASS =
  "text-[12px] uppercase tracking-[.08em] text-meta";

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
  } = useTicketComments(projectId, { kind: "epic", epicId });

  const {
    activeSession,
    dispatching,
    isRunning,
    sendToDev,
    sendToReview,
    resolveMerge,
    approve,
  } = useAgentDispatch(projectId, { kind: "epic", epicId });

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
    lastFetchedAt,
    lastFetchError,
    loading: gitStatusLoading,
    error: gitStatusError,
    refresh: refreshGitStatus,
    push: pushToRemote,
    pushing,
  } = useGitStatus(projectId, epic?.branchName ?? null, githubConfigured);

  // All epics in the project for the dependency dropdown
  const { epics: projectEpics } = useProjectEpicsList(projectId, epicId, open);

  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);

  const {
    merging,
    mergeError,
    setMergeError,
    merge,
    deletingEpic,
    deleteEpicError,
    deleteEpic,
  } = useEpicMutations(projectId, epicId, {
    onMergeSuccess: () => {
      onMerged?.();
      onClose();
    },
    onDeleteSuccess: () => {
      setDeleteDialogOpen(false);
      onClose();
      onDeleted?.();
    },
  });

  // Only poll epic detail when an agent is actively running
  useEffect(() => {
    setPolling(isRunning);
  }, [isRunning, setPolling]);

  // Opening a ticket marks it read: move its ticket_read_cursors row to now
  // so the kanban unread dot and the cross-project inbox both clear.
  useEffect(() => {
    if (!open || !epicId) return;
    const markRead = async () => {
      try {
        await fetch("/api/inbox/read", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ epicId }),
        });
      } catch {
        // Best-effort — the unread dot simply survives until the next open.
      }
    };
    void markRead();
  }, [open, epicId]);

  const [newUSTitle, setNewUSTitle] = useState("");
  const [resolvingMerge, setResolvingMerge] = useState(false);
  const [resolveMergeOpen, setResolveMergeOpen] = useState(false);
  const [resolveMergeAgentId, setResolveMergeAgentId] = useState<string | null>(null);
  const [resolveMergeResumeSessionId, setResolveMergeResumeSessionId] = useState<string | undefined>();

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
    try {
      await approve();
      setMergeError(null);
    } catch (e) {
      if (isAgentAlreadyRunningError(e)) {
        onAgentConflict?.({
          message: e.message,
          sessionUrl: e.sessionUrl || `/projects/${projectId}/sessions/${e.activeSessionId}`,
        });
      }
      // Same surface as resolve-merge failures: the destructive line in the
      // Git section, next to the Resolve Merge action the message points at.
      setMergeError(e instanceof Error ? e.message : "Failed to approve epic");
    }
    // Refresh either way — on a merge failure the epic stayed in review.
    refresh();
  }

  async function handleSendToDev(
    comment?: string,
    namedAgentId?: string | null,
    resumeSessionId?: string,
    pipeline?: boolean
  ) {
    await sendToDev(comment, namedAgentId, resumeSessionId, pipeline);
    refresh();
  }

  async function handleBackToDev(reviewComment: string) {
    // Post the review summary as a ticket comment, then dispatch build
    await sendToDev(reviewComment);
    refresh();
  }

  async function handleSendToReview(types: string[], namedAgentId?: string | null, resumeSessionId?: string) {
    await sendToReview(types, namedAgentId, resumeSessionId);
    refresh();
  }

  function handleAddUS() {
    if (!newUSTitle.trim()) return;
    addUserStory(newUSTitle.trim());
    setNewUSTitle("");
  }

  if (!open) return null;

  // `/sessions/active` returns UnifiedActivity rows: `type` is the agent
  // action (build | review | merge | …); `mode` is the legacy fallback.
  const activeAgentType =
    (activeSession as { type?: string | null; agentType?: string | null } | null)
      ?.type ??
    (activeSession as { agentType?: string | null } | null)?.agentType ??
    activeSession?.mode ??
    null;

  const agentPillLabel = activeSession
    ? [
        agentTypeLabel(activeAgentType),
        activeSession.startedAt ? formatElapsed(activeSession.startedAt) : null,
      ]
        .filter(Boolean)
        .join(" · ")
    : null;

  return (
    <div
      className="flex h-full flex-col overflow-y-auto"
      data-testid="epic-detail-panel"
    >
      {loading || !epic ? (
        <>
          <div className="border-b border-border px-[24px] py-[20px]">
            <h2 className="text-[16px] font-semibold">Epic</h2>
          </div>
          <div className="py-8 text-center text-muted-foreground">
            Loading...
          </div>
        </>
      ) : (
        <>
          {/* Header: id · agent pill · overflow · close */}
          <div className="flex items-center gap-[10px] px-[24px] pt-[20px]">
            {epic.readableId && (
              <span className="shrink-0 font-mono text-[11.5px] text-meta">
                {epic.readableId}
              </span>
            )}

            {isRunning && agentPillLabel && (
              <span
                data-testid="epic-agent-pill"
                className="inline-flex items-center gap-[7px] rounded-full bg-agent-bg px-[10px] py-[4px] text-[12px] text-agent"
              >
                <span className="breathing-dot h-[7px] w-[7px]" />
                {agentPillLabel}
              </span>
            )}

            <TicketTypeBadge type={epic.type} />

            <div className="ml-auto flex items-center gap-[2px]">
              {/* Non-modal: the delete item opens a dialog, and a modal menu
                  would keep the body pointer-locked while it mounts. */}
              <DropdownMenu modal={false}>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-meta"
                    aria-label="Ticket actions"
                    data-testid="epic-overflow-menu"
                  >
                    <MoreHorizontal className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem
                    variant="destructive"
                    data-testid="epic-delete-menu-item"
                    onClick={() => setDeleteDialogOpen(true)}
                    disabled={deletingEpic}
                  >
                    Delete epic
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>

              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-meta"
                onClick={onClose}
                aria-label="Close ticket panel"
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          </div>

          <div className="mt-[13px] px-[24px]">
            <InlineEdit
              value={epic.title}
              onSave={(v) => updateEpic({ title: v })}
              className="text-[20px] font-medium leading-[1.3] [text-wrap:pretty]"
            />
            {deleteEpicError && (
              <p className="mt-2 text-[12px] text-destructive">
                {deleteEpicError}
              </p>
            )}
            {formatCostUsd(epic.sessionsCostUsd) && (
              <p
                className="mt-[6px] font-mono text-[11px] text-meta"
                title="Cumulative cost of this ticket's agent sessions (when reported by the provider)"
              >
                Agent cost {formatCostUsd(epic.sessionsCostUsd)}
              </p>
            )}
          </div>

          {/* Agent action row (Retry / Reply / Diff equivalents). AgentActionsBar
              is shared and frozen, so the 3a control grammar (29px / 13px /
              radius 8) is applied from here instead of editing it. */}
          <div className="px-[24px] pt-[18px] [&_button]:h-[29px] [&_button]:rounded-[8px] [&_button]:text-[13px]">
            <AgentActionsBar
              projectId={projectId}
              target={{ kind: "epic", epic }}
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
          </div>

          <Tabs
            defaultValue="details"
            className="flex min-h-0 flex-1 flex-col gap-0"
          >
            <TabsList className="h-auto w-full justify-start gap-[20px] rounded-none border-b border-border-soft bg-transparent px-[24px] pt-[20px] pb-0">
              <TabsTrigger value="details" className={TAB_TRIGGER_CLASS}>
                Details
              </TabsTrigger>
              {epic.branchName && (
                <TabsTrigger
                  value="review"
                  className={cn(TAB_TRIGGER_CLASS, "gap-1")}
                >
                  <FileCode className="h-3 w-3" />
                  Code Review
                </TabsTrigger>
              )}
              <TabsTrigger value="activity" className={TAB_TRIGGER_CLASS}>
                Activity
                {/* The mockup's separate "Comments" tab folds into Activity —
                    its mono counter comes along so the discussion volume is
                    visible without opening the tab. */}
                {comments.length > 0 && (
                  <span
                    className="ml-[6px] font-mono text-[11px] text-meta"
                    aria-label={`${comments.length} comments`}
                    data-testid="epic-activity-comment-count"
                  >
                    {comments.length}
                  </span>
                )}
              </TabsTrigger>
            </TabsList>

            <TabsContent
              value="details"
              className="flex min-h-0 flex-1 flex-col gap-[18px] overflow-y-auto px-[24px] py-[22px]"
            >
              <InlineEdit
                value={epic.description || ""}
                onSave={(v) => updateEpic({ description: v })}
                multiline
                markdown
                className="text-[14px] leading-[1.65]"
              />

              {/* Directly under the report it illustrates; renders nothing
                  when the ticket has no attached screenshot. */}
              <TicketImagesSection
                projectId={projectId}
                images={epic.images}
                labelClassName={SECTION_LABEL_CLASS}
              />

              <WhatTheAgentDid
                projectId={projectId}
                epicId={epicId}
                refreshToken={activeSession?.id ?? null}
              />

              {/* Key / value rows */}
              <div className="flex flex-col">
                <div className="flex items-center justify-between gap-3 border-t border-border-soft py-[11px]">
                  <span className="text-[12.5px] text-muted-foreground">
                    Priority
                  </span>
                  <Select
                    value={String(epic.priority)}
                    onValueChange={(v) => updateEpic({ priority: Number(v) } as never)}
                  >
                    <SelectTrigger className="h-[29px] w-auto gap-2 rounded-[7px] border-0 bg-transparent px-2 text-[13px] shadow-none hover:bg-band">
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

                <div className="flex items-center justify-between gap-3 border-t border-border-soft py-[11px]">
                  <span className="text-[12.5px] text-muted-foreground">
                    Status
                  </span>
                  <Select
                    value={epic.status}
                    onValueChange={(v) => updateEpic({ status: v })}
                  >
                    <SelectTrigger className="h-[29px] w-auto gap-2 rounded-[7px] border-0 bg-transparent px-2 text-[13px] shadow-none hover:bg-band">
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

                {epic.type === "bug" && epic.linkedEpicId && (
                  <div className="flex items-center justify-between gap-3 border-t border-border-soft py-[11px]">
                    <span className="text-[12.5px] text-muted-foreground">
                      Linked to epic
                    </span>
                    <span className="font-mono text-[12px]">
                      {epic.linkedEpicId}
                    </span>
                  </div>
                )}

                {epic.branchName && (
                  <EpicGitSection
                    projectId={projectId}
                    branchName={epic.branchName}
                    epicStatus={epic.status}
                    githubConfigured={githubConfigured}
                    isRunning={isRunning}
                    ahead={ahead}
                    behind={behind}
                    gitStatusLoading={gitStatusLoading}
                    gitStatusError={gitStatusError}
                    lastFetchedAt={lastFetchedAt}
                    lastFetchError={lastFetchError}
                    onRefreshGitStatus={refreshGitStatus}
                    onPush={pushToRemote}
                    pushing={pushing}
                    pr={pr}
                    prLoading={prLoading}
                    prError={prError}
                    onCreatePr={() => createPr()}
                    onSyncPr={syncPr}
                    merging={merging}
                    mergeError={mergeError}
                    onMerge={merge}
                    resolvingMerge={resolvingMerge}
                    onOpenResolveMerge={() => setResolveMergeOpen(true)}
                  />
                )}
              </div>

              {/* User Stories */}
              {epic.type !== "bug" && (
                <EpicUserStoriesSection
                  projectId={projectId}
                  userStories={userStories}
                  newStoryTitle={newUSTitle}
                  onNewStoryTitleChange={setNewUSTitle}
                  onAddStory={handleAddUS}
                  onUpdateStory={(id, updates) => updateUserStory(id, updates)}
                  onDeleteStory={deleteUserStory}
                  onRefresh={refresh}
                  actionsLocked={dispatching || isRunning}
                />
              )}

              {/* Dependencies */}
              {epicId && (
                <div className="flex flex-col gap-[10px] border-t border-border-soft pt-[16px]">
                  <span className={SECTION_LABEL_CLASS}>Dependencies</span>
                  <DependencyEditor
                    projectId={projectId}
                    epicId={epicId}
                    projectEpics={projectEpics}
                  />
                </div>
              )}
            </TabsContent>

            {/* Code Review Tab */}
            {epic.branchName && epicId && (
              <TabsContent
                value="review"
                className="min-h-0 flex-1 overflow-y-auto px-[24px] py-[22px]"
              >
                <DiffViewer
                  projectId={projectId}
                  epicId={epicId}
                  epicStatus={epic.status}
                  onBackToDev={handleBackToDev}
                  onApprove={handleApprove}
                  dispatching={dispatching}
                  isRunning={isRunning}
                />
              </TabsContent>
            )}

            {/* Activity Tab */}
            <TabsContent value="activity" className="min-h-0 flex-1">
              <div className="h-full min-h-[200px]">
                <EpicActivityFeed
                  projectId={projectId}
                  epicId={epicId}
                  comments={comments}
                  commentsLoading={commentsLoading}
                  onAddComment={addComment}
                  onSendToDev={
                    epic && ["backlog", "todo", "in_progress", "review"].includes(epic.status)
                      ? async () => {
                          try {
                            await sendToDev();
                            refresh();
                          } catch (error) {
                            if (isAgentAlreadyRunningError(error)) {
                              onAgentConflict?.({
                                message: error.message,
                                sessionUrl: error.sessionUrl || `/projects/${projectId}/sessions/${error.activeSessionId}`,
                              });
                            }
                          }
                        }
                      : undefined
                  }
                  sendToDevDisabled={dispatching || isRunning}
                  sendToDevLoading={dispatching}
                />
              </div>
            </TabsContent>
          </Tabs>
        </>
      )}

      <AgentDispatchDialog
        open={resolveMergeOpen}
        onOpenChange={(open) => { setResolveMergeOpen(open); if (!open) setResolveMergeResumeSessionId(undefined); }}
        title="Resolve Merge Conflicts"
        description="Launch an agent to resolve merge conflicts for this epic."
        projectId={projectId}
        agentProps={{
          value: resolveMergeAgentId,
          onChange: setResolveMergeAgentId,
          className: "w-44 h-8 text-xs",
        }}
        sessionPicker={
          epicId
            ? {
                epicId,
                agentType: "merge",
                namedAgentId: resolveMergeAgentId,
                provider: "claude-code",
                selectedSessionId: resolveMergeResumeSessionId,
                onSelect: setResolveMergeResumeSessionId,
              }
            : undefined
        }
        confirmLabel="Dispatch Agent"
        confirmIcon={<Wrench className="h-4 w-4 mr-1" />}
        busy={resolvingMerge}
        confirmDisabled={resolvingMerge || isRunning}
        onConfirm={() => handleResolveMerge(resolveMergeAgentId, resolveMergeResumeSessionId)}
        onCancel={() => setResolveMergeOpen(false)}
      />

      <PermanentDeleteDialog
        open={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        title="Delete Epic"
        description="Permanently delete this epic and all related user stories."
        confirmLabel="Confirm Delete"
        deleting={deletingEpic}
        onConfirm={deleteEpic}
      />
    </div>
  );
}
