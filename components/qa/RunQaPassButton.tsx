"use client";

import * as React from "react";
import { Play } from "lucide-react";

import { IdentityChip, Mono, PillButton, projectTone } from "@/components/piscine";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import type { DeskProject } from "@/lib/control-desk/types";
import type { QaReviewTarget } from "@/lib/qa/types";
import { cn } from "@/lib/utils";

/**
 * "Run QA pass" — the screen's one filled button outside the finding rows.
 *
 * IT NEEDS A TARGET, so it is a popover rather than a fire-and-forget pill:
 * `POST /api/projects/{p}/epics/{e}/review` dispatches ONE session per review
 * type on ONE epic. Fanning a review out across every eligible ticket from one
 * click would be N concurrent agents from one button, so the popover lists the
 * eligible tickets and one click dispatches one.
 *
 * The eligible list comes from the payload (`reviewable`), derived server-side
 * against the same statuses the route accepts and with epics that already own
 * an agent removed — so this never offers a dispatch that would 409.
 *
 * The named agent is resolved server-side by `resolveAgentForDispatch(...,
 * { purpose: "review" })`, which IS "the review agent per its 7a assignment".
 * No `namedAgentId` is sent.
 */
export interface RunQaPassButtonProps {
  targets: readonly QaReviewTarget[];
  projectsById: ReadonlyMap<string, DeskProject>;
  onRun: (target: QaReviewTarget) => void | Promise<void>;
  pending?: boolean;
  className?: string;
}

export function RunQaPassButton({
  targets,
  projectsById,
  onRun,
  pending = false,
  className,
}: RunQaPassButtonProps) {
  const [open, setOpen] = React.useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <PillButton
          variant="filled"
          size="md"
          icon={Play}
          disabled={targets.length === 0}
          pending={pending}
          pendingLabel="Dispatch…"
          data-testid="qa-run-pass"
          className={className}
        >
          Run QA pass
        </PillButton>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        data-testid="qa-run-pass-menu"
        className="w-[320px] rounded-[12px] border-[1.5px] border-border bg-card p-2 shadow-none"
      >
        {targets.length === 0 ? (
          <span className="block px-2 py-[6px] font-sans text-[12.5px] text-muted-foreground">
            Aucun ticket en review pour l&apos;instant.
          </span>
        ) : (
          <div className="flex max-h-[280px] flex-col gap-1 overflow-y-auto">
            {targets.map((target) => {
              const project = projectsById.get(target.projectId);
              return (
                <button
                  key={target.epicId}
                  type="button"
                  data-testid="qa-run-pass-target"
                  onClick={() => {
                    setOpen(false);
                    void onRun(target);
                  }}
                  className={cn(
                    "flex w-full cursor-pointer items-center gap-2 rounded-[10px] px-2 py-[6px] text-left",
                    "outline-none hover:bg-muted",
                    "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                  )}
                >
                  <IdentityChip
                    label={target.readableId ?? project?.shortName ?? "—"}
                    tone={projectTone(project?.colorIndex ?? 0)}
                    size="sm"
                  />
                  <span className="min-w-0 flex-1 truncate font-sans text-[12.5px] text-foreground">
                    {target.title}
                  </span>
                  <Mono size={10} tone="muted">
                    {target.status}
                  </Mono>
                </button>
              );
            })}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
