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
import { ProviderDefaultsTab } from "./ProviderDefaultsTab";
import { NamedAgentsTab } from "./NamedAgentsTab";
import { Globe, FolderOpen } from "lucide-react";

interface AgentConfigPanelProps {
  projectId?: string;
}

export function AgentConfigPanel({ projectId }: AgentConfigPanelProps) {
  const [scope, setScope] = useState<"global" | "project">(
    projectId ? "project" : "global"
  );

  return (
    <div className="flex flex-col h-full">
      {projectId && (
        <div className="flex items-center gap-1 px-4 pt-3 pb-1">
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
        </div>
      )}

      <Tabs defaultValue="prompts" className="flex-1 flex flex-col min-h-0">
        <TabsList variant="line" className="px-4 shrink-0">
          <TabsTrigger value="prompts">Prompts</TabsTrigger>
          <TabsTrigger value="review">Review Agents</TabsTrigger>
          <TabsTrigger value="agents">Agents</TabsTrigger>
          <TabsTrigger value="providers">Providers</TabsTrigger>
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

        <TabsContent value="agents" className="flex-1 min-h-0 px-3 pb-3">
          <NamedAgentsTab />
        </TabsContent>

        <TabsContent value="providers" className="flex-1 min-h-0 px-3 pb-3">
          <ProviderDefaultsTab
            scope={scope}
            projectId={scope === "project" ? projectId : undefined}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
