"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Hammer } from "lucide-react";

import { AgentDispatchDialog } from "@/components/shared/AgentDispatchDialog";
import { MentionTextarea } from "@/components/documents/MentionTextarea";
import { PipelineDispatchCheckbox } from "@/components/shared/PipelineDispatchCheckbox";
import { usePipelineDispatchDefault } from "@/hooks/usePipelineDispatchDefault";

export interface SendToDevDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  title: string;
  description: string;
  /** Scope for the session picker and the prompt estimate. */
  epicId?: string;
  userStoryId?: string;
  /** agentType used to filter resumable sessions (epic: "build", story: "ticket_build"). */
  buildAgentType?: string;
  /** Seed the agent picker (e.g. the ticket overlay's band selection). */
  initialAgentId?: string | null;
  /** Pre-filled comment (back-to-dev from review). */
  defaultComment?: string;
  /** The comment must be non-empty to confirm. */
  commentRequired?: boolean;
  commentPlaceholder?: string;
  busy?: boolean;
  /** Extra confirm gate (e.g. an agent already owns the ticket). */
  locked?: boolean;
  /**
   * `pipeline` is `undefined` when no trustworthy default could be read and
   * the user made no explicit choice — the caller must then omit the flag so
   * the build route resolves the `pipeline_enabled` chain itself.
   */
  onConfirm: (
    comment: string | undefined,
    namedAgentId: string | null,
    resumeSessionId: string | undefined,
    pipeline: boolean | undefined
  ) => void;
}

/**
 * The send-to-dev dispatch dialog, shared by every surface that offers a
 * build: the kanban AgentActionsBar and the ticket overlay. It owns the
 * comment, the agent choice, the resumable session, and the "run full
 * pipeline" mode (defaulted from the `pipeline_enabled` setting chain), so
 * both surfaces present the identical dispatch contract.
 */
export function SendToDevDialog({
  open,
  onOpenChange,
  projectId,
  title,
  description,
  epicId,
  userStoryId,
  buildAgentType = "build",
  initialAgentId,
  defaultComment,
  commentRequired = false,
  commentPlaceholder,
  busy = false,
  locked = false,
  onConfirm,
}: SendToDevDialogProps) {
  const t = useTranslations("Shared");
  const [comment, setComment] = useState(defaultComment ?? "");
  const [agentId, setAgentId] = useState<string | null>(initialAgentId ?? null);
  const [resumeSessionId, setResumeSessionId] = useState<
    string | undefined
  >(undefined);
  const {
    pipeline,
    setPipeline,
    pending: pipelinePending,
    unresolved: pipelineUnresolved,
    requestValue: pipelineRequestValue,
  } = usePipelineDispatchDefault(projectId, open);

  // Re-opening re-seeds from the parent: a fresh optional comment, or the
  // carried review comment for a back-to-dev dispatch. React's documented
  // "adjust state during render" reset — no effect, no cascading renders.
  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) {
      setComment(defaultComment ?? "");
      setAgentId(initialAgentId ?? null);
      setResumeSessionId(undefined);
    }
  }

  return (
    <AgentDispatchDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setResumeSessionId(undefined);
        onOpenChange(next);
      }}
      title={title}
      description={description}
      projectId={projectId}
      agentProps={{
        value: agentId,
        onChange: setAgentId,
        dispatchRole: "build",
      }}
      sessionPicker={{
        epicId,
        userStoryId,
        agentType: buildAgentType,
        namedAgentId: agentId,
        provider: "claude-code",
        selectedSessionId: resumeSessionId,
        onSelect: setResumeSessionId,
      }}
      promptEstimateTarget={{
        epicId,
        userStoryId,
        dispatchType: "build",
        comment,
      }}
      extraContent={
        <>
          <MentionTextarea
            projectId={projectId}
            value={comment}
            onValueChange={setComment}
            placeholder={
              commentPlaceholder ??
              (commentRequired
                ? t("sendToDev.placeholderFix")
                : t("sendToDev.placeholderOptional"))
            }
            rows={4}
            className=""
          />
          <PipelineDispatchCheckbox
            checked={pipeline}
            onChange={setPipeline}
            unresolved={pipelineUnresolved}
          />
        </>
      }
      confirmLabel={t("sendToDev.dispatch")}
      confirmIcon={<Hammer className="h-4 w-4 mr-1" />}
      busy={busy}
      confirmDisabled={
        locked || pipelinePending || (commentRequired && !comment.trim())
      }
      onConfirm={() =>
        onConfirm(
          comment.trim() || undefined,
          agentId,
          resumeSessionId,
          pipelineRequestValue
        )
      }
      onCancel={() => onOpenChange(false)}
    />
  );
}
