"use client";

import { useCallback, useState } from "react";
import { Loader2 } from "lucide-react";

import { AgentIdentityCard } from "@/components/agents-workshop/AgentIdentityCard";
import { AgentRoster } from "@/components/agents-workshop/AgentRoster";
import { CliOptionsBand } from "@/components/agents-workshop/CliOptionsBand";
import { EditorFooterBar } from "@/components/agents-workshop/EditorFooterBar";
import { PersonaBand } from "@/components/agents-workshop/PersonaBand";
import { TheNumbersBand } from "@/components/agents-workshop/TheNumbersBand";
import { WhereHeWorksBand } from "@/components/agents-workshop/WhereHeWorksBand";
import { resetOptionsForProvider } from "@/components/agents-workshop/cli-options";
import {
  useAgentAssignments,
  useAgentRosterStats,
  useNamedAgentStats,
  useNamedAgents,
  type NamedAgent,
} from "@/hooks/useAgentConfig";
import { useProvidersAvailable } from "@/hooks/useProvidersAvailable";
import type { AgentProvider } from "@/lib/agent-config/constants";
import type { NamedAgentCliOptions } from "@/lib/providers/options-registry";

/**
 * The agents workshop (frame 7a) — a full page where a 480px side sheet used
 * to be.
 *
 * DRAFTS ARE PER AGENT, NOT PER EDITOR. The sheet gave every agent its own
 * inline form, so unsaved edits survived scrolling past another agent for
 * free. One shared editor column would throw them away on every roster click,
 * which is a regression a rewrite makes without noticing — so edits are kept
 * in a map keyed by agent id, seeded from the server record the first time an
 * agent is touched, and the roster marks a dirty agent with an UNSAVED word.
 *
 * SELECTION IS DERIVED, NOT SYNCED. Falling back to the first agent when the
 * stored id no longer resolves means no effect has to chase `data`, which also
 * keeps `react-hooks/set-state-in-effect` quiet without a suppression.
 */
interface Draft {
  name: string;
  provider: AgentProvider;
  model: string;
  options: NamedAgentCliOptions;
  personaPrompt: string;
  escalatesTo: string | null;
}

function draftFrom(agent: NamedAgent): Draft {
  return {
    name: agent.name,
    provider: agent.provider,
    model: agent.model,
    // `?? {}` covers a legacy row whose options were never written.
    options: agent.options ?? {},
    personaPrompt: agent.personaPrompt ?? "",
    escalatesTo: agent.escalatesTo,
  };
}

function isDirty(draft: Draft, agent: NamedAgent): boolean {
  return (
    draft.name !== agent.name ||
    draft.provider !== agent.provider ||
    draft.model !== agent.model ||
    JSON.stringify(draft.options) !== JSON.stringify(agent.options ?? {}) ||
    draft.personaPrompt !== (agent.personaPrompt ?? "") ||
    draft.escalatesTo !== agent.escalatesTo
  );
}

function WorkshopLoading() {
  return (
    <div className="flex flex-1 items-center justify-center">
      <Loader2 className="h-5 w-5 animate-spin text-muted-foreground motion-reduce:animate-none" />
    </div>
  );
}

/**
 * `projectId` arrives as a prop from the server page's `searchParams`, not from
 * a client hook. /agents is a global page; `?project=` keeps the
 * project-scoped overrides the sheet used to offer reachable, and there is
 * deliberately no picker.
 */
