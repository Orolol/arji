"use client";

import Link from "next/link";
import { useParams, usePathname } from "next/navigation";
import { ArrowLeft, Kanban, FileText, Files, Activity, Tag, MessageSquare } from "lucide-react";
import { ChatPanel } from "@/components/chat/ChatPanel";
import { GitHubConnectBanner } from "@/components/github/GitHubConnectBanner";
import { useEffect, useState, useCallback } from "react";
import { cn } from "@/lib/utils";

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
  const [chatOpen, setChatOpen] = useState(false);
  const [conversationCount, setConversationCount] = useState(0);

  const fetchConversationCount = useCallback(() => {
    fetch(`/api/projects/${projectId}/conversations`)
      .then((r) => r.json())
      .then((d) => {
        if (d.data) setConversationCount(d.data.length);
      })
      .catch(() => {});
  }, [projectId]);

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
    fetchConversationCount();
  }, [projectId, fetchConversationCount]);

  // Refresh count when chat panel toggles
  useEffect(() => {
    if (!chatOpen) {
      fetchConversationCount();
    }
  }, [chatOpen, fetchConversationCount]);

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
        <div className="ml-auto">
          <button
            onClick={() => setChatOpen(!chatOpen)}
            className={cn(
              "flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm transition-colors",
              chatOpen
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground hover:bg-accent/50"
            )}
          >
            <MessageSquare className="h-4 w-4" />
            Chat
            {!chatOpen && conversationCount > 0 && (
              <span className="min-w-5 h-5 px-1.5 rounded-full bg-primary text-primary-foreground text-xs font-medium flex items-center justify-center">
                {conversationCount}
              </span>
            )}
          </button>
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
        {chatOpen && (
          <div className="w-96 border-l border-border shrink-0">
            <ChatPanel projectId={projectId} />
          </div>
        )}
      </div>
    </div>
  );
}
