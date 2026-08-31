"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { MentionTextarea } from "@/components/documents/MentionTextarea";
import { Badge } from "@/components/ui/badge";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  Hammer,
  Search,
  CheckCircle2,
  GitMerge,
  Loader2,
  Workflow,
  ClipboardCheck,
} from "lucide-react";
import { AgentDispatchDialog } from "@/components/shared/AgentDispatchDialog";
import { ReviewTypesPicker } from "@/components/shared/ReviewTypesPicker";
import {
  PROVIDER_LABELS,
  REVIEW_TYPE_TO_AGENT_TYPE,
  isChatProvider,
  type BuiltinReviewType,
} from "@/lib/agent-config/constants";
import { resolvePipelineEnabledDefault } from "@/lib/pipeline/constants";
import { pipelineChipLabel, usePipelineRuns } from "@/hooks/usePipelineRuns";

interface ReviewResolutionPreview {
  provider: string;
  segregated: boolean;
  builderProvider: string | null;
}

function providerLabel(provider: string): string {
  return isChatProvider(provider) ? PROVIDER_LABELS[provider] : provider;
}

interface EpicItem {
  id: string;
  status: string;
  title: string;
}

interface StoryItem {
  id: string;
  epicId?: string;
  status: string;
  title: string;
}

export type AgentActionsTarget =
  | { kind: "epic"; epic: EpicItem }
  | { kind: "story"; story: StoryItem };

interface TargetConfig {
  /** Noun used in the "Another agent is already running…" lock message. */
  noun: string;
  /** Statuses from which a fresh "Send to Dev" is allowed. */
  sendToDevStatuses: string[];
  devDialogTitle: string;
  reviewDialogTitle: string;
  reviewDialogDescription: string;
  /** agentType used to filter resumable sessions for the build dialog. */
  buildAgentType: string;
}

const TARGET_CONFIG: Record<AgentActionsTarget["kind"], TargetConfig> = {
  epic: {
    noun: "epic",
    sendToDevStatuses: ["backlog", "todo", "in_progress"],
    devDialogTitle: "Send Epic to Dev",
    reviewDialogTitle: "Epic Agent Review",
    reviewDialogDescription:
      "Select the review types to run on this epic. Each selected type dispatches a separate agent.",
    buildAgentType: "build",
  },
  story: {
    noun: "task",
    sendToDevStatuses: ["todo", "in_progress"],
    devDialogTitle: "Send to Dev",
    reviewDialogTitle: "Agent Review",
    reviewDialogDescription:
      "Select the review types to run. Each selected type dispatches a separate agent.",
    buildAgentType: "ticket_build",
  },
};

interface AgentActionsBarProps {
  projectId: string;
  target: AgentActionsTarget;
  dispatching: boolean;
  isRunning: boolean;
  activeSessionId?: string | null;
  onSendToDev: (
    comment?: string,
    namedAgentId?: string | null,
    resumeSessionId?: string,
    pipeline?: boolean
  ) => Promise<unknown>;
  onSendToReview: (types: string[], namedAgentId?: string | null, resumeSessionId?: string) => Promise<unknown>;
  onSendToGrading?: (namedAgentId?: string | null) => Promise<unknown>;
  /**
   * The action that closes the ticket. Epic: merge the branch (the merge IS
   * the approval, shown from To Merge). Story: approve the story's review.
   */
  onComplete: () => Promise<unknown>;
  onActionError?: (error: unknown) => void;
}

