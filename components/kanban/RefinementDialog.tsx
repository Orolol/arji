"use client";

/** Configure one refinement pass without trapping users behind another run. */
import { useId, useState } from "react";
import { useTranslations } from "next-intl";
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
  const t = useTranslations("Kanban");
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
          <DialogTitle>{t("refinementDialog.title")}</DialogTitle>
          <DialogDescription>
            {t("refinementDialog.description")}
          </DialogDescription>
        </DialogHeader>
        <div className="min-w-0 space-y-2">
          <label htmlFor={`${id}-agent`} className="text-sm font-medium">
            {t("refinementDialog.agentLabel")}
          </label>
          <NamedAgentSelect
            id={`${id}-agent`}
            value={namedAgentId}
            onChange={(value) => setNamedAgentId(value || null)}
            disabled={busy}
            allowClear
            clearLabel={t("refinementDialog.agentClearLabel")}
            dispatchRole="maintenance"
            className="w-full min-w-0"
            aria-describedby={`${id}-agent-help`}
          />
          <p id={`${id}-agent-help`} className="text-xs text-muted-foreground">
            {t("refinementDialog.agentHint")}
          </p>
        </div>
        <fieldset disabled={busy} className="space-y-2">
          <legend className="mb-2 text-sm font-medium">
            {t("refinementDialog.actionsLegend")}
          </legend>
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
            {t("refinementDialog.instructionsLabel")}
          </label>
          <Textarea
            id={`${id}-instructions`}
            value={instructions}
            onChange={(event) => setInstructions(event.target.value)}
            disabled={busy}
            maxLength={REFINEMENT_INSTRUCTIONS_MAX_CHARS}
            rows={3}
            placeholder={t("refinementDialog.instructionsPlaceholder")}
            aria-describedby={`${id}-instructions-help`}
          />
          <p id={`${id}-instructions-help`} className="text-xs text-muted-foreground">
            {/* Both counts are passed as strings: they are a character budget
                printed verbatim, not a grouped numeral. */}
            {t("refinementDialog.instructionsHint", {
              used: String(instructions.length),
              max: String(REFINEMENT_INSTRUCTIONS_MAX_CHARS),
            })}
          </p>
        </div>
        <p role="status" className="text-sm text-muted-foreground">
          {running
            ? t("refinementDialog.alreadyRunning")
            : actions.length === 0
              ? t("refinementDialog.selectAction")
              : ""}
        </p>
        <DialogFooter>
          <Button
            variant="outline"
            disabled={starting}
            onClick={() => onOpenChange(false)}
          >
            {t("cancel")}
          </Button>
          <Button
            disabled={busy || actions.length === 0}
            onClick={() => onStart({
              namedAgentId,
              instructions: instructions.trim(),
              actions,
            })}
          >
            {starting
              ? t("refinementDialog.starting")
              : t("refinementDialog.start")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
