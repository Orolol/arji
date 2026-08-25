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
import { PRIORITY_LABELS } from "@/lib/types/kanban";
import { useEpicPr } from "@/hooks/useEpicPr";
import {
  Wrench,
  FileCode,
  MoreHorizontal,
  X,
  MessageSquare,
} from "lucide-react";
import { useState, useEffect, useCallback } from "react";
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
import { formatDateTime } from "@/lib/utils/format-date";
import { ticketStatusOptions } from "@/lib/kanban/status-transitions";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/**
 * Always-visible ticket type chip for the sticky header: Bug keeps its
 * destructive badge, features get a quiet neutral chip so the type is
 * readable without leaving the panel.
 */
function EpicTypeChip({ type }: { type: string }) {
  if (type === "bug") {
    return (
      <TicketTypeBadge
        type="bug"
        className="rounded-full px-[8px] text-[10.5px] leading-[18px]"
        iconClassName="h-3 w-3"
      />
    );
  }
  return (
    <Badge
      data-testid="ticket-type-badge"
      className="h-[18px] shrink-0 rounded-full border-0 bg-band px-[8px] text-[10.5px] font-medium leading-none text-muted-foreground"
    >
      Feature
    </Badge>
  );
}

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

/**
 * Epic detail side panel (the "ticket" view).
 *
 * Layout contract (ticket-display overhaul):
 * - the panel renders into the same container (and width) as the chat;
 * - a sticky header carries the critical information (readable id, agent
 *   state, type, title, status, priority, agent cost) and the frequent
 *   actions (agent actions, quick comment, overflow);
 * - the status control only enables transitions the workflow engine allows
 *   (review → done stays approval-gated), with the reason shown inline;
 * - secondary metadata (dates, raw ids, branch) is demoted to the bottom
 *   of the Details tab;
 * - the Details / Code Review / Activity tab bodies scroll independently
 *   under the sticky header.
 */
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
  const [statusError, setStatusError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState("details");

  // Switching tickets resets the active section (the Code Review tab may
  // not exist on the next ticket) and clears a stale status error —
  // derived state, adjusted during render per React's reset pattern.
  const [lastEpicId, setLastEpicId] = useState(epicId);
  if (epicId !== lastEpicId) {
    setLastEpicId(epicId);
    setActiveTab("details");
    setStatusError(null);
  }

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

  /**
   * Status change from the sticky header. Disabled options are unselectable
   * (Radix), but the workflow engine remains the source of truth — its
   * rejection (e.g. "approval or merge required") surfaces inline.
   */
  const handleStatusChange = useCallback(
    async (next: string) => {
      setStatusError(null);
      const result = await updateEpic({ status: next });
      if (!result.ok) setStatusError(result.error ?? null);
    },
    [updateEpic]
  );

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

  const statusOptions = epic
    ? ticketStatusOptions(epic.status, { hasRunningSession: isRunning })
    : [];

  // Radix portals the selected item's ItemText children into the trigger's
  // value node whenever <SelectValue> has no children of its own. The
  // dropdown items carry a "(current)" marker inside ItemText, so without
  // an explicit value the closed trigger would read "Review (current)".
  // Passing the plain label here disables the portal (valueNodeHasChildren)
  // and keeps the trigger on the bare column name.
  const currentStatusLabel =
    statusOptions.find((option) => option.isCurrent)?.label ?? epic?.status ?? "";

  return (
    <div
      className="flex h-full flex-col overflow-hidden"
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
        <Tabs
          value={activeTab}
          onValueChange={(value) => setActiveTab(value)}
          className="flex min-h-0 flex-1 flex-col gap-0"
        >
          {/* Sticky header: critical information + frequent actions. The
              tab bodies below scroll independently, so this never
              disappears under the feed. */}
          <div
            className="shrink-0 border-b border-border-soft bg-card"
            data-testid="epic-detail-header"
          >
            {/* Identity row: readable id · agent pill · type · actions */}
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

              {/* Always-visible type chip: Bug keeps its destructive badge,
                  features get a quiet neutral chip (the shared badge
                  component renders nothing outside of bugs, which other
                  surfaces rely on). */}
              <EpicTypeChip type={epic.type} />

              <div className="ml-auto flex items-center gap-[2px]">
                {/* Quick comment: jump to the Activity tab, whose composer
                    is pinned at the bottom of the panel. */}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-meta hover:text-foreground"
                  onClick={() => setActiveTab("activity")}
                  aria-label="Comment"
                  data-testid="epic-comment-button"
                >
                  <MessageSquare className="h-4 w-4" />
                </Button>

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

            {/* Title (inline-editable) + delete error + agent cost */}
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

            {/* Workflow row: status (workflow-aware) + priority */}
            <div className="mt-[14px] flex flex-wrap items-center gap-x-[18px] gap-y-[8px] px-[24px]">
              <div className="flex items-center gap-[8px]">
                <span className="text-[12.5px] text-muted-foreground">
                  Status
                </span>
                <Select
                  value={epic.status}
                  onValueChange={handleStatusChange}
                >
                  <SelectTrigger
                    data-testid="epic-status-select"
                    aria-label="Status"
                    className="h-[29px] w-auto gap-2 rounded-[7px] border-0 bg-transparent px-2 text-[13px] shadow-none hover:bg-band"
                  >
                    <SelectValue>{currentStatusLabel}</SelectValue>
                  </SelectTrigger>
                  <SelectContent className="min-w-[250px]">
                    {statusOptions.map((option) => (
                      <SelectItem
                        key={option.status}
                        value={option.status}
                        disabled={!option.enabled}
                        title={
                          option.isCurrent
                            ? undefined
                            : option.disabledReason ?? undefined
                        }
                      >
                        <span className="flex items-center gap-[8px]">
                          <span>{option.label}</span>
                          {option.isCurrent && (
                            <span className="text-[10px] font-normal text-meta">
                              (current)
                            </span>
                          )}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="flex items-center gap-[8px]">
                <span className="text-[12.5px] text-muted-foreground">
                  Priority
                </span>
                <Select
                  value={String(epic.priority)}
                  onValueChange={(v) => updateEpic({ priority: Number(v) } as never)}
                >
                  <SelectTrigger
                    data-testid="epic-priority-select"
                    aria-label="Priority"
                    className="h-[29px] w-auto gap-2 rounded-[7px] border-0 bg-transparent px-2 text-[13px] shadow-none hover:bg-band"
                  >
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
            </div>
            {statusError && (
              <p
                data-testid="epic-status-error"
                className="mt-[10px] px-[24px] text-[12px] leading-[1.5] text-destructive"
              >
                {statusError}
              </p>
            )}

            {/* Frequent actions: dispatch/continue/re-run the agent.
                AgentActionsBar is shared and frozen, so the 3a control
                grammar (29px / 13px / radius 8) is applied from here. */}
            <div className="px-[24px] pt-[16px] [&_button]:h-[29px] [&_button]:rounded-[8px] [&_button]:text-[13px]">
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

            {/* Section tabs — sticky with the header (the bodies scroll). */}
            <TabsList className="h-auto w-full justify-start gap-[20px] rounded-none border-0 bg-transparent px-[24px] pt-[18px] pb-0">
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
          </div>

          {/* Tab bodies: independent scroll under the sticky header. */}
          <div className="flex min-h-0 flex-1 flex-col">
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

              {/* Key / value rows (priority & status moved to the header) */}
              <div className="flex flex-col">
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

              {/* Demoted secondary metadata: dates, raw ids, branch. */}
              <div
                className="flex flex-col gap-[10px] border-t border-border-soft pt-[16px]"
                data-testid="ticket-metadata"
              >
                <span className={SECTION_LABEL_CLASS}>Metadata</span>
                <div className="flex items-center justify-between gap-3 py-[4px]">
                  <span className="text-[12.5px] text-muted-foreground">
                    Created
                  </span>
                  <span className="font-mono text-[11.5px] text-meta">
                    {formatDateTime(epic.createdAt)}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-3 py-[4px]">
                  <span className="text-[12.5px] text-muted-foreground">
                    Updated
                  </span>
                  <span className="font-mono text-[11.5px] text-meta">
                    {formatDateTime(epic.updatedAt)}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-3 py-[4px]">
                  <span className="text-[12.5px] text-muted-foreground">
                    Ticket ID
                  </span>
                  <span className="font-mono text-[11.5px] text-meta">
                    {epic.id}
                  </span>
                </div>
              </div>
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
              {/* No min-height: a floor taller than the space left would push
                  the composer out of the panel, which clips it away for good
                  under the panel's overflow-hidden. The feed scrolls instead. */}
              <div className="h-full">
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
          </div>
        </Tabs>
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
          dispatchRole: "merge",
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