export function AgentsWorkshopView({ projectId }: { projectId?: string }) {
  const scope: "global" | "project" = projectId ? "project" : "global";

  const {
    data: agents,
    loading,
    createNamedAgent,
    updateNamedAgent,
    deleteNamedAgent,
  } = useNamedAgents();
  const { providers: availability, loading: availabilityLoading } =
    useProvidersAvailable();
  const { data: rosterStats, status: rosterStatsStatus } =
    useAgentRosterStats();
  const {
    data: assignments,
    assignAgent,
  } = useAgentAssignments(scope, projectId);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const activeId =
    selectedId && agents.some((agent) => agent.id === selectedId)
      ? selectedId
      : (agents[0]?.id ?? null);
  const agent = agents.find((candidate) => candidate.id === activeId) ?? null;
  const draft = agent ? (drafts[agent.id] ?? draftFrom(agent)) : null;

  const { data: stats } = useNamedAgentStats(activeId);

  const dirtyIds = new Set(
    agents
      .filter((candidate) => {
        const candidateDraft = drafts[candidate.id];
        return candidateDraft ? isDirty(candidateDraft, candidate) : false;
      })
      .map((candidate) => candidate.id),
  );

  const dirty = !!agent && !!draft && isDirty(draft, agent);
  const busy = saving || deleting;

  const patchDraft = useCallback(
    (agentId: string, base: Draft, patch: Partial<Draft>) => {
      setDrafts((current) => ({
        ...current,
        [agentId]: { ...(current[agentId] ?? base), ...patch },
      }));
    },
    [],
  );

  function handleSelect(agentId: string) {
    setSelectedId(agentId);
    setError(null);
  }

  function handleProviderChange(next: AgentProvider) {
    if (!agent || !draft) return;
    // Options are per-CLI: anything the new CLI does not declare goes back to
    // its default rather than lingering as a ghost value the editor can no
    // longer show. And a cross-provider escalation edge is rejected by the
    // server, so leaving one behind makes the agent permanently unsaveable
    // over a field the user never touched.
    const escalatesTo =
      draft.escalatesTo &&
      agents.find((candidate) => candidate.id === draft.escalatesTo)
        ?.provider !== next
        ? null
        : draft.escalatesTo;
    patchDraft(agent.id, draft, {
      provider: next,
      options: resetOptionsForProvider(next, draft.options),
      escalatesTo,
    });
  }

  async function handleSave() {
    if (!agent || !draft || !dirty || !draft.name.trim()) return;
    setError(null);
    setSaving(true);
    try {
      const result = await updateNamedAgent(agent.id, {
        name: draft.name.trim(),
        provider: draft.provider,
        model: draft.model.trim(),
        options: draft.options,
        personaPrompt: draft.personaPrompt,
        escalatesTo: draft.escalatesTo,
      });
      if (result.ok) {
        // The hook has already reloaded the roster, so dropping the draft is
        // how the fields stop showing text the server did not store — the
        // trimmed name and model come straight back from the record.
        setDrafts((current) => {
          const next = { ...current };
          delete next[agent.id];
          return next;
        });
      } else {
        // A 409 here is a duplicate name the user needs to read verbatim.
        setError(result.error || "Could not save this agent. Try again.");
      }
    } catch {
      setError("Could not save this agent. Check the connection and try again.");
    } finally {
      setSaving(false);
    }
  }

  function handleDiscard() {
    if (!agent) return;
    setError(null);
    setDrafts((current) => {
      const next = { ...current };
      delete next[agent.id];
      return next;
    });
  }

  async function handleDelete() {
    if (!agent) return;
    const index = agents.findIndex((candidate) => candidate.id === agent.id);
    const neighbour = agents[index + 1] ?? agents[index - 1] ?? null;

    setError(null);
    setDeleting(true);
    try {
      const deleted = await deleteNamedAgent(agent.id);
      if (deleted) {
        setDrafts((current) => {
          const next = { ...current };
          delete next[agent.id];
          return next;
        });
        setSelectedId(neighbour?.id ?? null);
      } else {
        setError("Could not delete this agent. Try again.");
      }
    } catch {
      setError(
        "Could not delete this agent. Check the connection and try again.",
      );
    } finally {
      setDeleting(false);
    }
  }

  if (loading) return <WorkshopLoading />;

  return (
    <div className="flex min-h-0 flex-1 gap-3 px-[14px] pb-[14px]">
      <AgentRoster
        agents={agents}
        selectedId={activeId}
        dirtyIds={dirtyIds}
        stats={rosterStats}
        statsStatus={rosterStatsStatus}
        availability={availability}
        availabilityLoading={availabilityLoading}
        onSelect={handleSelect}
        onCreate={createNamedAgent}
      />

      {agent && draft ? (
        <div className="flex min-w-0 flex-1 flex-col gap-[10px] overflow-y-auto">
          <AgentIdentityCard
            // Remount per agent: the "stronger model chosen but not yet
            // targeted" state belongs to one agent's editing session.
            key={agent.id}
            agentId={agent.id}
            agents={agents}
            name={draft.name}
            provider={draft.provider}
            model={draft.model}
            escalatesTo={draft.escalatesTo}
            availability={availability}
            availabilityLoading={availabilityLoading}
            disabled={busy}
            onNameChange={(value) => patchDraft(agent.id, draft, { name: value })}
            onProviderChange={handleProviderChange}
            onModelChange={(value) =>
              patchDraft(agent.id, draft, { model: value })
            }
            onEscalatesToChange={(value) =>
              patchDraft(agent.id, draft, { escalatesTo: value })
            }
          />

          <TheNumbersBand stats={stats} />

          <PersonaBand
            value={draft.personaPrompt}
            onChange={(value) =>
              patchDraft(agent.id, draft, { personaPrompt: value })
            }
            disabled={busy}
          />

          <CliOptionsBand
            provider={draft.provider}
            options={draft.options}
            onChange={(options) => patchDraft(agent.id, draft, { options })}
            disabled={busy}
          />

          <WhereHeWorksBand
            assignments={assignments}
            namedAgents={agents}
            selectedAgentId={agent.id}
            scope={scope}
            onAssign={assignAgent}
          />

          <EditorFooterBar
            agentName={agent.name}
            createdAt={agent.createdAt}
            dirty={dirty}
            saving={saving}
            deleting={deleting}
            canSave={dirty && !!draft.name.trim() && !saving}
            error={error}
            onSave={handleSave}
            onDiscard={handleDiscard}
            onDelete={handleDelete}
          />
        </div>
      ) : (
        // Five empty bands would be noise; one line is the whole state.
        <div className="flex min-w-0 flex-1 items-center justify-center">
          <p className="font-sans text-[13.5px] text-muted-foreground">
            No agents yet — create your first one on the left.
          </p>
        </div>
      )}
    </div>
  );
}
