"use client";

import { useState } from "react";
import { useAgentPrompts, type ResolvedAgentPrompt } from "@/hooks/useAgentConfig";
import {
  AGENT_TYPES,
  AGENT_TYPE_LABELS,
  type AgentType,
} from "@/lib/agent-config/constants";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ChevronDown, ChevronRight, RotateCcw, Save, Loader2 } from "lucide-react";
import { Field } from "@/components/agent-config/Field";

interface AgentPromptsTabProps {
  scope: "global" | "project";
  projectId?: string;
}

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

function sourceLabel(source: ResolvedAgentPrompt["source"]): string {
  if (source === "project") return "This project";
  if (source === "global") return "All projects";
  return "Arij default";
}

function PromptRow({
  prompt,
  scope,
  onSave,
  onReset,
}: {
  prompt: ResolvedAgentPrompt;
  scope: "global" | "project";
  onSave: (agentType: AgentType, text: string) => Promise<boolean>;
  onReset: (agentType: AgentType) => Promise<boolean>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [value, setValue] = useState(prompt.systemPrompt);
  const [saving, setSaving] = useState(false);
  const dirty = value !== prompt.systemPrompt;
  const editorId = `agent-prompt-${prompt.agentType}`;
  const panelId = `${editorId}-panel`;

  const handleSave = async () => {
    setSaving(true);
    await onSave(prompt.agentType, value);
    setSaving(false);
  };

  const handleReset = async () => {
    setSaving(true);
    await onReset(prompt.agentType);
    setSaving(false);
  };

  return (
    <div className="border border-border rounded-lg">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        aria-controls={panelId}
        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-muted/50 transition-colors"
      >
        {expanded ? (
          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
        )}
        <span className="flex-1 font-medium text-sm">
          {AGENT_TYPE_LABELS[prompt.agentType]}
        </span>
        <Badge variant={sourceBadgeVariant(prompt.source)} className="text-xs">
          {sourceLabel(prompt.source)}
        </Badge>
      </button>
      {expanded && (
        <div id={panelId} className="px-4 pb-4 space-y-3">
          <Field
            id={editorId}
            label="Instructions"
            hint={`What the agent should do when it runs this role. The current instructions already work; edit them only to change its behaviour.${
              scope === "project"
                ? " Reset to all projects restores the shared version."
                : ""
            }`}
          >
            <Textarea
              id={editorId}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="Describe how this role should behave"
              className="min-h-32 text-sm font-mono"
            />
          </Field>
          <div className="flex items-center gap-2 justify-end">
            {scope === "project" && prompt.source === "project" && (
              <Button
                variant="outline"
                size="sm"
                onClick={handleReset}
                disabled={saving}
              >
                {saving ? (
                  <Loader2 className="h-3 w-3 animate-spin mr-1" />
                ) : (
                  <RotateCcw className="h-3 w-3 mr-1" />
                )}
                Reset to all projects
              </Button>
            )}
            <Button
              size="sm"
              onClick={handleSave}
              disabled={saving || !dirty}
            >
              {saving ? (
                <Loader2 className="h-3 w-3 animate-spin mr-1" />
              ) : (
                <Save className="h-3 w-3 mr-1" />
              )}
              Save
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

export function AgentPromptsTab({ scope, projectId }: AgentPromptsTabProps) {
  const { data, loading, updatePrompt, resetPrompt } = useAgentPrompts(
    scope,
    projectId
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const promptMap = new Map(data.map((p) => [p.agentType, p]));

  return (
    <ScrollArea className="h-full">
      <div className="space-y-2 p-1">
        {AGENT_TYPES.map((agentType) => {
          const prompt = promptMap.get(agentType) ?? {
            agentType,
            systemPrompt: "",
            source: "builtin" as const,
            scope: "global",
          };
          return (
            <PromptRow
              key={agentType}
              prompt={prompt}
              scope={scope}
              onSave={updatePrompt}
              onReset={resetPrompt}
            />
          );
        })}
      </div>
    </ScrollArea>
  );
}