export function AgentActionsBar({
  projectId,
  target,
  dispatching,
  isRunning,
  activeSessionId,
  onSendToDev,
  onSendToReview,
  onSendToGrading,
  onComplete,
  onActionError,
}: AgentActionsBarProps) {
  const [sendToDevOpen, setSendToDevOpen] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [gradingOpen, setGradingOpen] = useState(false);
  const [devComment, setDevComment] = useState("");
  const [devAgentId, setDevAgentId] = useState<string | null>(null);
  const [reviewAgentId, setReviewAgentId] = useState<string | null>(null);
  const [gradingAgentId, setGradingAgentId] = useState<string | null>(null);
  const [reviewTypes, setReviewTypes] = useState<Set<string>>(new Set(["feature_review"]));
  const [approving, setApproving] = useState(false);
  const [resumeSessionId, setResumeSessionId] = useState<string | undefined>();
  const [reviewResumeSessionId, setReviewResumeSessionId] = useState<string | undefined>();
  const [reviewResolution, setReviewResolution] =
    useState<ReviewResolutionPreview | null>(null);
  const [pipeline, setPipeline] = useState(false);

  // Explains a session the user did not dispatch by hand: while an agent is
  // running, check whether it belongs to an autonomous pipeline run.
  const { sessionIndex: pipelineSessions } = usePipelineRuns(
    projectId,
    isRunning && !!activeSessionId
  );
  const activePipeline = activeSessionId
    ? pipelineSessions[activeSessionId]
    : undefined;

  const config = TARGET_CONFIG[target.kind];
  const item = target.kind === "epic" ? target.epic : target.story;
  // Session scoping: epics resume their own sessions; stories resume
  // sessions scoped to the story (and its parent epic when known).
  const sessionEpicId = target.kind === "epic" ? target.epic.id : target.story.epicId;
  const sessionUserStoryId = target.kind === "epic" ? undefined : target.story.id;

  // Preview which provider a review dispatch would resolve to (surfaces the
  // "Reviewer must differ from builder" redirect in the dialog).
  const firstReviewType = Array.from(reviewTypes)[0];
  useEffect(() => {
    if (!reviewOpen || !firstReviewType) {
      setReviewResolution(null);
      return;
    }
    const agentType =
      REVIEW_TYPE_TO_AGENT_TYPE[firstReviewType as BuiltinReviewType] ??
      "review_feature";
    const searchParams = new URLSearchParams({ agentType });
    if (sessionUserStoryId) searchParams.set("storyId", sessionUserStoryId);
    if (sessionEpicId) searchParams.set("epicId", sessionEpicId);
    if (reviewAgentId) searchParams.set("namedAgentId", reviewAgentId);

    let cancelled = false;
    try {
      fetch(`/api/projects/${projectId}/review-resolution?${searchParams}`)
        .then((r) => r.json())
        .then((json) => {
          if (!cancelled && json?.data) {
            setReviewResolution(json.data as ReviewResolutionPreview);
          }
        })
        .catch(() => {
          // preview is best-effort — dispatch still works without it
        });
    } catch {
      // ignore (no fetch in some test environments)
    }
    return () => {
      cancelled = true;
    };
  }, [
    reviewOpen,
    firstReviewType,
    reviewAgentId,
    projectId,
    sessionEpicId,
    sessionUserStoryId,
  ]);

  // The pipeline checkbox defaults to the effective setting (per-project key
  // first, then the global one, then OFF). Re-read each time the dialog
  // opens so a settings change is picked up without a reload.
  useEffect(() => {
    if (!sendToDevOpen) return;
    let cancelled = false;
    try {
      fetch("/api/settings")
        .then((r) => r.json())
        .then((json) => {
          if (cancelled) return;
          setPipeline(
            resolvePipelineEnabledDefault(
              json?.data as Record<string, unknown> | undefined,
              projectId
            )
          );
        })
        .catch(() => {
          // best-effort — the checkbox simply stays off
        });
    } catch {
      // ignore (no fetch in some test environments)
    }
    return () => {
      cancelled = true;
    };
  }, [sendToDevOpen, projectId]);

  const segregationNotice =
    reviewResolution?.segregated && reviewResolution.builderProvider
      ? `Review by ${providerLabel(reviewResolution.provider)} (builder was ${providerLabel(reviewResolution.builderProvider)})`
      : undefined;

  const status = item.status;
  const canSendToDev = config.sendToDevStatuses.includes(status);
  const canSendToDevFromReview = status === "review" || status === "to_merge";
  const canReview =
    status === "review" || status === "to_merge" || status === "done";
  const canGrade = target.kind === "epic" && canReview && !!onSendToGrading;
  // Epic: the merge closes the ticket, offered from the To Merge column.
  // Story: an explicit human approval is the review verdict for that story.
  const canComplete =
    target.kind === "epic" ? status === "to_merge" : status === "review";
  const actionsLocked = dispatching || isRunning;
  const lockMessage =
    isRunning && activeSessionId
      ? `Another agent is already running for this ${config.noun} (#${activeSessionId.slice(0, 6)}).`
      : isRunning
        ? `Another agent is already running for this ${config.noun}.`
        : null;

  // Send to Dev (from backlog/todo/in_progress — optional comment)
  async function handleSendToDev() {
    try {
      await onSendToDev(
        devComment.trim() || undefined,
        devAgentId,
        resumeSessionId,
        pipeline
      );
      setSendToDevOpen(false);
      setDevComment("");
      setResumeSessionId(undefined);
    } catch (error) {
      onActionError?.(error);
    }
  }

  // Send to Dev from Review (mandatory comment)
  async function handleSendToDevFromReview() {
    if (!devComment.trim()) return;
    try {
      await onSendToDev(
        devComment.trim(),
        devAgentId,
        resumeSessionId,
        pipeline
      );
      setSendToDevOpen(false);
      setDevComment("");
      setResumeSessionId(undefined);
    } catch (error) {
      onActionError?.(error);
    }
  }

  // Agent Review
  function toggleReviewType(type: string) {
    setReviewTypes((prev) => {
      const next = new Set(prev);
      if (next.has(type)) {
        next.delete(type);
      } else {
        next.add(type);
      }
      return next;
    });
  }

  async function handleReview() {
    if (reviewTypes.size === 0) return;
    try {
      await onSendToReview(Array.from(reviewTypes), reviewAgentId, reviewResumeSessionId);
      setReviewOpen(false);
      setReviewTypes(new Set());
      setReviewResumeSessionId(undefined);
    } catch (error) {
      onActionError?.(error);
    }
  }

  async function handleGrading() {
    if (!onSendToGrading) return;
    try {
      await onSendToGrading(gradingAgentId);
      setGradingOpen(false);
    } catch (error) {
      onActionError?.(error);
    }
  }

  // Merge (epic) / Approve (story)
  async function handleComplete() {
    setApproving(true);
    try {
      await onComplete();
    } catch (error) {
      onActionError?.(error);
    } finally {
      setApproving(false);
    }
  }

  return (
    <TooltipProvider>
    <div className="flex items-center gap-2 flex-wrap">
      {/* Running indicator */}
      {isRunning && (
        <Badge variant="outline" className="gap-1 text-yellow-500 border-yellow-500/30">
          <Loader2 className="h-3 w-3 animate-spin" />
          Agent running
        </Badge>
      )}
      {activePipeline && (
        <Badge
          variant="outline"
          data-testid="pipeline-chip"
          className="gap-1 text-violet-400 border-violet-500/30"
          title="Dispatched by an autonomous pipeline run — stopping this session stops the pipeline"
        >
          <Workflow className="h-3 w-3" />
          {pipelineChipLabel(activePipeline)}
        </Badge>
      )}
      {lockMessage && (
        <span className="text-xs text-muted-foreground">{lockMessage}</span>
      )}

      {/* Send to Dev button */}
      {(canSendToDev || canSendToDevFromReview) && (
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            setDevComment("");
            setSendToDevOpen(true);
          }}
          disabled={actionsLocked}
          className="h-7 text-xs"
        >
          <Hammer className="h-3 w-3 mr-1" />
          Send to Dev
        </Button>
      )}

      {/* Agent Review button */}
      {canReview && (
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            setReviewTypes(new Set(["feature_review"]));
            setReviewOpen(true);
          }}
          disabled={actionsLocked}
          className="h-7 text-xs"
        >
          <Search className="h-3 w-3 mr-1" />
          Agent Review
        </Button>
      )}

      {canGrade && (
        <Button
          size="sm"
          variant="outline"
          onClick={() => setGradingOpen(true)}
          disabled={actionsLocked}
          className="h-7 text-xs"
        >
          <ClipboardCheck className="h-3 w-3 mr-1" />
          Grade Criteria
        </Button>
      )}

      {/* Merge (epic) / Approve (story) button */}
      {canComplete && (
        <Button
          size="sm"
          onClick={handleComplete}
          disabled={approving || actionsLocked}
          className="h-7 text-xs bg-green-600 hover:bg-green-700 text-white"
        >
          {approving ? (
            <Loader2 className="h-3 w-3 animate-spin mr-1" />
          ) : target.kind === "epic" ? (
            <GitMerge className="h-3 w-3 mr-1" />
          ) : (
            <CheckCircle2 className="h-3 w-3 mr-1" />
          )}
          {target.kind === "epic" ? "Merge" : "Approve"}
        </Button>
      )}

      {/* Send to Dev Dialog */}
      <AgentDispatchDialog
        open={sendToDevOpen}
        onOpenChange={(open) => { setSendToDevOpen(open); if (!open) setResumeSessionId(undefined); }}
        title={config.devDialogTitle}
        description={
          canSendToDevFromReview
            ? "Explain what needs to be fixed. This comment is required."
            : "Optionally add a comment for the agent before dispatching."
        }
        projectId={projectId}
        agentProps={{
          value: devAgentId,
          onChange: setDevAgentId,
          dispatchRole: "build",
        }}
        sessionPicker={{
          epicId: sessionEpicId,
          userStoryId: sessionUserStoryId,
          agentType: config.buildAgentType,
          namedAgentId: devAgentId,
          provider: "claude-code",
          selectedSessionId: resumeSessionId,
          onSelect: setResumeSessionId,
        }}
        promptEstimateTarget={{
          epicId: sessionEpicId,
          userStoryId: sessionUserStoryId,
          dispatchType: "build",
          comment: devComment,
        }}
        extraContent={
          <>
            <MentionTextarea
              projectId={projectId}
              value={devComment}
              onValueChange={setDevComment}
              placeholder={
                canSendToDevFromReview
                  ? "Describe what needs to be fixed..."
                  : "Optional instructions for the agent..."
              }
              rows={4}
              className=""
            />
            <label className="flex items-start gap-2 text-sm cursor-pointer">
              <input
                type="checkbox"
                className="mt-0.5"
                data-testid="pipeline-checkbox"
                checked={pipeline}
                onChange={(e) => setPipeline(e.target.checked)}
              />
              <span>
                <span className="font-medium">
                  Run full pipeline (build → review → auto-fix)
                </span>
                <span className="block text-xs text-muted-foreground">
                  After the build, Arij runs a code review and dispatches fix
                  agents until the review is clean. Stopping the running
                  session stops the pipeline.
                </span>
              </span>
            </label>
          </>
        }
        confirmLabel="Dispatch Agent"
        confirmIcon={<Hammer className="h-4 w-4 mr-1" />}
        busy={dispatching}
        confirmDisabled={
          actionsLocked ||
          (canSendToDevFromReview && !devComment.trim())
        }
        onConfirm={
          canSendToDevFromReview
            ? handleSendToDevFromReview
            : handleSendToDev
        }
        onCancel={() => setSendToDevOpen(false)}
      />

      {/* Agent Review Dialog */}
      <AgentDispatchDialog
        open={reviewOpen}
        onOpenChange={(open) => { setReviewOpen(open); if (!open) setReviewResumeSessionId(undefined); }}
        title={config.reviewDialogTitle}
        description={config.reviewDialogDescription}
        projectId={projectId}
        agentProps={{
          value: reviewAgentId,
          onChange: setReviewAgentId,
          dispatchRole: "review",
        }}
        sessionPicker={{
          epicId: sessionEpicId,
          userStoryId: sessionUserStoryId,
          agentType: Array.from(reviewTypes)[0],
          namedAgentId: reviewAgentId,
          provider: "claude-code",
          selectedSessionId: reviewResumeSessionId,
          onSelect: setReviewResumeSessionId,
        }}
        promptEstimateTarget={{
          epicId: sessionEpicId,
          userStoryId: sessionUserStoryId,
          dispatchType: "review",
          reviewTypes: Array.from(reviewTypes),
        }}
        notice={segregationNotice}
        extraContent={
          <ReviewTypesPicker selected={reviewTypes} onToggle={toggleReviewType} />
        }
        confirmLabel={`Run Review (${reviewTypes.size})`}
        confirmIcon={<Search className="h-4 w-4 mr-1" />}
        busy={dispatching}
        confirmDisabled={actionsLocked || reviewTypes.size === 0}
        onConfirm={handleReview}
        onCancel={() => setReviewOpen(false)}
      />

      <AgentDispatchDialog
        open={gradingOpen}
        onOpenChange={setGradingOpen}
        title="Acceptance Criteria Grading"
        description="Evaluate each story criterion against concrete evidence. Grading does not approve or move the ticket."
        projectId={projectId}
        agentProps={{
          value: gradingAgentId,
          onChange: setGradingAgentId,
          dispatchRole: "review",
        }}
        promptEstimateTarget={{
          epicId: sessionEpicId,
          userStoryId: sessionUserStoryId,
          dispatchType: "grading",
        }}
        confirmLabel="Run Grading"
        confirmIcon={<ClipboardCheck className="h-4 w-4 mr-1" />}
        busy={dispatching}
        confirmDisabled={actionsLocked}
        onConfirm={handleGrading}
        onCancel={() => setGradingOpen(false)}
      />
    </div>
    </TooltipProvider>
  );
}
