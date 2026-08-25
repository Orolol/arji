"use client";

import { useState } from "react";
import { Sparkles } from "lucide-react";
import { AgentDispatchDialog } from "@/components/shared/AgentDispatchDialog";
import { Textarea } from "@/components/ui/textarea";

interface SpecUpdateDialogProps {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onStarted: (data: { sessionId: string }) => void;
  onBeforeStart?: () => Promise<void>;
  onError?: (message: string) => void;
}
/**
 * "Mettre à jour la spec" dialog: pick an agent (the same global
 * NamedAgentSelect used across the app — empty selection resolves to the
 * project's default agent at dispatch time) and optionally type an
 * instruction that steers the update. The instruction is optional; without
 * one the agent refreshes the spec from the current state of the project.
 */
export function SpecUpdateDialog({
  projectId,
  open,
  onOpenChange,
  onStarted,
  onBeforeStart,
  onError,
}: SpecUpdateDialogProps) {
  const [namedAgentId, setNamedAgentId] = useState<string | null>(null);
  const [instruction, setInstruction] = useState("");
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function resetForm() {
    setNamedAgentId(null);
    setInstruction("");
    setError(null);
  }
  function handleOpenChange(newOpen: boolean) {
    if (!newOpen) {
      resetForm();
    }
    onOpenChange(newOpen);
  }

  async function handleStart() {
    setStarting(true);
    setError(null);
    try {
      await onBeforeStart?.();
      const res = await fetch(`/api/projects/${projectId}/spec/update`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(namedAgentId ? { namedAgentId } : {}),
          ...(instruction.trim() ? { instruction: instruction.trim() } : {}),
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.data?.sessionId) {
        const message =
          json.error || "Failed to start the spec update session.";
        setError(message);
        onError?.(message);
        return;
      }
      onOpenChange(false);
      resetForm();
      onStarted({ sessionId: json.data.sessionId });
    } catch {
      const message = "Failed to start the spec update session.";
      setError(message);
      onError?.(message);
    } finally {
      setStarting(false);
    }
  }

  return (
    <AgentDispatchDialog
      open={open}
      onOpenChange={handleOpenChange}
      title="Update the specification with an agent"
      description="The agent runs in the project workspace and updates the project specification from its current state. The saved spec is only replaced if the session succeeds."
      projectId={projectId}
      agentProps={{
        value: namedAgentId,
        onChange: setNamedAgentId,
        disabled: starting,
        className: "w-56 h-[34px] rounded-[8px] text-[13px]",
      }}
      extraContent={
        <div className="flex flex-col gap-2 mb-2">
          <span className="text-sm text-muted-foreground">Instruction</span>
          <Textarea
            value={instruction}
            onChange={(event) => setInstruction(event.target.value)}
            placeholder="Optional — e.g. “update the architecture section after the Full Auto mode”. Leave empty to let the agent refresh the spec from the current project state."
            rows={4}
            className="rounded-[10px] text-[13.5px] leading-[1.6]"
            data-testid="spec-update-instruction"
          />
          {error && (
            <p className="text-xs text-destructive" role="alert">
              {error}
            </p>
          )}
        </div>
      }
      confirmLabel="Update spec"
      confirmIcon={<Sparkles className="h-4 w-4 mr-1" />}
      busy={starting}
      confirmDisabled={starting}
      onConfirm={handleStart}
    />
  );
}
