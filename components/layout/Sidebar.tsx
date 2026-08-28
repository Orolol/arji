"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Bot, Gauge, LayoutDashboard, Plus, Settings } from "lucide-react";
import { ThemeToggle } from "@/components/ThemeToggle";
import { useProjects } from "@/hooks/useProjects";
import { cn } from "@/lib/utils";
import { NotificationBell } from "./NotificationBell";
import { InboxNavLink } from "./InboxNavLink";

/**
 * Two-letter rail tile label. Words first ("Arij Suite" → "AS"), falling back
 * to the first two characters of a single word ("arij" → "Ar").
 */
export function projectInitials(name: string): string {
  const words = name.trim().split(/[\s_-]+/).filter(Boolean);
  if (words.length === 0) return "??";
  if (words.length === 1) {
    const word = words[0];
    return (word[0] + (word[1] ?? "")).slice(0, 2).replace(/^./, (c) => c.toUpperCase());
  }
  return (words[0][0] + words[1][0]).toUpperCase();
}

/**
 * Global project rail: one 30px tile per project, a breathing dot when that
 * project has agents running, then the create shortcut and the bottom
 * utility cluster (dashboard, usage, agent config, notifications, theme,
 * inbox, settings).
 */
/**
 * Routes that ship their own Piscine header (project chips + utility cluster)
 * and must not double up on the rail. Everything not listed here is still on
 * the pre-redesign visual language and keeps the rail as its only navigation.
 */
const SELF_NAVIGATING = ["/", "/agents", "/usage"];

export function Sidebar() {
  const pathname = usePathname() ?? "";
  const { allProjects } = useProjects();

  if (SELF_NAVIGATING.includes(pathname)) return null;

  const visibleProjects = allProjects.filter((p) => p.status !== "archived");

  return (
    <aside
      className="w-[62px] shrink-0 border-r border-border bg-sidebar flex flex-col items-center py-[14px] gap-[10px]"
      data-testid="project-rail"
    >
      <div
        className="flex flex-col items-center gap-[10px] min-h-0 overflow-y-auto [scrollbar-width:none] shrink"
        data-testid="rail-project-list"
      >
      {visibleProjects.map((project) => {
        const isActive = pathname.startsWith(`/projects/${project.id}`);
        return (
          <Link
            key={project.id}
            href={`/projects/${project.id}`}
            title={project.name}
            data-testid={`rail-project-${project.id}`}
            data-active={isActive ? "true" : undefined}
            className={cn(
              "relative flex items-center justify-center w-[30px] h-[30px] shrink-0 rounded-[9px] text-[12.5px] font-semibold transition-colors",
              isActive
                ? "bg-primary text-primary-foreground"
                : "bg-card border border-border text-muted-foreground hover:text-foreground"
            )}
          >
            {projectInitials(project.name)}
            {project.activeAgents > 0 && (
              <span
                className="breathing-dot absolute -top-[3px] -right-[3px] w-2 h-2"
                data-testid={`rail-project-agent-dot-${project.id}`}
                aria-label="Agent running"
              />
            )}
          </Link>
        );
      })}

      </div>

      <Link
        href="/projects/new"
        title="New Project"
        className="flex items-center justify-center w-[30px] h-[30px] shrink-0 rounded-[9px] text-muted-foreground hover:text-foreground hover:bg-sidebar-accent transition-colors"
      >
        <Plus className="w-4 h-4" />
      </Link>

      <span className="flex-1" />

      <Link
        href="/"
        className="flex items-center justify-center w-[34px] h-[34px] rounded-[9px] text-muted-foreground hover:text-foreground hover:bg-sidebar-accent transition-colors"
        title="All projects"
      >
        <LayoutDashboard className="w-[17px] h-[17px]" />
      </Link>
      <Link
        href="/usage"
        className="flex items-center justify-center w-[34px] h-[34px] rounded-[9px] text-muted-foreground hover:text-foreground hover:bg-sidebar-accent transition-colors"
        title="Usage"
        data-testid="rail-usage-link"
      >
        <Gauge className="w-[17px] h-[17px]" />
      </Link>
      <Link
        href="/agents"
        className="flex items-center justify-center w-[34px] h-[34px] rounded-[9px] text-muted-foreground hover:text-foreground hover:bg-sidebar-accent transition-colors"
        title="Agents"
        data-testid="rail-agents-link"
      >
        <Bot className="w-[17px] h-[17px]" />
      </Link>
      <NotificationBell />
      <ThemeToggle />
      <InboxNavLink />
      <Link
        href="/settings"
        className="flex items-center justify-center w-[34px] h-[34px] rounded-[9px] text-muted-foreground hover:text-foreground hover:bg-sidebar-accent transition-colors"
        title="Settings"
      >
        <Settings className="w-[17px] h-[17px]" />
      </Link>
    </aside>
  );
}
