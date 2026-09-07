"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";

import { FieldKicker, QuietLink } from "@/components/piscine";
import { NamedAgentSelect } from "@/components/shared/NamedAgentSelect";
import { SessionPicker } from "@/components/shared/SessionPicker";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@/components/ui/popover";

export interface ChangelogAgentPopoverProps {
  projectId: string;
  namedAgentId: string | null;
  onNamedAgentChange: (id: string | null) => void;
  /** Provider of the chosen named agent; undefined lets the server resolve the
   *  default for the `release_notes` agent type. */
  selectedAgentProvider: string | undefined;
  resumeSessionId: string | undefined;
  onResumeSessionChange: (id: string | undefined) => void;
}

/**
 * The frame's `régénérer` link, renamed to `changelog agent`.
 *
 * There is no regeneration endpoint: the changelog agent runs exactly once,
 * inside `POST /releases`. A link labelled "régénérer" would have to fire
 * nothing. Instead it opens the agent + resume picker that used to live in the
 * New Release dialog, so the choice is made BEFORE the one run happens.
 *
 * The popover is anchored rather than triggered because `PopoverTrigger
 * asChild` clones props onto its child, and `QuietLink` (a gate-2 primitive)
 * does not spread unknown props. Anchoring keeps the real primitive and still
 * gets Radix's portal, focus trap and dismiss behaviour.
 */
export function ChangelogAgentPopover({
  projectId,
  namedAgentId,
  onNamedAgentChange,
  selectedAgentProvider,
  resumeSessionId,
  onResumeSessionChange,
}: ChangelogAgentPopoverProps) {
  const t = useTranslations("Releases");
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <span className="inline-flex" data-testid="release-changelog-agent">
          <QuietLink
            tone="next"
            size={11.5}
            onClick={() => setOpen((prev) => !prev)}
          >
            {t("changelogAgent.link")}
          </QuietLink>
        </span>
      </PopoverAnchor>
      <PopoverContent
        align="end"
        className="flex w-[320px] flex-col gap-[10px] rounded-[12px] border-[1.5px] border-border bg-card p-[14px] shadow-none"
      >
        <FieldKicker stratum="card" size={10}>
          {t("changelogAgent.kicker")}
        </FieldKicker>
        <NamedAgentSelect
          value={namedAgentId}
          onChange={(id) => {
            onNamedAgentChange(id);
            // A session id belonging to agent A is not resumable by agent B:
            // the server silently drops it, so the user would believe they
            // resumed a run that never resumed.
            onResumeSessionChange(undefined);
          }}
          dispatchRole="release"
          className="h-[34px] w-full rounded-[10px] text-[13px]"
          aria-label={t("changelogAgent.selectLabel")}
        />
        <SessionPicker
          projectId={projectId}
          agentType="release_notes"
          namedAgentId={namedAgentId}
          provider={selectedAgentProvider}
          selectedSessionId={resumeSessionId}
          onSelect={onResumeSessionChange}
        />
      </PopoverContent>
    </Popover>
  );
}
