"use client";

/** Configure one refinement pass without trapping users behind another run. */
import { useId, useState } from "react";
import { NamedAgentSelect } from "@/components/shared/NamedAgentSelect";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  REFINEMENT_ACTIONS,
  REFINEMENT_ACTION_IDS,
  REFINEMENT_INSTRUCTIONS_MAX_CHARS,
  type RefinementAction,
  type RefinementOptions,
} from "@/lib/refinement/options";

export function RefinementDialog({
  open,
  onOpenChange,
  running,
  starting,
  onStart,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  running: boolean;
  starting: boolean;
  onStart: (options: RefinementOptions) => void;
}) {
  const id = useId();
  const [namedAgentId, setNamedAgentId] = useState<string | null>(null);
  const [instructions, setInstructions] = useState("");
  const [actions, setActions] = useState<RefinementAction[]>([
    ...REFINEMENT_ACTION_IDS,
  ]);
  const busy = running || starting;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!starting) onOpenChange(next);
      }}
    >
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Configure board refinement</DialogTitle>
          <DialogDescription>
            Choose what the agent may change in Backlog and To do for this pass.
          </DialogDescription>
        </DialogHeader>
        <div className="min-w-0 space-y-2">
          <label htmlFor={`${id}-agent`} className="text-sm font-medium">
            Agent
          </label>
          <NamedAgentSelect
            id={`${id}-agent`}
            value={namedAgentId}
            onChange={(value) => setNamedAgentId(value || null)}
            disabled={busy}
            allowClear
            clearLabel="Use refinement default"
            dispatchRole="maintenance"
            className="w-full min-w-0"
            aria-describedby={`${id}-agent-help`}
          />
          <p id={`${id}-agent-help`} className="text-xs text-muted-foreground">
            Uses the project or workspace refinement default unless you select
            an agent. Claude Code or Codex is required.
          </p>
        </div>
        <fieldset disabled={busy} className="space-y-2">
          <legend className="mb-2 text-sm font-medium">Actions</legend>
          {REFINEMENT_ACTIONS.map((action) => (
            <label
              key={action.id}
              className="flex items-start gap-3 rounded-md border p-2 text-sm"
            >
              <Checkbox
                checked={actions.includes(action.id)}
                disabled={busy}
                className="mt-1"
                onCheckedChange={(checked) => setActions((current) => checked === true
                  ? [...current, action.id]
                  : current.filter((item) => item !== action.id))}
              />
              <span>
                <span className="font-medium">{action.label}</span>
                <span className="block text-xs text-muted-foreground">
                  {action.description}
                </span>
              </span>
            </label>
          ))}
        </fieldset>
        <div className="space-y-2">
          <label htmlFor={`${id}-instructions`} className="text-sm font-medium">
            Additional instructions (optional)
          </label>
          <Textarea
            id={`${id}-instructions`}
            value={instructions}
            onChange={(event) => setInstructions(event.target.value)}
            disabled={busy}
            maxLength={REFINEMENT_INSTRUCTIONS_MAX_CHARS}
            rows={3}
            placeholder="For example: prioritize onboarding and combine duplicate search tickets."
            aria-describedby={`${id}-instructions-help`}
          />
          <p id={`${id}-instructions-help`} className="text-xs text-muted-foreground">
            {instructions.length} / {REFINEMENT_INSTRUCTIONS_MAX_CHARS} characters.
            Instructions apply only to checked actions.
          </p>
        </div>
        <p role="status" className="text-sm text-muted-foreground">
          {running
            ? "A refinement pass is already running. You can close this dialog."
            : actions.length === 0 ? "Select at least one action." : ""}
        </p>
        <DialogFooter>
          <Button
            variant="outline"
            disabled={starting}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            disabled={busy || actions.length === 0}
            onClick={() => onStart({
              namedAgentId,
              instructions: instructions.trim(),
              actions,
            })}
          >
            {starting ? "Starting…" : "Start refinement"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
