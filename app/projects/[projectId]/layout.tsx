"use client";

import Link from "next/link";
import { useParams, usePathname, useRouter } from "next/navigation";
import {
  Bug,
  ChevronDown,
  MessageSquare,
  Moon,
  PencilLine,
  Plus,
  RefreshCw,
} from "lucide-react";
import { GitHubConnectBanner } from "@/components/github/GitHubConnectBanner";
import { useEffect, useState, useCallback } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ProjectSourceBadge } from "@/components/layout/ProjectSourceBadge";

interface ProjectSummary {
  gitRepoPath: string | null;
  githubOwnerRepo: string | null;
  /** The branch Arij bases work on (stored at GitHub import). The repo bar
   *  reads ahead/behind against it — main is just the fallback for legacy
   *  projects that predate the column. */
  defaultBranch: string | null;
  cloneSource: string | null;
  gitRemoteUrl: string | null;
}

const TAB_CLASS =
  "text-[13.5px] px-[12px] py-[6px] rounded-[7px] transition-colors";

export default function ProjectLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const params = useParams();
  const pathname = usePathname() ?? "";
  const router = useRouter();
  const projectId = params.projectId as string;
  const [projectName, setProjectName] = useState("...");
  const [projectSummary, setProjectSummary] = useState<ProjectSummary>({
    gitRepoPath: null,
    githubOwnerRepo: null,
    defaultBranch: null,
    cloneSource: null,
    gitRemoteUrl: null,
  });
  const [syncing, setSyncing] = useState(false);

  useEffect(() => {
    fetch(`/api/projects/${projectId}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.data) {
          setProjectName(d.data.name);
          setProjectSummary({
            gitRepoPath: d.data.gitRepoPath ?? null,
            githubOwnerRepo: d.data.githubOwnerRepo ?? null,
            defaultBranch: d.data.defaultBranch ?? null,
            cloneSource: d.data.cloneSource ?? null,
            gitRemoteUrl: d.data.gitRemoteUrl ?? null,
          });
        }
      })
      .catch(() => {});
  }, [projectId]);

  const syncFromJson = useCallback(async () => {
    setSyncing(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/sync`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "import" }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Sync failed");
      // Re-fetch project metadata in case name/status changed
      const projRes = await fetch(`/api/projects/${projectId}`);
      const projJson = await projRes.json();
      if (projJson.data) setProjectName(projJson.data.name);
      // Notify child pages to reload data
      window.dispatchEvent(new CustomEvent("arji:synced"));
    } catch (err) {
      console.error("[sync] import failed:", err);
    } finally {
      setSyncing(false);
    }
  }, [projectId]);

  const boardHref = `/projects/${projectId}`;
  const isBoard = pathname === boardHref;

  const primaryTabs = [
    { href: boardHref, label: "Board", exact: true },
    { href: `/projects/${projectId}/spec`, label: "Spec & Memory", exact: false },
    { href: `/projects/${projectId}/sessions`, label: "Sessions", exact: false },
  ];

  const moreItems = [
    { href: `/projects/${projectId}/documents`, label: "Docs" },
    { href: `/projects/${projectId}/qa`, label: "QA" },
    { href: `/projects/${projectId}/frictions`, label: "Frictions" },
    { href: `/projects/${projectId}/releases`, label: "Releases" },
    { href: `/projects/${projectId}/git-sync`, label: "Git Sync" },
    { href: `/projects/${projectId}/github-issues`, label: "GitHub Issues" },
    { href: `/projects/${projectId}/settings`, label: "Settings" },
  ];

  const moreIsActive = moreItems.some((item) => pathname.startsWith(item.href));

  /**
   * Header actions never reach into the board's imperative handles: they set
   * a URL param the board page already knows how to consume, so they work
   * identically from Spec, Sessions or any other tab.
   */
  const openBoardPanel = (query: string) => router.push(`${boardHref}?${query}`);

  return (
    <div className="flex flex-col h-full">
      <header className="h-[54px] shrink-0 flex items-center gap-[18px] px-[22px] border-b border-border">
        <h1 className="text-[16px] font-semibold tracking-[-0.01em] truncate max-w-[240px]">
          {projectName}
        </h1>

        <nav className="flex items-center gap-[2px]">
          {primaryTabs.map((tab) => {
            const isActive = tab.exact
              ? pathname === tab.href
              : pathname.startsWith(tab.href);
            return (
              <Link
                key={tab.href}
                href={tab.href}
                className={cn(
                  TAB_CLASS,
                  isActive
                    ? "bg-card border border-border font-medium"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                {tab.label}
              </Link>
            );
          })}

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                data-testid="project-nav-more"
                className={cn(
                  TAB_CLASS,
                  "inline-flex items-center gap-[5px] outline-none",
                  moreIsActive
                    ? "bg-card border border-border font-medium"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                More
                <ChevronDown className="w-[13px] h-[13px]" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="min-w-[168px]">
              {moreItems.map((item) => (
                <DropdownMenuItem key={item.href} asChild>
                  <Link href={item.href} className="text-[13px]">
                    {item.label}
                  </Link>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </nav>

        {projectSummary.gitRepoPath && (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={syncFromJson}
                  disabled={syncing}
                  aria-label="Sync from arji.json"
                  className="flex items-center justify-center w-[26px] h-[26px] rounded-[7px] text-muted-foreground hover:text-foreground hover:bg-accent transition-colors disabled:opacity-50"
                >
                  <RefreshCw
                    className={cn(
                      "w-[13px] h-[13px]",
                      syncing && "animate-spin motion-reduce:animate-none"
                    )}
                  />
                </button>
              </TooltipTrigger>
              <TooltipContent>
                <p>Import from arji.json (overrides DB)</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}

        <ProjectSourceBadge
          gitRepoPath={projectSummary.gitRepoPath}
          cloneSource={projectSummary.cloneSource}
          gitRemoteUrl={projectSummary.gitRemoteUrl}
        />

        <div className="ml-auto flex items-center gap-[8px]">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                data-testid="header-new-button"
                className="h-[31px] rounded-[8px] px-[13px] text-[13px] font-medium gap-[7px]"
              >
                <Plus className="w-[14px] h-[14px]" />
                New
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-[228px]">
              {/*
                Two epic paths, named for what they cost: the form is instant
                and agent-free, the chat is the brainstorming round-trip. The
                manual entry comes first because it is the cheaper default.
              */}
              <DropdownMenuItem
                data-testid="header-new-epic-manual"
                onSelect={() => openBoardPanel("panel=new-epic-manual")}
                className="text-[13px]"
              >
                <PencilLine className="w-[13px] h-[13px]" />
                New Epic (manual)
              </DropdownMenuItem>
              <DropdownMenuItem
                data-testid="header-new-epic-chat"
                onSelect={() => openBoardPanel("panel=new-epic")}
                className="text-[13px]"
              >
                <MessageSquare className="w-[13px] h-[13px]" />
                New Epic (via chat)
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                data-testid="header-new-bug"
                onSelect={() => openBoardPanel("panel=new-bug")}
                className="text-[13px]"
              >
                <Bug className="w-[13px] h-[13px]" />
                New Bug
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <Button
            type="button"
            variant="outline"
            data-testid="night-run-button"
            onClick={() => openBoardPanel("night=start")}
            className="h-[31px] rounded-[8px] px-[12px] text-[13px] gap-[7px]"
          >
            <Moon className="w-[14px] h-[14px]" />
            Night run
          </Button>

          <Button
            type="button"
            variant="outline"
            data-testid="header-chat-button"
            onClick={() => openBoardPanel("panel=chat")}
            className="h-[31px] rounded-[8px] px-[12px] text-[13px] gap-[7px]"
          >
            <MessageSquare className="w-[14px] h-[14px]" />
            Chat
          </Button>
        </div>
      </header>

      <GitHubConnectBanner
        projectId={projectId}
        gitRepoPath={projectSummary.gitRepoPath}
        githubOwnerRepo={projectSummary.githubOwnerRepo}
        onConnected={(ownerRepo) =>
          setProjectSummary((prev) => ({ ...prev, githubOwnerRepo: ownerRepo }))
        }
      />

      <div className="flex flex-1 overflow-hidden">
        <div className="flex-1 overflow-auto">{children}</div>
      </div>
    </div>
  );
}
