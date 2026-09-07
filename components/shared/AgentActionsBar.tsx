"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
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
import { SendToDevDialog } from "@/components/shared/SendToDevDialog";
import { ReviewTypesPicker } from "@/components/shared/ReviewTypesPicker";
import {
  PROVIDER_LABELS,
  REVIEW_TYPE_TO_AGENT_TYPE,
  isChatProvider,
  type BuiltinReviewType,
} from "@/lib/agent-config/constants";
import type { TranslationKey } from "@/lib/i18n/catalogue";
import { PIPELINE_STAGE_LABEL_KEYS } from "@/lib/pipeline/constants";
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
  /**
   * The "Another agent is already running…" lock message, which names the
   * target ("this epic", "this task"). Two whole sentences per kind rather
   * than one sentence plus an injected noun: a language that declines the
   * noun cannot be served by the second shape.
   */
  lockedWithSessionKey: TranslationKey;
  lockedKey: TranslationKey;
  /** Statuses from which a fresh "Send to Dev" is allowed. */
  sendToDevStatuses: string[];
  devDialogTitleKey: TranslationKey;
  reviewDialogTitleKey: TranslationKey;
  reviewDialogDescriptionKey: TranslationKey;
  /** agentType used to filter resumable sessions for the build dialog. */
  buildAgentType: string;
}

/**
 * A module-scope copy table, so it holds catalogue KEY REFERENCES and the bar
 * resolves them at render with the namespace-less translator
 * (`lib/i18n/catalogue.ts`, pattern 3).
 */
const TARGET_CONFIG: Record<AgentActionsTarget["kind"], TargetConfig> = {
  epic: {
    lockedWithSessionKey: "Shared.agentActions.epic.lockedWithSession",
    lockedKey: "Shared.agentActions.epic.locked",
    sendToDevStatuses: ["backlog", "todo", "in_progress"],
    devDialogTitleKey: "Shared.agentActions.epic.devDialogTitle",
    reviewDialogTitleKey: "Shared.agentActions.epic.reviewDialogTitle",
    reviewDialogDescriptionKey:
      "Shared.agentActions.epic.reviewDialogDescription",
    buildAgentType: "build",
  },
  story: {
    lockedWithSessionKey: "Shared.agentActions.story.lockedWithSession",
    lockedKey: "Shared.agentActions.story.locked",
    sendToDevStatuses: ["todo", "in_progress"],
    devDialogTitleKey: "Shared.agentActions.story.devDialogTitle",
    reviewDialogTitleKey: "Shared.agentActions.story.reviewDialogTitle",
    reviewDialogDescriptionKey:
      "Shared.agentActions.story.reviewDialogDescription",
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
  const t = useTranslations("Shared");
  // The target table holds full dotted paths, so it resolves through the
  // namespace-less translator.
  const tKey = useTranslations();
  const [sendToDevOpen, setSendToDevOpen] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [gradingOpen, setGradingOpen] = useState(false);
  const [devAgentId, setDevAgentId] = useState<string | null>(null);
  const [reviewAgentId, setReviewAgentId] = useState<string | null>(null);
  const [gradingAgentId, setGradingAgentId] = useState<string | null>(null);
  const [reviewTypes, setReviewTypes] = useState<Set<string>>(new Set(["feature_review"]));
  const [approving, setApproving] = useState(false);
  const [reviewResumeSessionId, setReviewResumeSessionId] = useState<string | undefined>();
  const [reviewResolution, setReviewResolution] =
    useState<ReviewResolutionPreview | null>(null);

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

  const segregationNotice =
    reviewResolution?.segregated && reviewResolution.builderProvider
      ? t("agentActions.segregationNotice", {
          reviewer: providerLabel(reviewResolution.provider),
          builder: providerLabel(reviewResolution.builderProvider),
        })
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
      ? tKey(config.lockedWithSessionKey, {
          session: activeSessionId.slice(0, 6),
        })
      : isRunning
        ? tKey(config.lockedKey)
        : null;

  // Send to Dev — the shared dialog supplies the comment, the agent choice,
  // the resumable session, and the pipeline flag (defaulted from the
  // `pipeline_enabled` setting chain inside the dialog).
  async function handleSendToDevConfirm(
    comment: string | undefined,
    namedAgentId: string | null,
    sessionId: string | undefined,
    // undefined = no readable default and no user choice: omit the flag and
    // let the build route resolve `pipeline_enabled` itself.
    pipeline: boolean | undefined
  ) {
    setDevAgentId(namedAgentId);
    try {
      await onSendToDev(comment, namedAgentId, sessionId, pipeline);
      setSendToDevOpen(false);
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
          {t("agentActions.running")}
        </Badge>
      )}
      {activePipeline && (
        <Badge
          variant="outline"
          data-testid="pipeline-chip"
          className="gap-1 text-violet-400 border-violet-500/30"
          title={t("agentActions.pipelineTitle")}
        >
          <Workflow className="h-3 w-3" />
          {pipelineChipLabel(activePipeline, { pipeline: tKey("Kanban.pipelineChip"), stage: (stage) => tKey("Kanban.pipelineChipStage", { stage: tKey(PIPELINE_STAGE_LABEL_KEYS[stage]) }) })}
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
          onClick={() => setSendToDevOpen(true)}
          disabled={actionsLocked}
          className="h-7 text-xs"
        >
          <Hammer className="h-3 w-3 mr-1" />
          {t("agentActions.sendToDev")}
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
          {t("agentActions.agentReview")}
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
          {t("agentActions.gradeCriteria")}
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
          {target.kind === "epic"
            ? t("agentActions.merge")
            : t("agentActions.approve")}
        </Button>
      )}

      {/* Send to Dev Dialog (shared with the ticket overlay) */}
      <SendToDevDialog
        open={sendToDevOpen}
        onOpenChange={setSendToDevOpen}
        projectId={projectId}
        title={tKey(config.devDialogTitleKey)}
        description={
          canSendToDevFromReview
            ? t("sendToDev.descriptionFix")
            : t("sendToDev.descriptionOptional")
        }
        epicId={sessionEpicId}
        userStoryId={sessionUserStoryId}
        buildAgentType={config.buildAgentType}
        initialAgentId={devAgentId}
        commentRequired={canSendToDevFromReview}
        commentPlaceholder={
          canSendToDevFromReview
            ? t("sendToDev.placeholderFix")
            : t("sendToDev.placeholderOptional")
        }
        busy={dispatching}
        locked={actionsLocked}
        onConfirm={handleSendToDevConfirm}
      />

      {/* Agent Review Dialog */}
      <AgentDispatchDialog
        open={reviewOpen}
        onOpenChange={(open) => { setReviewOpen(open); if (!open) setReviewResumeSessionId(undefined); }}
        title={tKey(config.reviewDialogTitleKey)}
        description={tKey(config.reviewDialogDescriptionKey)}
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
        confirmLabel={t("agentActions.runReview", { count: reviewTypes.size })}
        confirmIcon={<Search className="h-4 w-4 mr-1" />}
        busy={dispatching}
        confirmDisabled={actionsLocked || reviewTypes.size === 0}
        onConfirm={handleReview}
        onCancel={() => setReviewOpen(false)}
      />

      <AgentDispatchDialog
        open={gradingOpen}
        onOpenChange={setGradingOpen}
        title={t("agentActions.grading.title")}
        description={t("agentActions.grading.description")}
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
        confirmLabel={t("agentActions.grading.confirm")}
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
