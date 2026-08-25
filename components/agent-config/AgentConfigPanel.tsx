"use client";

import { useState } from "react";
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { AgentPromptsTab } from "./AgentPromptsTab";
import { ReviewAgentsTab } from "./ReviewAgentsTab";
import { RuntimeSettingsTab } from "./RuntimeSettingsTab";
import { NamedAgentsTab } from "./NamedAgentsTab";
import { StatsTab } from "./StatsTab";
import { TaskAssignmentsTab } from "./TaskAssignmentsTab";
import { Globe, FolderOpen, ChevronDown, ChevronRight } from "lucide-react";

interface AgentConfigPanelProps {
  projectId?: string;
}

/**
 * Two clearly separated sections:
 *
 *  - Core (the default view): the named-agents list. This is the only part a
 *    new user needs — a name and a CLI make a working agent.
 *  - Advanced (collapsed by default): role prompts, review agents, per-role
 *    assignments, runtime settings and usage stats. The Global/Project scope
 *    switcher lives here because it only affects these scoped settings, not
 *    the agents list.
 */
export function AgentConfigPanel({ projectId }: AgentConfigPanelProps) {
  const [scope, setScope] = useState<"global" | "project">(
    projectId ? "project" : "global"
  );
  const [advancedOpen, setAdvancedOpen] = useState(false);

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Core — the default view, fits one screen. */}
      {!advancedOpen && (
        <div className="flex-1 min-h-0 flex flex-col">
          <NamedAgentsTab />
        </div>
      )}

      {/* Advanced — collapsed by default, expanded explicitly. */}
      <div className="shrink-0 border-t border-border">
        <button
          type="button"
          onClick={() => setAdvancedOpen((open) => !open)}
          aria-expanded={advancedOpen}
          aria-controls="advanced-agent-settings"
          data-testid="advanced-settings-toggle"
          className="flex w-full items-center gap-1.5 px-4 py-2.5 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
        >
          {advancedOpen ? (
            <ChevronDown className="h-4 w-4 shrink-0" />
          ) : (
            <ChevronRight className="h-4 w-4 shrink-0" />
          )}
          Advanced settings
          {!advancedOpen && (
            <span className="text-xs font-normal text-muted-foreground/70">
              instructions, review agents, assignments, runtime limits, usage
            </span>
          )}
        </button>
      </div>

      {advancedOpen && (
        <div
          id="advanced-agent-settings"
          className="flex-1 min-h-0 flex flex-col"
        >
          {projectId && (
            <div className="flex items-center gap-1 px-4 pt-2 pb-1 shrink-0">
              <Button
                variant={scope === "global" ? "secondary" : "ghost"}
                size="sm"
                onClick={() => setScope("global")}
                className="gap-1.5"
              >
                <Globe className="h-3.5 w-3.5" />
                Global
              </Button>
              <Button
                variant={scope === "project" ? "secondary" : "ghost"}
                size="sm"
                onClick={() => setScope("project")}
                className="gap-1.5"
              >
                <FolderOpen className="h-3.5 w-3.5" />
                Project
              </Button>
              <span className="text-xs text-muted-foreground ml-1">
                apply to the settings below
              </span>
            </div>
          )}

          <Tabs defaultValue="prompts" className="flex-1 flex flex-col min-h-0">
            <TabsList variant="line" className="px-4 shrink-0">
              <TabsTrigger value="prompts">Instructions</TabsTrigger>
              <TabsTrigger value="review">Review Agents</TabsTrigger>
              <TabsTrigger value="assignments">Assignments</TabsTrigger>
              <TabsTrigger value="runtime">Runtime</TabsTrigger>
              <TabsTrigger value="stats">Stats</TabsTrigger>
            </TabsList>

            <TabsContent value="prompts" className="flex-1 min-h-0 px-3 pb-3">
              <AgentPromptsTab
                scope={scope}
                projectId={scope === "project" ? projectId : undefined}
              />
            </TabsContent>

            <TabsContent value="review" className="flex-1 min-h-0 px-3 pb-3">
              <ReviewAgentsTab
                scope={scope}
                projectId={scope === "project" ? projectId : undefined}
              />
            </TabsContent>

            <TabsContent
              value="assignments"
              className="flex-1 min-h-0 px-3 pb-3"
            >
              <TaskAssignmentsTab
                scope={scope}
                projectId={scope === "project" ? projectId : undefined}
              />
            </TabsContent>

            <TabsContent value="runtime" className="flex-1 min-h-0 px-3 pb-3">
              <RuntimeSettingsTab
                scope={scope}
                projectId={scope === "project" ? projectId : undefined}
              />
            </TabsContent>

            <TabsContent value="stats" className="flex-1 min-h-0 px-3 pb-3">
              <StatsTab
                scope={scope}
                projectId={scope === "project" ? projectId : undefined}
              />
            </TabsContent>
          </Tabs>
        </div>
      )}
    </div>
  );
}
