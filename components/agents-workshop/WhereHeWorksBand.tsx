"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";

import {
  BandHeader,
  FieldKicker,
  Mono,
  QuietLink,
  SelectPill,
  StrataBand,
  SurfaceCard,
} from "@/components/piscine";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import type {
  NamedAgent,
  ResolvedAgentAssignment,
} from "@/hooks/useAgentConfig";
import {
  AGENT_TYPE_LABELS,
  PROVIDER_LABELS,
  type AgentType,
} from "@/lib/agent-config/constants";
import type { TranslationKey } from "@/lib/i18n/catalogue";

import { sourceLabelKey } from "./agent-initials";

/**
 * WHERE HE WORKS — the turquoise band, and the ONE band on this screen that
 * grows into the leftover column height.
 *
 * The redesign's third change: assignments come back into the agent's own
 * sheet. Before, they lived in a separate tab nobody knew existed.
 *
 * FIVE OF TWENTY-ONE. The grid is a curated view — the five roles a user
 * actually reassigns — so the remaining sixteen must stay reachable: the
 * header carries a link to the full table. Each tile puts the REAL
 * `AGENT_TYPE_LABELS` value in its `title`, so the friendly name never hides
 * which role is being written.
 *
 * A MODULE-SCOPE COPY TABLE, so the kickers are catalogue KEY REFERENCES
 * resolved at render (`lib/i18n/catalogue.ts`, pattern 3).
 */
const TILES: { kickerKey: TranslationKey; agentType: AgentType }[] = [
  { kickerKey: "AgentsWorkshop.whereHeWorks.tiles.build", agentType: "build" },
  // Story-scoped code work — also what the pipeline's fix stage dispatches at
  // story scope, which is what makes "bug fix" the honest user-facing name.
  {
    kickerKey: "AgentsWorkshop.whereHeWorks.tiles.bugFix",
    agentType: "ticket_build",
  },
  {
    kickerKey: "AgentsWorkshop.whereHeWorks.tiles.review",
    agentType: "review_code",
  },
  {
    kickerKey: "AgentsWorkshop.whereHeWorks.tiles.mergeFix",
    agentType: "merge",
  },
  // spec_generation is reachable on /agents/assignments.
  { kickerKey: "AgentsWorkshop.whereHeWorks.tiles.chatAndSpec", agentType: "chat" },
];

export interface WhereHeWorksBandProps {
  assignments: ResolvedAgentAssignment[];
  namedAgents: NamedAgent[];
  selectedAgentId: string | null;
  scope: "global" | "project";
  onAssign: (
    agentType: AgentType,
    namedAgentId: string | null,
  ) => Promise<{ ok: boolean; error?: string }>;
}

export function WhereHeWorksBand({
  assignments,
  namedAgents,
  selectedAgentId,
  scope,
  onAssign,
}: WhereHeWorksBandProps) {
  const t = useTranslations("AgentsWorkshop");
  // The second, namespace-less translator resolves the KEY REFERENCES the
  // module-scope tables above and in `agent-initials.ts` hold.
  const tKey = useTranslations();
  const [savingRole, setSavingRole] = useState<AgentType | null>(null);
  // A per-role map, never one shared string: one failing assignment must not
  // blank the message of another.
  const [errors, setErrors] = useState<Partial<Record<AgentType, string>>>({});

  const byRole = new Map(
    assignments.map((assignment) => [assignment.agentType, assignment]),
  );

  async function updateAssignment(
    agentType: AgentType,
    namedAgentId: string | null,
  ) {
    setSavingRole(agentType);
    setErrors((current) => ({ ...current, [agentType]: undefined }));
    try {
      const result = await onAssign(agentType, namedAgentId);
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

  const clearLabel =
    scope === "project"
      ? t("assignments.clearToGlobal")
      : t("assignments.clearToDefault");

  return (
    <StrataBand stratum="live" density="full" gap={10} grow>
      <BandHeader
        stratum="live"
        labelSize={12}
        label={t("whereHeWorks.label")}
        meta={t("whereHeWorks.meta")}
        right={
          <QuietLink href="/agents/assignments" tone="live" size={12}>
            {t("whereHeWorks.allRoles")}
          </QuietLink>
        }
      />

      <div className="min-h-0 overflow-y-auto">
        {/* Five role tiles need ~800px; a phone gets one column, a tablet
            two, and the frame's row of five returns at `xl`. */}
        <div className="grid grid-cols-1 gap-[10px] sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
          {TILES.map(({ kickerKey, agentType }) => {
            const assignment = byRole.get(agentType);
            const owned =
              !!selectedAgentId && assignment?.namedAgentId === selectedAgentId;
            const label =
              assignment?.namedAgent?.name ?? tKey(sourceLabelKey("builtin"));
            const error = errors[agentType];

            return (
              // The wrapper carries the title: `SurfaceCard` takes no
              // pass-through DOM props, and the real role name must stay
              // discoverable behind the friendly kicker.
              <div key={agentType} title={AGENT_TYPE_LABELS[agentType]}>
              <SurfaceCard
                radius={11}
                selected={owned}
                className="flex h-full flex-col gap-[6px] px-3 py-[11px]"
              >
                <FieldKicker stratum="live" size={10}>
                  {tKey(kickerKey)}
                </FieldKicker>

                {owned ? (
                  <span className="truncate font-sans text-[13px] font-semibold text-foreground">
                    {label}
                  </span>
                ) : (
                  <SelectPill
                    tone="ink"
                    fill="transparent"
                    disabled={
                      namedAgents.length === 0 || savingRole === agentType
                    }
                    label={label}
                    className="h-auto px-0"
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
                )}

                {/* The provenance line, but never a stutter: with no named
                    agent, line 2 already reads "Arij default" and repeating it
                    underneath says nothing. Collapse instead. */}
                {owned ? (
                  <Mono size={10} tone="muted" clamp={1}>
                    {t("whereHeWorks.thisAgent")}
                  </Mono>
                ) : assignment?.namedAgent ? (
                  <Mono size={10} tone="muted" clamp={1}>
                    {tKey(sourceLabelKey(assignment.source))}
                  </Mono>
                ) : null}

                {error ? (
                  <p
                    role="alert"
                    className="font-sans text-[11px] text-destructive"
                  >
                    {error}
                  </p>
                ) : null}
              </SurfaceCard>
              </div>
            );
          })}
        </div>

        {namedAgents.length === 0 ? (
          <p className="pt-[10px] font-sans text-[11.5px] text-strata-live-mid">
            {t("assignments.createFirst")}
          </p>
        ) : null}
      </div>

      <span className="font-sans text-[11.5px] text-strata-live-mid">
        {t("whereHeWorks.footnote")}
      </span>
    </StrataBand>
  );
}
