"use client";

import Link from "next/link";
import { FolderKanban } from "lucide-react";
import { useTranslations } from "next-intl";

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
import type { TranslationKey } from "@/lib/i18n/catalogue";

/**
 * A module-scope copy table, so it holds catalogue KEY REFERENCES and the menu
 * resolves them at render with the namespace-less translator
 * (`lib/i18n/catalogue.ts`, pattern 3).
 */
const PROJECT_PAGES: ReadonlyArray<{ segment: string; labelKey: TranslationKey }> = [
  { segment: "", labelKey: "Desk.projectMenu.pages.board" },
  { segment: "/spec", labelKey: "Desk.projectMenu.pages.spec" },
  { segment: "/sessions", labelKey: "Desk.projectMenu.pages.sessions" },
  { segment: "/documents", labelKey: "Desk.projectMenu.pages.documents" },
  { segment: "/qa", labelKey: "Desk.projectMenu.pages.qa" },
  { segment: "/frictions", labelKey: "Desk.projectMenu.pages.frictions" },
  { segment: "/releases", labelKey: "Desk.projectMenu.pages.releases" },
  { segment: "/git-sync", labelKey: "Desk.projectMenu.pages.gitSync" },
  { segment: "/github-issues", labelKey: "Desk.projectMenu.pages.githubIssues" },
  { segment: "/settings", labelKey: "Desk.projectMenu.pages.settings" },
];

export interface DeskProjectMenuProps {
  projects: readonly DeskProject[];
}

/**
 * The desk rail filters its strata, so it cannot also behave like the old
 * project links. This menu keeps every project surface reachable without
 * changing that filtering interaction.
 */
export function DeskProjectMenu({ projects }: DeskProjectMenuProps) {
  const t = useTranslations();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        data-testid="desk-project-pages"
        aria-label={t("Desk.projectMenu.label")}
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
          {t("Desk.projectMenu.label")}
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
                    {t(page.labelKey)}
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
