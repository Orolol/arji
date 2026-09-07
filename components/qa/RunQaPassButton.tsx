"use client";

import { useTranslations } from "next-intl";
import { Play } from "lucide-react";

import { IdentityChip, Mono, PillButton, projectTone } from "@/components/piscine";
import type { DeskProject } from "@/lib/control-desk/types";
import type { QaReviewTarget } from "@/lib/qa/types";

import { PickerPopover } from "./PickerPopover";

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
 *
 * The popover shell — card, scroller, row geometry and the one focus ring — is
 * `PickerPopover`, shared with "New check"; only the row's contents are here.
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
  const t = useTranslations("Qa");

  return (
    <PickerPopover
      trigger={
        <PillButton
          variant="filled"
          size="md"
          icon={Play}
          disabled={targets.length === 0}
          pending={pending}
          pendingLabel={t("runPass.pending")}
          data-testid="qa-run-pass"
          className={className}
        >
          {t("runPass.label")}
        </PillButton>
      }
      items={targets}
      keyOf={(target) => target.epicId}
      onSelect={(target) => void onRun(target)}
      emptyLabel={t("runPass.emptyLabel")}
      width={320}
      testId="qa-run-pass-menu"
      itemTestId="qa-run-pass-target"
    >
      {(target) => {
        const project = projectsById.get(target.projectId);
        return (
          <>
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
          </>
        );
      }}
    </PickerPopover>
  );
}
