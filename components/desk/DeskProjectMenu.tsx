"use client";

import Link from "next/link";
import { FolderKanban } from "lucide-react";

import { IdentityChip, pillButtonVariants, projectTone } from "@/components/piscine";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { DeskProject } from "@/lib/control-desk/types";

const PROJECT_PAGES = [
  { segment: "", label: "Board" },
  { segment: "/spec", label: "Spec & Memory" },
  { segment: "/sessions", label: "Sessions" },
  { segment: "/documents", label: "Docs" },
  { segment: "/qa", label: "QA" },
  { segment: "/frictions", label: "Frictions" },
  { segment: "/releases", label: "Releases" },
  { segment: "/git-sync", label: "Git Sync" },
  { segment: "/github-issues", label: "GitHub Issues" },
  { segment: "/settings", label: "Settings" },
] as const;

export interface DeskProjectMenuProps {
  projects: readonly DeskProject[];
}

/**
 * The desk rail filters its strata, so it cannot also behave like the old
 * project links. This menu keeps every project surface reachable without
 * changing that filtering interaction.
 */
export function DeskProjectMenu({ projects }: DeskProjectMenuProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        data-testid="desk-project-pages"
        aria-label="Project pages"
        disabled={projects.length === 0}
        className={pillButtonVariants({
          variant: "outline",
          outlineTone: "neutral",
          size: "md",
          iconOnly: true,
        })}
      >
        <FolderKanban size={14} aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-[min(360px,calc(100vw-16px))] max-h-[min(560px,calc(100vh-80px))]"
      >
        <DropdownMenuLabel className="font-mono text-[10.5px] font-bold uppercase text-muted-foreground">
          Project pages
        </DropdownMenuLabel>
        {projects.map((project, index) => (
          <div key={project.id}>
            {index > 0 ? <DropdownMenuSeparator /> : null}
            <div
              data-testid={`desk-project-pages-${project.id}`}
              className="flex items-center gap-2 px-2 py-1.5"
            >
              <IdentityChip
                label={project.shortName}
                tone={projectTone(project.colorIndex)}
                size="sm"
              />
              <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
                {project.name}
              </span>
            </div>
            <div className="grid grid-cols-2 gap-0.5 px-1 pb-1">
              {PROJECT_PAGES.map((page) => (
                <DropdownMenuItem key={page.segment} asChild>
                  <Link
                    href={`/projects/${project.id}${page.segment}`}
                    className="min-w-0 truncate text-[12.5px]"
                  >
                    {page.label}
                  </Link>
                </DropdownMenuItem>
              ))}
            </div>
          </div>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
