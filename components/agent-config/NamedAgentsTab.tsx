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
import { type AgentProvider } from "@/lib/agent-config/constants";

const PROVIDERS: AgentProvider[] = ["claude-code", "codex", "gemini-cli"];

const PROVIDER_LABELS: Record<AgentProvider, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  "gemini-cli": "Gemini CLI",
};

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
    if (!dirty || !name.trim() || !model.trim()) return;
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
    <div className="rounded-lg border border-border p-3 space-y-2">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Agent name"
          className="h-8 text-sm"
        />
        <Select value={provider} onValueChange={(v) => setProvider(v as AgentProvider)}>
          <SelectTrigger className="h-8 text-sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PROVIDERS.map((p) => (
              <SelectItem key={p} value={p}>
                {PROVIDER_LABELS[p]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          value={model}
          onChange={(e) => setModel(e.target.value)}
          placeholder="Model (e.g. opus, gemini-2.0-pro)"
          className="h-8 text-sm"
        />
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
          disabled={!dirty || !name.trim() || !model.trim() || saving || deleting}
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
  const [model, setModel] = useState("");
  const [creating, setCreating] = useState(false);

  async function handleCreate() {
    if (!name.trim() || !model.trim()) return;
    setCreating(true);
    const { ok } = await createNamedAgent({
      name: name.trim(),
      provider,
      model: model.trim(),
    });
    if (ok) {
      setName("");
      setModel("");
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
      <div className="rounded-lg border border-border p-3 space-y-2">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Name"
            className="h-8 text-sm"
          />
          <Select value={provider} onValueChange={(v) => setProvider(v as AgentProvider)}>
            <SelectTrigger className="h-8 text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PROVIDERS.map((p) => (
                <SelectItem key={p} value={p}>
                  {PROVIDER_LABELS[p]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="Model"
            className="h-8 text-sm"
          />
        </div>
        <div className="flex justify-end">
          <Button
            size="sm"
            className="h-8"
            onClick={handleCreate}
            disabled={!name.trim() || !model.trim() || creating}
          >
            {creating ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <>
                <Plus className="h-3.5 w-3.5 mr-1" />
                Add Agent
              </>
            )}
          </Button>
        </div>
      </div>

      <ScrollArea className="flex-1">
        <div className="space-y-2 pr-2">
          {data.length === 0 && (
            <p className="text-sm text-muted-foreground px-1 py-3">
              No named agents yet.
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
