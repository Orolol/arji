"use client";

import Link from "next/link";
import { Plus } from "lucide-react";

import { IdentityChip, projectTone } from "@/components/piscine";
import type { DeskProject } from "@/lib/control-desk/types";
import { cn } from "@/lib/utils";

/**
 * The header's project rail: one chip per project, then a dashed "+".
 *
 * Colour here is IDENTITY, never state — the chip's fill/deep pair comes from
 * the project's slot in the fixed 4-colour cycle. The only state the rail
 * carries is the 6px breathing dot on a project with a live agent, and that is
 * motion, not colour.
 *
 * OVERFLOW (undrawn in the frame): past four projects the colour cycle wraps —
 * two projects sharing a colour is accepted by the design — and the rail
 * scrolls horizontally rather than wrapping onto a second line, because the
 * header is a fixed 60px band.
 */
export interface DeskProjectRailProps {
  projects: readonly DeskProject[];
  /** The project the desk is filtered to, or `null` for "all projects". */
  activeProjectId: string | null;
  onSelect: (projectId: string | null) => void;
  /** Where the dashed "+" leads. A real link, so it is middle-clickable. */
  addProjectHref?: string;
  className?: string;
}

export function DeskProjectRail({
  projects,
  activeProjectId,
  onSelect,
  addProjectHref = "/projects/new",
  className,
}: DeskProjectRailProps) {
  return (
    <div
      data-testid="desk-project-rail"
      className={cn(
        "ml-[10px] flex min-w-0 items-center gap-[6px] overflow-x-auto",
        // The rail scrolls; it must never push the right cluster off-screen.
        "[scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        className,
      )}
    >
      {projects.map((project) => {
        const active = activeProjectId === project.id;
        return (
          <IdentityChip
            key={project.id}
            label={project.name}
            tone={projectTone(project.colorIndex)}
            size="md"
            live={project.activeAgents > 0}
            onClick={() => onSelect(active ? null : project.id)}
            // 2px is the selection border in this system, and only that.
            className={cn(active && "border-2 border-foreground")}
          />
        );
      })}

      <Link
        href={addProjectHref}
        aria-label="New project"
        data-testid="desk-add-project"
        className={cn(
          "flex h-[28px] w-[28px] shrink-0 items-center justify-center rounded-full",
          "border-[1.5px] border-dashed border-border-strong text-muted-foreground",
          "outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
          "transition-colors hover:text-foreground motion-reduce:transition-none",
        )}
      >
        <Plus size={13} aria-hidden="true" />
      </Link>
    </div>
  );
}
