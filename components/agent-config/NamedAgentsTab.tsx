"use client";

import { useState } from "react";
import { useNamedAgents, type NamedAgent } from "@/hooks/useAgentConfig";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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

/**
 * Labeled field shell. Every control on this screen carries a visible label
 * and a one-line hint — no field may rely on its placeholder alone.
 */
function Field({
  id,
  label,
  hint,
  children,
}: {
  id: string;
  label: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <label
        htmlFor={id}
        className="block text-xs font-medium leading-none text-foreground"
      >
        {label}
      </label>
      {children}
      <p className="text-xs text-muted-foreground">{hint}</p>
    </div>
  );
}

function CliSelect({
  id,
  value,
  onChange,
  disabled,
}: {
  id: string;
  value: AgentProvider;
  onChange: (value: AgentProvider) => void;
  disabled?: boolean;
}) {
  return (
    <Select value={value} onValueChange={(v) => onChange(v as AgentProvider)} disabled={disabled}>
      <SelectTrigger id={id} className="h-8 text-sm">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {PROVIDER_OPTIONS.map((p) => (
          <SelectItem key={p} value={p}>
            {PROVIDER_LABELS[p]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function NamedAgentRow({
  agent,
  onUpdate,
  onDelete,
}: {
  agent: NamedAgent;
  onUpdate: (
    agentId: string,
    payload: { name?: string; provider?: AgentProvider; model?: string }
  ) => Promise<{ ok: boolean; error?: string }>;
  onDelete: (agentId: string) => Promise<boolean>;
}) {
  const [name, setName] = useState(agent.name);
  const [provider, setProvider] = useState<AgentProvider>(agent.provider);
  const [model, setModel] = useState(agent.model);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const dirty = name !== agent.name || provider !== agent.provider || model !== agent.model;

  async function handleSave() {
    if (!dirty || !name.trim()) return;
    setSaving(true);
    await onUpdate(agent.id, {
      name: name.trim(),
      provider,
      model: model.trim(),
    });
    setSaving(false);
  }

  async function handleDelete() {
    setDeleting(true);
    await onDelete(agent.id);
    setDeleting(false);
  }

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
          hint="The coding tool this agent runs on."
        >
          <CliSelect
            id={`named-agent-cli-${agent.id}`}
            value={provider}
            onChange={setProvider}
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
      </div>

      <div className="flex items-center justify-end gap-2">
        <Button
          variant="ghost"
          size="sm"
          className="h-8 text-destructive"
          onClick={handleDelete}
          disabled={deleting || saving}
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
  const { data, loading, createNamedAgent, updateNamedAgent, deleteNamedAgent } = useNamedAgents();
  const [name, setName] = useState("");
  const [provider, setProvider] = useState<AgentProvider>("claude-code");
  const [creating, setCreating] = useState(false);

  async function handleCreate() {
    if (!name.trim()) return;
    setCreating(true);
    const { ok } = await createNamedAgent({
      name: name.trim(),
      provider,
    });
    if (ok) {
      setName("");
      setProvider("claude-code");
    }
    setCreating(false);
  }

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
          <Field
            id="new-agent-cli"
            label="CLI"
            hint="The coding tool this agent runs on. You can change it later."
          >
            <CliSelect
              id="new-agent-cli"
              value={provider}
              onChange={setProvider}
              disabled={creating}
            />
          </Field>
        </div>
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
              onUpdate={updateNamedAgent}
              onDelete={deleteNamedAgent}
            />
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}
