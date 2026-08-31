"use client";

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
import { useCallback, useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { PillButton, pillButtonVariants } from "@/components/piscine";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/**
 * The project shell — frame 13a's retrofit.
 *
 * THIS LAYOUT NO LONGER DRAWS A HEADER. It used to draw a 54px bar (project
 * name · Board/Spec/Sessions tabs · "More" · New/Night run/Chat), which on a
 * session page made THREE stacked headers: the global bar, this one, and the
 * screen's own. `components/piscine/TopBar.tsx` now owns every one of those
 * jobs — the project's name and colour are its chips, and its three category
 * menus reach Spec & Memory, Sessions and Releases. The rest of the old "More"
 * list (Docs, QA, Frictions, Git Sync, GitHub Issues, project Settings) is
 * reachable from the desk's project-pages menu.
 *
 * WHAT SURVIVES, AND WHY IT SURVIVES HERE. Three controls had no home in the
 * bar because they are neither navigation nor global: the New menu (epic /
 * manual epic / bug), Night run, and the arji.json import. All three act by
 * pushing a `?panel=` / `?night=` param that ONLY the board page consumes, so
 * they are drawn ONLY on the board route — no other project route grows a
 * second bar from them, and the routes this wave rebuilt (spec, sessions,
 * releases, a session) render exactly one header, the global one, above their
 * own screen row.
 *
 * The Chat button did NOT survive: the board's own collapsed chat strip
 * (`components/chat/UnifiedChatPanel.tsx`) opens the same panel, on the same
 * screen, and two controls for one panel is the duplication 13a removes.
 *
 * TRANSITIONAL, and the seam is deliberate: the board page draws its own
 * second row (`board-capture-bar`, Full Auto + Refinement). These three belong
 * in THAT row. This layout keeps them alive until the board packet folds them
 * in; nothing else about them should change on the way.
 */

interface ProjectSummary {
  gitRepoPath: string | null;
  githubOwnerRepo: string | null;
  /** The branch Arij bases work on (stored at GitHub import). The repo bar
   *  reads ahead/behind against it — main is just the fallback for legacy
   *  projects that predate the column. */
  defaultBranch: string | null;
}

export default function ProjectLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const params = useParams();
  const pathname = usePathname() ?? "";
  const router = useRouter();
  const projectId = params.projectId as string;
  const [projectSummary, setProjectSummary] = useState<ProjectSummary>({
    gitRepoPath: null,
    githubOwnerRepo: null,
    defaultBranch: null,
  });
  const [syncing, setSyncing] = useState(false);

  const loadSummary = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${projectId}`);
      const d = await res.json();
      if (d.data) {
        setProjectSummary({
          gitRepoPath: d.data.gitRepoPath ?? null,
          githubOwnerRepo: d.data.githubOwnerRepo ?? null,
          defaultBranch: d.data.defaultBranch ?? null,
        });
      }
    } catch {
      // A failed metadata read must never break the shell: the banner and the
      // repo bar both degrade to "no repo", which is what an unknown project
      // looks like anyway.
    }
  }, [projectId]);

  useEffect(() => {
    void loadSummary();
  }, [loadSummary]);

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
      // Re-read the metadata in case the import changed the repo wiring.
      await loadSummary();
      // Notify child pages to reload data
      window.dispatchEvent(new CustomEvent("arji:synced"));
    } catch (err) {
      console.error("[sync] import failed:", err);
    } finally {
      setSyncing(false);
    }
  }, [projectId, loadSummary]);

  const boardHref = `/projects/${projectId}`;
  const isBoard = pathname === boardHref;

  /**
   * Header actions never reach into the board's imperative handles: they set
   * a URL param the board page already knows how to consume.
   */
  const openBoardPanel = (query: string) => router.push(`${boardHref}?${query}`);

  return (
    <div className="flex h-full flex-col">
      <GitHubConnectBanner
        projectId={projectId}
        gitRepoPath={projectSummary.gitRepoPath}
        githubOwnerRepo={projectSummary.githubOwnerRepo}
        onConnected={(ownerRepo) =>
          setProjectSummary((prev) => ({ ...prev, githubOwnerRepo: ownerRepo }))
        }
      />

      {isBoard && (
        <div
          data-testid="project-action-row"
          className="flex h-[38px] shrink-0 items-center gap-[8px] px-[14px]"
        >
          <DropdownMenu>
            {/*
              The pill recipe on the trigger itself: Radix's trigger IS the
              button, so nesting a PillButton inside it would ship a button in
              a button.
            */}
            <DropdownMenuTrigger
              data-testid="header-new-button"
              className={pillButtonVariants({ variant: "filled", size: "md" })}
            >
              <Plus size={13} aria-hidden="true" />
              New
              <ChevronDown size={12} aria-hidden="true" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="min-w-[228px]">
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

          <PillButton
            variant="outline"
            outlineTone="neutral"
            size="md"
            icon={Moon}
            data-testid="night-run-button"
            onClick={() => openBoardPanel("night=start")}
          >
            Night run
          </PillButton>

          {projectSummary.gitRepoPath && (
            <PillButton
              variant="outline"
              outlineTone="neutral"
              size="md"
              iconOnly
              icon={RefreshCw}
              onClick={syncFromJson}
              disabled={syncing}
              title="Import from arji.json (overrides DB)"
              className={cn(
                syncing &&
                  "[&_svg]:animate-spin motion-reduce:[&_svg]:animate-none",
              )}
            >
              Sync from arji.json
            </PillButton>
          )}
        </div>
      )}

      <div className="flex flex-1 overflow-hidden">
        <div className="flex-1 overflow-auto">{children}</div>
      </div>
    </div>
  );
}
