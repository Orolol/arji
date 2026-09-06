"use client";

import { useState } from "react";
import { FlaskConical } from "lucide-react";

import { IdentityChip, PillButton, projectTone } from "@/components/piscine";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import type { DeskProject } from "@/lib/control-desk/types";
import { cn } from "@/lib/utils";

/**
 * "New check" — the control the redesign lost.
 *
 * Tech Check, E2E Test and Failure Digest are dispatched by `POST
 * /api/projects/{p}/qa/check`, and `components/qa/StartQaCheckDialog.tsx` has
 * always been able to compose one. What disappeared was the way in: the nav's
 * QA entry now leads to `/qa`, the cross-project REVIEW layer, and the only
 * screen still mounting that dialog is `/projects/:id/qa`, reachable from an
 * icon-only dropdown on the desk and from nowhere else. This button is the
 * missing entry point, on the screen the nav actually opens.
 *
 * IT NEEDS A PROJECT, for the same reason "Run QA pass" needs a ticket: the
 * check route is per project and 400s on a project with no `git_repo_path`, so
 * the caller passes only the projects the route would accept
 * (`checkableProjectIds`) and one click picks one. With exactly one such
 * project there is nothing to disambiguate and the button dispatches straight
 * into the dialog — a one-row menu is a click that asks a question with a
 * single answer.
 *
 * OUTLINE, NOT FILLED. "Run QA pass" is this row's one filled button and the
 * Piscine rule is at most one per row; this one is the action outline beside
 * it.
 */
export interface NewQaCheckButtonProps {
  /** Projects the check route would accept, in the payload's own order. */
  projects: readonly DeskProject[];
  onSelect: (projectId: string) => void;
  className?: string;
}

export function NewQaCheckButton({
  projects,
  onSelect,
  className,
}: NewQaCheckButtonProps) {
  const [open, setOpen] = useState(false);

  const trigger = (
    <PillButton
      variant="outline"
      outlineTone="action"
      size="md"
      icon={FlaskConical}
      disabled={projects.length === 0}
      data-testid="qa-new-check"
      className={className}
      // With one project the trigger IS the action; with several the popover
      // owns the click and this handler must not also fire.
      onClick={projects.length === 1 ? () => onSelect(projects[0].id) : undefined}
    >
      New check
    </PillButton>
  );

  if (projects.length <= 1) return trigger;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent
        align="end"
        data-testid="qa-new-check-menu"
        className="w-[280px] rounded-[12px] border-[1.5px] border-border bg-card p-2 shadow-none"
      >
        <div className="flex max-h-[280px] flex-col gap-1 overflow-y-auto">
          {projects.map((project) => (
            <button
              key={project.id}
              type="button"
              data-testid="qa-new-check-project"
              onClick={() => {
                setOpen(false);
                onSelect(project.id);
              }}
              className={cn(
                "flex w-full cursor-pointer items-center gap-2 rounded-[10px] px-2 py-[6px] text-left",
                "outline-none hover:bg-muted",
                "focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring",
              )}
            >
              <IdentityChip
                label={project.shortName}
                tone={projectTone(project.colorIndex)}
                size="sm"
              />
              <span className="min-w-0 flex-1 truncate font-sans text-[12.5px] text-foreground">
                {project.name}
              </span>
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
