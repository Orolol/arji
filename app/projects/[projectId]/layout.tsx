"use client";

import Link from "next/link";
import { useParams, usePathname } from "next/navigation";
import { ArrowLeft, Kanban, FileText, Files, Activity, Tag, RefreshCw, ShieldCheck } from "lucide-react";
import { GitHubConnectBanner } from "@/components/github/GitHubConnectBanner";
import { useEffect, useState, useCallback } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface ProjectSummary {
  gitRepoPath: string | null;
  githubOwnerRepo: string | null;
}

export default function ProjectLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const params = useParams();
  const pathname = usePathname();
  const projectId = params.projectId as string;
  const [projectName, setProjectName] = useState("...");
  const [projectSummary, setProjectSummary] = useState<ProjectSummary>({
    gitRepoPath: null,
    githubOwnerRepo: null,
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

  const navItems = [
    { href: `/projects/${projectId}`, label: "Kanban", icon: Kanban },
    { href: `/projects/${projectId}/spec`, label: "Spec", icon: FileText },
    { href: `/projects/${projectId}/documents`, label: "Docs", icon: Files },
    {
      href: `/projects/${projectId}/sessions`,
      label: "Sessions",
      icon: Activity,
    },
    {
      href: `/projects/${projectId}/qa`,
      label: "QA",
      icon: ShieldCheck,
    },
    {
      href: `/projects/${projectId}/releases`,
      label: "Releases",
      icon: Tag,
    },
  ];

  return (
    <div className="flex flex-col h-full">
      <header className="border-b border-border px-4 py-3 flex items-center gap-4 shrink-0">
        <Link
          href="/"
          className="text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <h1 className="font-semibold text-lg">{projectName}</h1>
        <nav className="flex items-center gap-1 ml-4">
          {navItems.map((item) => {
            const isActive =
              item.href === `/projects/${projectId}`
                ? pathname === item.href
                : pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm transition-colors",
                  isActive
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:text-foreground hover:bg-accent/50"
                )}
              >
                <item.icon className="h-4 w-4" />
                {item.label}
              </Link>
            );
          })}
        </nav>

        {/* Right-side actions */}
        {projectSummary.gitRepoPath && (
          <div className="ml-auto flex items-center gap-2">
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={syncFromJson}
                    disabled={syncing}
                    className="gap-1.5 text-muted-foreground"
                  >
                    <RefreshCw
                      className={cn("h-3.5 w-3.5", syncing && "animate-spin")}
                    />
                    <span className="text-xs">Sync</span>
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  <p>Import from arji.json (overrides DB)</p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
        )}
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
