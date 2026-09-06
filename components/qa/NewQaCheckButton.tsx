"use client";

import { FlaskConical } from "lucide-react";

import { IdentityChip, PillButton, projectTone } from "@/components/piscine";
import type { DeskProject } from "@/lib/control-desk/types";

import { PickerPopover } from "./PickerPopover";

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
 * single answer. The popover itself is `PickerPopover`, shared with
 * "Run QA pass".
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

/**
 * Why the button is dead, in the one workspace state where that is not obvious.
 *
 * A workspace whose projects were all attached to a local path with no
 * `git_repo_path` gets a pill that never responds, and "QA checks are broken
 * again" is exactly the reading this epic exists to stop.
 */
const NO_PROJECT_REASON = "Aucun projet avec un dépôt git : un QA check tourne dans le dépôt du projet.";

export function NewQaCheckButton({
  projects,
  onSelect,
  className,
}: NewQaCheckButtonProps) {
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

  if (projects.length === 0) {
    // The `title` goes on a WRAPPER, not on the button: `PillButton` carries
    // `disabled:pointer-events-none`, and an element that takes no pointer
    // events never shows its own native tooltip. The span does.
    return (
      <span title={NO_PROJECT_REASON} data-testid="qa-new-check-blocked">
        {trigger}
      </span>
    );
  }

  if (projects.length === 1) return trigger;

  return (
    <PickerPopover
      trigger={trigger}
      items={projects}
      keyOf={(project) => project.id}
      onSelect={(project) => onSelect(project.id)}
      // Unreachable while the caller only mounts this with a non-empty list,
      // and kept because the component's contract does not promise that.
      emptyLabel="Aucun projet avec un dépôt git."
      width={280}
      testId="qa-new-check-menu"
      itemTestId="qa-new-check-project"
    >
      {(project) => (
        <>
          <IdentityChip
            label={project.shortName}
            tone={projectTone(project.colorIndex)}
            size="sm"
          />
          <span className="min-w-0 flex-1 truncate font-sans text-[12.5px] text-foreground">
            {project.name}
          </span>
        </>
      )}
    </PickerPopover>
  );
}
