"use client";

import type { ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { NamedAgentSelect } from "@/components/shared/NamedAgentSelect";
import { SessionPicker } from "@/components/shared/SessionPicker";
import type { DispatchRole } from "@/lib/agent-config/dispatch-reliability-constants";
import { PromptTokenEstimateView } from "@/components/shared/PromptTokenEstimateView";
interface AgentDispatchDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  projectId: string;
  /** Wiring for the "Agent:" NamedAgentSelect row. */
  agentProps: {
    value: string | null;
    onChange: (namedAgentId: string) => void;
    disabled?: boolean;
    className?: string;
    /** Task type of this dispatch — drives the per-agent reliability badge. */
    dispatchRole?: DispatchRole;
  };
  /** When provided, renders a SessionPicker below the agent row. */
  sessionPicker?: {
    epicId?: string;
    userStoryId?: string;
    agentType?: string;
    namedAgentId?: string | null;
    provider?: string;
    selectedSessionId: string | undefined;
    onSelect: (sessionId: string | undefined) => void;
  };
  /** Target details for automatic prompt token estimation preview. */
  promptEstimateTarget?: {
    epicId?: string;
    userStoryId?: string;
    dispatchType?: "build" | "review" | "grading";
    reviewTypes?: string[];
    comment?: string;
  };
  /** Small muted note under the pickers. */
  notice?: ReactNode;
  extraContent?: ReactNode;
  confirmLabel: ReactNode;
  /** Icon shown inside the confirm button when not busy. */
  confirmIcon?: ReactNode;
  /** When true, the confirm button shows a spinner instead of its icon. */
  busy: boolean;
  confirmDisabled?: boolean;
  onConfirm: () => void;
  /** Cancel button handler. Defaults to `onOpenChange(false)`. */
  onCancel?: () => void;
}

/**
 * Shared skeleton for "dispatch an agent" dialogs: header, "Agent:" row
 * with NamedAgentSelect, optional SessionPicker, arbitrary extra content
 * and a Cancel/confirm footer with a busy spinner.
 */
export function AgentDispatchDialog({
  open,
  onOpenChange,
  title,
  description,
  projectId,
  agentProps,
  sessionPicker,
  promptEstimateTarget,
  notice,
  extraContent,
  confirmLabel,
  confirmIcon,
  busy,
  confirmDisabled,
  onConfirm,
  onCancel,
}: AgentDispatchDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description != null && (
            <DialogDescription>{description}</DialogDescription>
          )}
        </DialogHeader>
        <div className="flex items-center gap-2 mb-2">
          <span className="text-sm text-muted-foreground">Agent:</span>
          <NamedAgentSelect
            value={agentProps.value}
            onChange={agentProps.onChange}
            disabled={agentProps.disabled}
            className={agentProps.className ?? "w-44 h-8 text-xs"}
            dispatchRole={agentProps.dispatchRole}
          />
        </div>
        {sessionPicker && (
          <SessionPicker projectId={projectId} {...sessionPicker} />
        )}
        {notice != null && (
          <p
            className="text-xs text-muted-foreground"
            data-testid="dispatch-notice"
          >
            {notice}
          </p>
        )}
        {extraContent}
        {open && (promptEstimateTarget?.epicId || promptEstimateTarget?.userStoryId || sessionPicker?.epicId || sessionPicker?.userStoryId) && (
          <PromptTokenEstimateView
            projectId={projectId}
            epicId={promptEstimateTarget?.epicId ?? sessionPicker?.epicId}
            userStoryId={promptEstimateTarget?.userStoryId ?? sessionPicker?.userStoryId}
            dispatchType={promptEstimateTarget?.dispatchType ?? (agentProps.dispatchRole === "review" ? "review" : "build")}
            reviewTypes={promptEstimateTarget?.reviewTypes}
            comment={promptEstimateTarget?.comment}
            namedAgentId={agentProps.value}
            enabled={open}
          />
        )}
        <DialogFooter>
          <Button
            variant="outline"
            onClick={onCancel ?? (() => onOpenChange(false))}
          >
            Cancel
          </Button>
          <Button onClick={onConfirm} disabled={confirmDisabled}>
            {busy ? (
              <Loader2 className="h-4 w-4 animate-spin mr-1" />
            ) : (
              confirmIcon
            )}
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
