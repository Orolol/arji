"use client";

import { useState } from "react";
import {
  useAgentAssignments,
  useNamedAgents,
} from "@/hooks/useAgentConfig";
import {
  AGENT_TYPES,
  AGENT_TYPE_LABELS,
  PROVIDER_LABELS,
  type AgentType,
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

interface TaskAssignmentsTabProps {
  scope: "global" | "project";
  projectId?: string;
}

const DEFAULT_VALUE = "__default__";

function sourceLabel(source: "builtin" | "global" | "project"): string {
  if (source === "project") return "This project";
  if (source === "global") return "All projects";
  return "Arij default";
}

export function TaskAssignmentsTab({
  scope,
  projectId,
}: TaskAssignmentsTabProps) {
  const { data, loading, assignAgent } = useAgentAssignments(scope, projectId);
  const { data: namedAgents, loading: agentsLoading } = useNamedAgents();
  const [savingRole, setSavingRole] = useState<AgentType | null>(null);
  const [errors, setErrors] = useState<Partial<Record<AgentType, string>>>({});

  const assignmentByRole = new Map(data.map((entry) => [entry.agentType, entry]));
  const busy = loading || agentsLoading;

  async function updateAssignment(agentType: AgentType, value: string) {
    setSavingRole(agentType);
    setErrors((current) => ({ ...current, [agentType]: undefined }));
    try {
      const result = await assignAgent(
        agentType,
        value === DEFAULT_VALUE ? null : value
      );
      if (!result.ok) {
        setErrors((current) => ({
          ...current,
          [agentType]: result.error || "Could not update this assignment.",
        }));
      }
    } catch {
      setErrors((current) => ({
        ...current,
        [agentType]: "Could not update this assignment. Try again.",
      }));
    } finally {
      setSavingRole(null);
    }
  }

  if (busy) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <ScrollArea className="h-full">
      <div className="space-y-3 p-1">
        <div>
          <h3 className="text-sm font-medium">Task assignments</h3>
          <p className="text-xs text-muted-foreground">
            Choose which named agent Arij should use automatically for each
            task. Leave a role on its default unless it needs a specialist.
          </p>
        </div>

        {namedAgents.length === 0 && (
          <p className="rounded-lg border border-border px-4 py-3 text-sm text-muted-foreground">
            Create an agent in Basic settings before assigning specialists to
            tasks.
          </p>
        )}

        {AGENT_TYPES.map((agentType) => {
          const assignment = assignmentByRole.get(agentType);
          const selectId = `task-assignment-${agentType}`;
          const currentValue = assignment?.namedAgentId || DEFAULT_VALUE;

          return (
            <div
              key={agentType}
              className="space-y-2 rounded-lg border border-border px-4 py-3"
            >
              <div className="grid grid-cols-1 items-center gap-2 md:grid-cols-[minmax(0,1fr)_auto_minmax(220px,280px)]">
                <div>
                  <label htmlFor={selectId} className="text-sm font-medium">
                    {AGENT_TYPE_LABELS[agentType]}
                  </label>
                  <p className="text-xs text-muted-foreground">
                    Change this only when the task should always use a specific
                    agent.
                  </p>
                </div>
                <Badge variant="outline" className="w-fit text-xs">
                  {sourceLabel(assignment?.source ?? "builtin")}
                </Badge>
                <Select
                  value={currentValue}
                  onValueChange={(value) => updateAssignment(agentType, value)}
                  disabled={savingRole === agentType || namedAgents.length === 0}
                >
                  <SelectTrigger id={selectId} className="w-full" size="sm">
                    {savingRole === agentType ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <SelectValue />
                    )}
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={DEFAULT_VALUE}>
                      {scope === "project"
                        ? "Use the all-projects assignment"
                        : "Use the Arij default"}
                    </SelectItem>
                    {namedAgents.map((agent) => (
                      <SelectItem key={agent.id} value={agent.id}>
                        <span className="flex flex-col items-start">
                          <span>{agent.name}</span>
                          <span className="text-xs text-muted-foreground">
                            {PROVIDER_LABELS[agent.provider]}
                            {agent.model
                              ? ` · ${agent.model}`
                              : " · CLI default model"}
                          </span>
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {errors[agentType] && (
                <p role="alert" className="text-xs text-destructive">
                  {errors[agentType]}
                </p>
              )}
            </div>
          );
        })}
      </div>
    </ScrollArea>
  );
}
