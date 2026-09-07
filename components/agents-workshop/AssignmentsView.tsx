"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Loader2 } from "lucide-react";

import { ScopeSwitcher } from "@/components/agents-workshop/ScopeSwitcher";
import { sourceLabelKey } from "@/components/agents-workshop/agent-initials";
import {
  BandHeader,
  Mono,
  SelectPill,
  SurfaceCard,
} from "@/components/piscine";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { useAgentAssignments, useNamedAgents } from "@/hooks/useAgentConfig";
import {
  AGENT_TYPES,
  AGENT_TYPE_LABELS,
  PROVIDER_LABELS,
  type AgentType,
} from "@/lib/agent-config/constants";

/**
 * The full 21-role assignment table.
 *
 * WHERE HE WORKS on /agents shows five curated roles; every other role lives
 * here, which is what keeps that curation honest rather than lossy.
 *
 * `listGlobalAgentProviders` always returns one row per AGENT_TYPES member, so
 * a role with no override still renders — reading "Arij default" rather than
 * an empty row.
 */
function PageLoading() {
  return (
    <div className="flex flex-1 items-center justify-center">
      <Loader2 className="h-5 w-5 animate-spin text-muted-foreground motion-reduce:animate-none" />
    </div>
  );
}

export function AssignmentsView({ projectId }: { projectId?: string }) {
  const t = useTranslations("AgentsWorkshop");
  // Namespace-less, for the KEY REFERENCES `agent-initials.ts` holds.
  const tKey = useTranslations();
  const [scope, setScope] = useState<"global" | "project">(
    projectId ? "project" : "global",
  );
  const scopedProjectId = scope === "project" ? projectId : undefined;

  const { data, loading, assignAgent } = useAgentAssignments(
    scope,
    scopedProjectId,
  );
  const { data: namedAgents, loading: agentsLoading } = useNamedAgents();

  const [savingRole, setSavingRole] = useState<AgentType | null>(null);
  // Per role, never one shared string: one failure must not blank the others.
  const [errors, setErrors] = useState<Partial<Record<AgentType, string>>>({});

  const byRole = new Map(data.map((entry) => [entry.agentType, entry]));

  async function updateAssignment(
    agentType: AgentType,
    namedAgentId: string | null,
  ) {
    setSavingRole(agentType);
    setErrors((current) => ({ ...current, [agentType]: undefined }));
    try {
      const result = await assignAgent(agentType, namedAgentId);
      if (!result.ok) {
        setErrors((current) => ({
          ...current,
          [agentType]: result.error || t("assignments.updateFailed"),
        }));
      }
    } catch {
      setErrors((current) => ({
        ...current,
        [agentType]: t("assignments.updateFailedRetry"),
      }));
    } finally {
      setSavingRole(null);
    }
  }

  if (loading || agentsLoading) return <PageLoading />;

  const clearLabel =
    scope === "project"
      ? t("assignments.clearToGlobal")
      : t("assignments.clearToDefault");

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-[14px] pb-[14px]">
      <BandHeader
        stratum="neutral"
        labelSize={12}
        standalone
        label={t("assignments.label")}
      />
      <p className="font-sans text-[12.5px] text-muted-foreground">
        {t("assignments.intro")}
      </p>

      <ScopeSwitcher
        projectId={projectId}
        scope={scope}
        onScopeChange={setScope}
      />

      {namedAgents.length === 0 ? (
        <p className="font-sans text-[12.5px] text-muted-foreground">
          {t("assignments.createFirst")}
        </p>
      ) : null}

      <div className="flex flex-col gap-2">
        {AGENT_TYPES.map((agentType) => {
          const assignment = byRole.get(agentType);
          const label =
            assignment?.namedAgent?.name ?? tKey(sourceLabelKey("builtin"));
          const error = errors[agentType];

          return (
            <SurfaceCard
              key={agentType}
              radius={12}
              className="flex flex-col gap-1 px-4 py-3"
            >
              <div className="flex items-center gap-3">
                <span className="min-w-0 flex-1 truncate font-sans text-[13.5px] font-semibold text-foreground">
                  {AGENT_TYPE_LABELS[agentType]}
                </span>
                {/* Provenance only when there is an agent to have provenance:
                    on a default row the pill already says "Arij default", and
                    saying it twice on one line says nothing. */}
                {assignment?.namedAgent ? (
                  <Mono size={10} tone="muted">
                    {tKey(sourceLabelKey(assignment.source))}
                  </Mono>
                ) : null}
                <SelectPill
                  tone="ink"
                  fill="transparent"
                  label={label}
                  disabled={
                    namedAgents.length === 0 || savingRole === agentType
                  }
                >
                  <DropdownMenuItem
                    onSelect={() => updateAssignment(agentType, null)}
                  >
                    {clearLabel}
                  </DropdownMenuItem>
                  {namedAgents.map((agent) => (
                    <DropdownMenuItem
                      key={agent.id}
                      onSelect={() => updateAssignment(agentType, agent.id)}
                    >
                      <span className="flex flex-col items-start">
                        <span>{agent.name}</span>
                        <span className="text-xs text-muted-foreground">
                          {t("assignments.agentMeta", {
                            provider: PROVIDER_LABELS[agent.provider],
                            model: agent.model || t("common.cliDefaultModel"),
                          })}
                        </span>
                      </span>
                    </DropdownMenuItem>
                  ))}
                </SelectPill>
              </div>
              {error ? (
                <p
                  role="alert"
                  className="font-sans text-[12px] text-destructive"
                >
                  {error}
                </p>
              ) : null}
            </SurfaceCard>
          );
        })}
      </div>
    </div>
  );
}
