"use client";

import { useState } from "react";
import { useNamedAgents, type NamedAgent } from "@/hooks/useAgentConfig";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2, Plus, Trash2 } from "lucide-react";
import {
  PROVIDER_OPTIONS,
  PROVIDER_LABELS,
  type AgentProvider,
} from "@/lib/agent-config/constants";
import { Field } from "@/components/agent-config/Field";
import {
  CliOptionsFields,
  resetOptionsForProvider,
} from "@/components/agent-config/CliOptionsFields";
import {
  DEFAULT_PERSONA_PROMPT,
  PERSONA_PROMPT_MAX_CHARS,
} from "@/lib/agent-config/constants";
import type { NamedAgentCliOptions } from "@/lib/providers/options-registry";
import {
  useProvidersAvailable,
  type ProvidersAvailability,
} from "@/hooks/useProvidersAvailable";

function CliSelect({
  id,
  value,
  onChange,
  availability,
  availabilityLoading,
  disabled,
}: {
  id: string;
  value: AgentProvider;
  onChange: (value: AgentProvider) => void;
  availability: ProvidersAvailability["providers"];
  availabilityLoading: boolean;
  disabled?: boolean;
}) {
  return (
    <Select
      value={value}
      onValueChange={(v) => onChange(v as AgentProvider)}
      disabled={disabled}
    >
      <SelectTrigger id={id} className="h-8 text-sm">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {PROVIDER_OPTIONS.map((p) => (
          <SelectItem key={p} value={p}>
            <span className="flex items-center gap-1.5">
              <span
                aria-hidden="true"
                className={`inline-block size-1.5 shrink-0 rounded-full ${
                  availabilityLoading
                    ? "bg-muted-foreground/40"
                    : availability[p]
                      ? "bg-green-500"
                      : "bg-red-500"
                }`}
              />
              {PROVIDER_LABELS[p]}
              <span className="sr-only">
                {availabilityLoading
                  ? " — checking availability"
                  : availability[p]
                    ? " — ready to use"
                    : " — not detected"}
              </span>
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function NamedAgentRow({
  agent,
  agents,
  availability,
  availabilityLoading,
  onUpdate,
  onDelete,
}: {
  agent: NamedAgent;
  agents: NamedAgent[];
  availability: ProvidersAvailability["providers"];
  availabilityLoading: boolean;
  onUpdate: (
    agentId: string,
    payload: {
      name?: string;
      provider?: AgentProvider;
      model?: string;
      options?: NamedAgentCliOptions;
      personaPrompt?: string | null;
      escalatesTo?: string | null;
    }
  ) => Promise<{ ok: boolean; error?: string }>;
  onDelete: (agentId: string) => Promise<boolean>;
}) {
  const [name, setName] = useState(agent.name);
  const [provider, setProvider] = useState<AgentProvider>(agent.provider);
  const [model, setModel] = useState(agent.model);
  const [options, setOptions] = useState<NamedAgentCliOptions>(
    agent.options ?? {}
  );
  const [personaPrompt, setPersonaPrompt] = useState(
    agent.personaPrompt ?? ""
  );
  const [escalatesTo, setEscalatesTo] = useState(agent.escalatesTo);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dirty =
    name !== agent.name ||
    provider !== agent.provider ||
    model !== agent.model ||
    JSON.stringify(options) !== JSON.stringify(agent.options ?? {}) ||
    personaPrompt !== (agent.personaPrompt ?? "") ||
    escalatesTo !== agent.escalatesTo;

  async function handleSave() {
    if (!dirty || !name.trim()) return;
    const nextName = name.trim();
    const nextModel = model.trim();
    setError(null);
    setSaving(true);
    try {
      const result = await onUpdate(agent.id, {
        name: nextName,
        provider,
        model: nextModel,
        options,
        personaPrompt,
        escalatesTo,
      });
      if (result.ok) {
        setName(nextName);
        setModel(nextModel);
      } else {
        setError(result.error || "Could not save this agent. Try again.");
      }
    } catch {
      setError(
        "Could not save this agent. Check the connection and try again."
      );
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    setError(null);
    setDeleting(true);
    try {
      const deleted = await onDelete(agent.id);
      if (!deleted) setError("Could not delete this agent. Try again.");
    } catch {
      setError(
        "Could not delete this agent. Check the connection and try again."
      );
    } finally {
      setDeleting(false);
    }
  }

  const availabilityHint = availabilityLoading
    ? `Checking whether ${PROVIDER_LABELS[provider]} is ready on this machine.`
    : availability[provider]
      ? `${PROVIDER_LABELS[provider]} is ready to use on this machine.`
      : `${PROVIDER_LABELS[provider]} was not detected. Install or sign in to the CLI before running this agent.`;

  return (
    <div className="rounded-lg border border-border p-3 space-y-3">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div className="md:col-span-2">
          <Field
            id={`named-agent-name-${agent.id}`}
            label="Name"
            hint="How you recognise this agent in menus and lists."
          >
            <Input
              id={`named-agent-name-${agent.id}`}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Agent name"
              className="h-8 text-sm"
            />
          </Field>
        </div>
        <Field
          id={`named-agent-cli-${agent.id}`}
          label="CLI"
          hint={availabilityHint}
        >
          <CliSelect
            id={`named-agent-cli-${agent.id}`}
            value={provider}
            onChange={(nextProvider) => {
              setProvider(nextProvider);
              // Options are per-CLI: anything the new CLI does not declare
              // goes back to its default rather than lingering as a ghost
              // value the editor can no longer show.
              setOptions((current) =>
                resetOptionsForProvider(nextProvider, current)
              );
              if (
                escalatesTo &&
                agents.find((candidate) => candidate.id === escalatesTo)
                  ?.provider !== nextProvider
              ) {
                setEscalatesTo(null);
              }
            }}
            availability={availability}
            availabilityLoading={availabilityLoading}
            disabled={saving || deleting}
          />
        </Field>
        <Field
          id={`named-agent-model-${agent.id}`}
          label="Model"
          hint="Optional — leave empty to use the CLI's own default model."
        >
          <Input
            id={`named-agent-model-${agent.id}`}
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="CLI default"
            className="h-8 text-sm"
          />
        </Field>
        <div className="md:col-span-2">
          <Field
            id={`named-agent-escalation-${agent.id}`}
            label="Retry escalation"
            hint="Optional — uses attempt 3 for one stronger model; a different CLI then needs attempt 4. The default per-stage budget is 2."
          >
            <Select
              value={escalatesTo ?? "none"}
              onValueChange={(value) =>
                setEscalatesTo(value === "none" ? null : value)
              }
              disabled={saving || deleting}
            >
              <SelectTrigger
                id={`named-agent-escalation-${agent.id}`}
                className="h-8 text-sm"
              >
                <SelectValue placeholder="No model escalation" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No model escalation</SelectItem>
                {agents
                  .filter(
                    (candidate) =>
                      candidate.id !== agent.id &&
                      candidate.provider === provider
                  )
                  .map((candidate) => (
                    <SelectItem key={candidate.id} value={candidate.id}>
                      {candidate.name}
                      {candidate.model ? ` — ${candidate.model}` : " — CLI default"}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </Field>
        </div>
        <div className="md:col-span-2">
          <Field
            id={`named-agent-persona-${agent.id}`}
            label="Persona"
            hint={`Injected as the first section of every prompt this agent receives. Leave empty to inject nothing. New agents start with "${DEFAULT_PERSONA_PROMPT}".`}
          >
            <Textarea
              id={`named-agent-persona-${agent.id}`}
              value={personaPrompt}
              onChange={(e) => setPersonaPrompt(e.target.value)}
              placeholder={DEFAULT_PERSONA_PROMPT}
              // The server rejects anything longer rather than truncating, so
              // the field has to stop the user at the same limit instead of
              // letting them paste text that can only fail to save.
              maxLength={PERSONA_PROMPT_MAX_CHARS}
              rows={2}
              className="text-sm"
              disabled={saving || deleting}
            />
          </Field>
        </div>
      </div>

      <CliOptionsFields
        idPrefix={`named-agent-${agent.id}`}
        provider={provider}
        options={options}
        onChange={setOptions}
        disabled={saving || deleting}
      />

      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}

      <div className="flex items-center justify-end gap-2">
        <Button
          variant="ghost"
          size="sm"
          className="h-8 text-destructive"
          onClick={handleDelete}
          disabled={deleting || saving}
          aria-label={`Delete ${agent.name}`}
        >
          {deleting ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Trash2 className="h-3.5 w-3.5" />
          )}
        </Button>
        <Button
          size="sm"
          className="h-8"
          onClick={handleSave}
          disabled={!dirty || !name.trim() || saving || deleting}
        >
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Save"}
        </Button>
      </div>
    </div>
  );
}

export function NamedAgentsTab() {
  const {
    data,
    loading,
    createNamedAgent,
    updateNamedAgent,
    deleteNamedAgent,
  } = useNamedAgents();
  const {
    providers: availability,
    loading: availabilityLoading,
  } = useProvidersAvailable();
  const [name, setName] = useState("");
  const [provider, setProvider] = useState<AgentProvider>("claude-code");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  async function handleCreate() {
    if (!name.trim()) return;
    setCreateError(null);
    setCreating(true);
    try {
      const result = await createNamedAgent({
        name: name.trim(),
        provider,
      });
      if (result.ok) {
        setName("");
        setProvider("claude-code");
      } else {
        setCreateError(
          result.error || "Could not create this agent. Try again."
        );
      }
    } catch {
      setCreateError(
        "Could not create this agent. Check the connection and try again."
      );
    } finally {
      setCreating(false);
    }
  }

  const availabilityHint = availabilityLoading
    ? `Checking whether ${PROVIDER_LABELS[provider]} is ready on this machine.`
    : availability[provider]
      ? `${PROVIDER_LABELS[provider]} is ready to use on this machine.`
      : `${PROVIDER_LABELS[provider]} was not detected. Install or sign in to the CLI before running this agent.`;

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col gap-3">
      <div className="px-1">
        <h2 className="text-sm font-medium">Agents</h2>
        <p className="text-xs text-muted-foreground">
          Create the agents you will assign to work. A name and a CLI are all
          it takes — everything runs with sensible defaults.
        </p>
      </div>

      <div className="rounded-lg border border-border p-3 space-y-3">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <Field
            id="new-agent-name"
            label="Name"
            hint="A short name you will recognise later."
          >
            <Input
              id="new-agent-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Fast builder"
              className="h-8 text-sm"
            />
          </Field>
          <Field id="new-agent-cli" label="CLI" hint={availabilityHint}>
            <CliSelect
              id="new-agent-cli"
              value={provider}
              onChange={setProvider}
              availability={availability}
              availabilityLoading={availabilityLoading}
              disabled={creating}
            />
          </Field>
        </div>
        {createError && (
          <p role="alert" className="text-xs text-destructive">
            {createError}
          </p>
        )}
        <div className="flex justify-end">
          <Button
            size="sm"
            className="h-8"
            onClick={handleCreate}
            disabled={!name.trim() || creating}
          >
            {creating ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <>
                <Plus className="h-3.5 w-3.5 mr-1" />
                Add agent
              </>
            )}
          </Button>
        </div>
      </div>

      <ScrollArea className="flex-1 min-h-0">
        <div className="space-y-2 pr-2">
          {data.length === 0 && (
            <p className="text-sm text-muted-foreground px-1 py-3">
              No agents yet — create your first one above.
            </p>
          )}
          {data.map((agent) => (
            <NamedAgentRow
              key={agent.id}
              agent={agent}
              agents={data}
              availability={availability}
              availabilityLoading={availabilityLoading}
              onUpdate={updateNamedAgent}
              onDelete={deleteNamedAgent}
            />
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}
