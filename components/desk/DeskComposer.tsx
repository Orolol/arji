"use client";

import * as React from "react";
import { Sparkles } from "lucide-react";

import { SelectPill, projectTone } from "@/components/piscine";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { useNamedAgentsList } from "@/hooks/useNamedAgentsList";
import type { DeskProject } from "@/lib/control-desk/types";
import { cn } from "@/lib/utils";

/**
 * The linden bar: type a feature, ⏎ writes the ticket, ⇧⏎ writes it AND sends
 * it to a builder.
 *
 * THERE IS NO `draft` EPIC STATUS. `KANBAN_COLUMNS` is
 * backlog|todo|in_progress|review|to_merge|done|released and `createEpicSchema`
 * accepts that set minus `released`, so the composer POSTs
 * `{title, status:"backlog", type:"feature"}` — byte for byte what the board's
 * QuickCapture posted — and ⇧⏎ then chains the build dispatch with the new
 * epic id. Inventing a draft status would mean a migration and a new column in
 * every consumer of the board.
 *
 * On failure the typed title is KEPT, so a rejected POST costs a retry and not
 * a re-type.
 */
export interface DeskComposerProps {
  projects: readonly DeskProject[];
  /** The project a new ticket lands in. Defaults to the first project. */
  targetProjectId: string | null;
  onTargetProjectChange: (projectId: string) => void;
  namedAgentId: string | null;
  onNamedAgentChange: (namedAgentId: string | null) => void;
  /** `dispatch` is true for ⇧⏎: create, then send straight to a builder. */
  onSubmit: (input: {
    title: string;
    projectId: string;
    namedAgentId: string | null;
    dispatch: boolean;
  }) => Promise<boolean> | boolean;
  disabled?: boolean;
  className?: string;
}

export const COMPOSER_PLACEHOLDER =
  "Décris une feature — ⏎ rédige l'epic et ses stories, ⇧⏎ l'envoie direct en dev";

export function DeskComposer({
  projects,
  targetProjectId,
  onTargetProjectChange,
  namedAgentId,
  onNamedAgentChange,
  onSubmit,
  disabled = false,
  className,
}: DeskComposerProps) {
  const [title, setTitle] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const composingRef = React.useRef(false);
  const { agents } = useNamedAgentsList();

  const project =
    projects.find((candidate) => candidate.id === targetProjectId) ?? projects[0];
  const agentName =
    agents.find((candidate) => candidate.id === namedAgentId)?.name ?? "Default agent";

  async function submit(dispatch: boolean) {
    const trimmed = title.trim();
    if (!trimmed || busy || !project) return;
    setBusy(true);
    try {
      const ok = await onSubmit({
        title: trimmed,
        projectId: project.id,
        namedAgentId,
        dispatch,
      });
      // Keep the typed title on failure so a retry costs nothing.
      if (ok) setTitle("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      data-testid="desk-composer"
      className={cn(
        "mx-[14px] mt-[10px] mb-3 flex h-[58px] shrink-0 items-center gap-[13px]",
        "rounded-lg bg-strata-feed stratum-feed px-[18px]",
        className,
      )}
    >
      <Sparkles size={16} aria-hidden="true" className="shrink-0 text-strata-feed-deep" />

      <input
        type="text"
        value={title}
        disabled={disabled || busy || !project}
        placeholder={COMPOSER_PLACEHOLDER}
        aria-label="Décris une feature"
        data-testid="desk-composer-input"
        onChange={(event) => setTitle(event.target.value)}
        onCompositionStart={() => {
          composingRef.current = true;
        }}
        onCompositionEnd={() => {
          composingRef.current = false;
        }}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          // Never swallow Enter while an IME candidate window is open.
          if (composingRef.current || event.nativeEvent.isComposing) return;
          event.preventDefault();
          void submit(event.shiftKey);
        }}
        className={cn(
          "min-w-0 flex-1 border-0 bg-transparent p-0",
          "font-sans text-[13.5px] font-medium text-strata-feed-deep",
          "placeholder:text-strata-feed-deep placeholder:opacity-80",
          "outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
          "disabled:opacity-60",
        )}
      />

      <SelectPill
        label={project?.shortName ?? "—"}
        tone="project"
        projectTone={projectTone(project?.colorIndex ?? 0)}
        disabled={projects.length === 0}
      >
        {projects.map((candidate) => (
          <DropdownMenuItem
            key={candidate.id}
            onSelect={() => onTargetProjectChange(candidate.id)}
          >
            {candidate.name}
          </DropdownMenuItem>
        ))}
      </SelectPill>

      <SelectPill label={agentName} tone="ink">
        <DropdownMenuItem onSelect={() => onNamedAgentChange(null)}>
          Default agent
        </DropdownMenuItem>
        {agents.map((agent) => (
          <DropdownMenuItem key={agent.id} onSelect={() => onNamedAgentChange(agent.id)}>
            {agent.name}
          </DropdownMenuItem>
        ))}
      </SelectPill>
    </div>
  );
}
