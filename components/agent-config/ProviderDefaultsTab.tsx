"use client";

import { useAgentProviders } from "@/hooks/useAgentConfig";
import {
  AGENT_TYPES,
  AGENT_TYPE_LABELS,
  PROVIDER_OPTIONS,
  type AgentType,
  type AgentProvider,
} from "@/lib/agent-config/constants";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Loader2 } from "lucide-react";

interface ProviderDefaultsTabProps {
  scope: "global" | "project";
  projectId?: string;
}

const PROVIDER_LABELS: Record<AgentProvider, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
};

function sourceBadgeVariant(source: string) {
  switch (source) {
    case "project":
      return "default" as const;
    case "global":
      return "secondary" as const;
    default:
      return "outline" as const;
  }
}

export function ProviderDefaultsTab({
  scope,
  projectId,
}: ProviderDefaultsTabProps) {
  const { data, loading, updateProvider } = useAgentProviders(scope, projectId);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const providerMap = new Map(data.map((p) => [p.agentType, p]));

  return (
    <ScrollArea className="h-full">
      <div className="space-y-2 p-1">
        {AGENT_TYPES.map((agentType) => {
          const entry = providerMap.get(agentType);
          const currentProvider = entry?.provider ?? "claude-code";
          const source = entry?.source ?? "builtin";

          return (
            <div
              key={agentType}
              className="flex items-center gap-3 px-4 py-3 rounded-lg border border-border"
            >
              <span className="flex-1 text-sm font-medium">
                {AGENT_TYPE_LABELS[agentType as AgentType]}
              </span>
              <Badge
                variant={sourceBadgeVariant(source)}
                className="text-xs shrink-0"
              >
                {source}
              </Badge>
              <Select
                value={currentProvider}
                onValueChange={(value) =>
                  updateProvider(agentType, value as AgentProvider)
                }
              >
                <SelectTrigger size="sm" className="w-36">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PROVIDER_OPTIONS.map((provider) => (
                    <SelectItem key={provider} value={provider}>
                      {PROVIDER_LABELS[provider]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          );
        })}
      </div>
    </ScrollArea>
  );
}
