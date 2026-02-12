"use client";

import { useState } from "react";
import Link from "next/link";
import { LayoutDashboard, Settings, FolderKanban, Bot } from "lucide-react";
import { ThemeToggle } from "@/components/ThemeToggle";
import { AgentConfigPanel } from "@/components/agent-config/AgentConfigPanel";

export function SidebarNav() {
  const [agentConfigOpen, setAgentConfigOpen] = useState(false);

  return (
    <>
      <aside className="w-16 border-r border-border bg-sidebar flex flex-col items-center py-4 gap-4">
        <Link
          href="/"
          className="flex items-center justify-center w-10 h-10 rounded-lg font-bold text-lg text-primary"
        >
          <FolderKanban className="h-6 w-6" />
        </Link>
        <div className="flex-1 flex flex-col items-center gap-2 mt-4">
          <Link
            href="/"
            className="flex items-center justify-center w-10 h-10 rounded-lg hover:bg-sidebar-accent text-sidebar-foreground transition-colors"
            title="Dashboard"
          >
            <LayoutDashboard className="h-5 w-5" />
          </Link>
          <button
            onClick={() => setAgentConfigOpen(true)}
            className="flex items-center justify-center w-10 h-10 rounded-lg hover:bg-sidebar-accent text-sidebar-foreground transition-colors"
            title="Agent Configuration"
          >
            <Bot className="h-5 w-5" />
          </button>
        </div>
        <ThemeToggle />
        <Link
          href="/settings"
          className="flex items-center justify-center w-10 h-10 rounded-lg hover:bg-sidebar-accent text-sidebar-foreground transition-colors"
          title="Settings"
        >
          <Settings className="h-5 w-5" />
        </Link>
      </aside>

      <AgentConfigPanel
        open={agentConfigOpen}
        onClose={setAgentConfigOpen}
      />
    </>
  );
}
